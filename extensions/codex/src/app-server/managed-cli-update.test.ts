import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  installFromValidatedNpmSpecArchive,
  resolveNpmSpecMetadata,
} from "openclaw/plugin-sdk/package-install-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { commandProcessCleanup } from "openclaw/plugin-sdk/process-runtime";
import { closeOpenClawStateDatabaseByPathAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { updateCodexManagedCli } from "./managed-cli-update.js";
import {
  readCodexManagedRuntimeSelection,
  type CodexManagedRuntimeSelection,
} from "./managed-runtime-installation.js";

// Only the registry/acquisition boundary is synthetic. Generation files, ownership
// checks, process-scope settlement and SQLite compare-and-apply remain real.
vi.mock("openclaw/plugin-sdk/package-install-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/package-install-runtime")>()),
  resolveNpmSpecMetadata: vi.fn(),
  installFromValidatedNpmSpecArchive: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
});

async function withCli(
  run: (fixture: {
    root: string;
    native: (command: string) => string;
    selected: () => ReturnType<typeof readCodexManagedRuntimeSelection>;
    update: (
      validate?: (command: string) => Promise<void>,
    ) => ReturnType<typeof updateCodexManagedCli>;
    release: (version: string) => void;
  }) => Promise<void>,
) {
  await withTempDir("codex-cli-update-", async (root) => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const store = createPluginStateKeyedStoreForTests<CodexManagedRuntimeSelection>("codex", {
      namespace: "managed-runtime-selection",
      retention: "retained",
      env,
    });
    const native = (command: string) => path.join(path.dirname(command), "..", "vendor", "native");
    const release = (version: string) => {
      vi.mocked(resolveNpmSpecMetadata).mockResolvedValue({
        ok: true,
        metadata: {
          name: "@openai/codex",
          version,
          integrity: "sha512-synthetic",
        },
      });
    };
    release("99.1.0");
    vi.mocked(installFromValidatedNpmSpecArchive)
      .mockReset()
      .mockImplementation(async (params) => {
        const target = path.join(params.workspaceDir!, "..", "cli");
        await fs.mkdir(path.join(target, "bin"), { recursive: true, mode: 0o700 });
        await fs.mkdir(path.join(target, "vendor"), { mode: 0o700 });
        const command = path.join(target, "bin", "codex.js");
        await fs.writeFile(command, "// private synthetic launcher", { mode: 0o700 });
        await fs.writeFile(native(command), params.spec, { mode: 0o700 });
        // npm platform dependencies may contain in-generation links; their POSIX
        // link mode is not a write permission on the linked executable.
        if (process.platform !== "win32") {
          await fs.symlink("native", path.join(target, "vendor", "current"));
        }
        return {
          ok: true,
          npmResolution: { name: "@openai/codex", resolvedAt: new Date().toISOString() },
        };
      });
    try {
      await run({
        root,
        native,
        release,
        selected: () => readCodexManagedRuntimeSelection(root, { store }),
        update: (validateCandidate = async () => {}) =>
          updateCodexManagedCli({
            root,
            env,
            store,
            signal: new AbortController().signal,
            assertCurrent: () => {},
            validateCandidate,
          }),
      });
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(
        path.join(root, "state", "state", "openclaw.sqlite"),
      );
    }
  });
}

it("selects successive stable releases only after qualification and retains the old executable", async () => {
  await withCli(async (f) => {
    const first = await f.update(async (command) => {
      expect(await f.selected()).toBeUndefined();
      expect(await fs.readFile(f.native(command), "utf8")).toBe("@openai/codex@99.1.0");
    });
    expect(first).toMatchObject({ status: "updated", version: "99.1.0" });
    f.release("99.2.0");
    const next = await f.update(async () => {
      expect((await f.selected())?.selection.runtimeVersion).toBe("99.1.0");
    });
    expect(next).toMatchObject({ status: "updated", version: "99.2.0" });
    expect((await f.selected())?.selection.runtimeVersion).toBe("99.2.0");
    expect(await fs.readFile(f.native(first.command!), "utf8")).toBe("@openai/codex@99.1.0");
    expect(await fs.readdir(path.dirname(path.dirname(next.command!)))).toEqual(["bin", "vendor"]);
    await expect(
      fs.stat(path.join(path.dirname(path.dirname(path.dirname(next.command!))), "acquisition")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    f.release("99.1.0");
    const probe = vi.fn();
    expect(await f.update(probe)).toEqual({ status: "current", version: "99.2.0" });
    expect(probe).not.toHaveBeenCalled();
    expect(installFromValidatedNpmSpecArchive).toHaveBeenCalledTimes(2);
  });
});

it.each(["protocol", "native bytes", "escaping dependency"])(
  "rejects %s failure before selection and removes only the rejected generation",
  async (failure) => {
    await withCli(async (f) => {
      const first = await f.update();
      f.release("99.2.0");
      let rejected = "";
      await expect(
        f.update(async (command) => {
          rejected = command;
          if (failure === "protocol") {
            throw new Error("model/list incompatible");
          }
          if (failure === "native bytes") {
            await fs.writeFile(f.native(command), "replaced after probe");
          } else {
            await fs.unlink(f.native(command));
            await fs.symlink(f.native(first.command!), f.native(command));
          }
        }),
      ).rejects.toThrow(failure === "protocol" ? "model/list incompatible" : /changed|escapes/);
      expect((await f.selected())?.selection.runtimeVersion).toBe("99.1.0");
      expect(await fs.readFile(f.native(first.command!), "utf8")).toBe("@openai/codex@99.1.0");
      await expect(fs.stat(rejected)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

it("keeps an unsettled acquisition and never probes or publishes it", async () => {
  await withCli(async (f) => {
    const first = await f.update();
    f.release("99.2.0");
    let acquisition = "";
    vi.mocked(installFromValidatedNpmSpecArchive).mockImplementationOnce(async (params) => {
      acquisition = params.workspaceDir!;
      await fs.writeFile(path.join(acquisition, "partial"), "owned by unsettled writer");
      throw new commandProcessCleanup.Error();
    });
    const probe = vi.fn();
    await expect(f.update(probe)).rejects.toMatchObject({
      code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
    });
    expect(probe).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(acquisition, "partial"), "utf8")).toBe(
      "owned by unsettled writer",
    );
    expect((await f.selected())?.selection.runtimeVersion).toBe("99.1.0");
    expect(await fs.readFile(first.command!, "utf8")).toContain("synthetic launcher");
    // No child was spawned; the fixture can now clean its private retained stage.
  });
});

it("does not overwrite a concurrent winner admitted while its candidate was qualifying", async () => {
  await withCli(async (f) => {
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const loser = f.update(async () => {
      entered.resolve();
      await resume.promise;
    });
    // Observe both settlements even if an assertion fails, before deleting the private root.
    const settled = loser.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await entered.promise;
      f.release("99.2.0");
      await f.update();
    } finally {
      resume.resolve();
      await settled;
    }
    expect(await settled).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("selection changed") }),
    });
    expect((await f.selected())?.selection.runtimeVersion).toBe("99.2.0");
  });
});
