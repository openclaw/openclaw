import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotResult } from "../browser/client.js";
import { createBrowserCliCapture } from "./browser-cli-extension.test-support.js";
import * as browserCliSharedModule from "./browser-cli-shared.js";

const { runtime, installRuntime, resetRuntimeCapture } = createBrowserCliCapture();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({ browser: {} })),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => configMocks.getRuntimeConfig(),
}));

const request = vi.fn(
  async (
    _opts: unknown,
    params: Parameters<typeof browserCliSharedModule.callBrowserRequest>[1],
  ): Promise<SnapshotResult> => {
    const base = { ok: true as const, targetId: "t1", url: "https://example.com" };
    return params.query?.format === "aria"
      ? { ...base, format: "aria", nodes: [] }
      : { ...base, format: "ai", snapshot: "ok" };
  },
);
let registerBrowserInspectCommands: typeof import("./browser-cli-inspect.js").registerBrowserInspectCommands;

function installInspectSpies() {
  vi.restoreAllMocks();
  vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(request);
  installRuntime();
}

describe("browser cli snapshot defaults", () => {
  const runBrowserInspect = async (args: string[], withJson = false) => {
    const program = new Command().enablePositionalOptions();
    const browser = program
      .command("browser")
      .option("--json", "JSON output", false)
      .option("--browser-profile <name>", "Browser profile")
      .option("--timeout <ms>", "Timeout in ms", "30000");
    registerBrowserInspectCommands(browser, (cmd) => cmd.parent?.opts() ?? {});
    await program.parseAsync(withJson ? ["browser", "--json", ...args] : ["browser", ...args], {
      from: "user",
    });

    return request.mock.calls.at(-1)?.[1];
  };

  const runSnapshot = (args: string[]) => runBrowserInspect(["snapshot", ...args]);

  beforeAll(async () => {
    installInspectSpies();
    ({ registerBrowserInspectCommands } = await import("./browser-cli-inspect.js"));
  });

  beforeEach(installInspectSpies);

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    resetRuntimeCapture();
    configMocks.getRuntimeConfig.mockReturnValue({ browser: {} });
  });

  it.each(["plain", "file"] as const)("preserves ARIA refs in %s output", async (output) => {
    const result: SnapshotResult = {
      ok: true,
      format: "aria",
      targetId: "t1",
      url: "https://example.com",
      nodes: [{ ref: "ax42", role: "textbox", name: "Entry", value: "Ready", depth: 2 }],
    };
    request.mockResolvedValueOnce(result);
    const outputPath =
      output === "file"
        ? path.join(tempDirs.make("openclaw-aria-output-"), "snapshot.json")
        : undefined;
    await runBrowserInspect([
      "snapshot",
      "--format",
      "aria",
      ...(outputPath ? ["--out", outputPath] : []),
    ]);

    if (outputPath) {
      expect(JSON.parse(await fs.readFile(outputPath, "utf8"))).toEqual(result);
      expect(runtime.log).toHaveBeenCalledExactlyOnceWith(outputPath);
    } else {
      expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
        '    - textbox "Entry" = "Ready" [ref=ax42]',
      );
    }
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each(["screenshot", "snapshot"])(
    "passes the explicit timeout to gateway and %s",
    async (command) => {
      const params = await runBrowserInspect(
        [
          "--timeout",
          "60000",
          command,
          "--timeout",
          "90000",
          ...(command === "screenshot" ? [" tab-1 ", "--type", "jpeg"] : []),
        ],
        true,
      );

      expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout: "90000" }),
        expect.objectContaining({ path: `/${command}` }),
      );
      expect(command === "snapshot" ? params?.query : params?.body).toMatchObject({
        timeoutMs: 90000,
        ...(command === "screenshot" ? { targetId: "tab-1", type: "jpeg", fullPage: false } : {}),
      });
    },
  );

  it.each([
    [[], { snapshotDefaults: { mode: "efficient" } }, { format: "ai", mode: "efficient" }],
    [["--efficient"], {}, { format: "ai", mode: "efficient" }],
    [["--urls"], {}, { format: "ai", urls: true }],
    [["--limit", "+10", "--depth", "+0"], {}, { limit: 10, depth: 0 }],
  ] as const)("builds snapshot query for %j", async (args, browser, query) => {
    configMocks.getRuntimeConfig.mockReturnValue({ browser });
    expect(await runSnapshot([...args])).toMatchObject({ path: "/snapshot", query });
  });

  it.each([false, true])("leaves invalid options to the CLI (json: %s)", async (withJson) => {
    for (const [args, message] of [
      [["snapshot", "--limit", "1e3"], "Invalid --limit: must be an integer >= 1"],
      [["snapshot", "--depth", "-1"], "Invalid --depth: must be an integer >= 0"],
      [["snapshot", "--format", "full"], "Invalid --format: expected aria or ai"],
      [["snapshot", "--mode", "full"], "Invalid --mode: expected efficient"],
      [["screenshot", "--type", "gif"], "Invalid --type: expected png or jpeg"],
    ] as const) {
      await expect(runBrowserInspect([...args], withJson)).rejects.toThrow(message);
    }
    expect(request).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps an existing AI snapshot when publication fails", async () => {
    const tempDir = tempDirs.make("openclaw-browser-snapshot-");
    const outputPath = path.join(tempDir, "snapshot.txt");
    fsSync.writeFileSync(outputPath, "previous snapshot\n");
    const priorBytes = fsSync.readFileSync(outputPath);

    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
      expect(typeof file).toBe("string");
      fsSync.writeFileSync(file as string, "partial replacement");
      throw new Error("injected snapshot write failure");
    });
    try {
      await expect(runSnapshot(["--out", outputPath])).rejects.toThrow("__exit__:1");
    } finally {
      writeSpy.mockRestore();
    }

    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("injected snapshot write failure");
    expect(fsSync.readFileSync(outputPath)).toEqual(priorBytes);
    expect(fsSync.readdirSync(tempDir)).toEqual(["snapshot.txt"]);
  });

  describe("dialog-blocked snapshots", () => {
    const browserState = {
      dialogs: {
        pending: [
          { id: "d1", type: "beforeunload", message: "Leave site?", openedAt: "2026-10-20" },
        ],
        recent: [],
      },
    };
    const blocked = (format: "ai" | "aria"): SnapshotResult => {
      const base = {
        ok: true as const,
        targetId: "t1",
        url: "https://example.com",
        blockedByDialog: true,
        browserState,
      };
      return format === "aria"
        ? { ...base, format, nodes: [] }
        : { ...base, format, snapshot: "", refs: {} };
    };
    // runtime.error also receives the exit exception, so search every call.
    const allErrorText = () => runtime.error.mock.calls.map((call) => String(call[0])).join("\n");

    it.each(["ai", "aria"] as const)(
      "fails instead of printing an empty %s snapshot",
      async (format) => {
        request.mockResolvedValueOnce(blocked(format));

        await expect(runSnapshot(["--format", format])).rejects.toThrow("__exit__:1");

        expect(allErrorText()).toContain("Snapshot not captured: a pending dialog blocks tab t1");
        expect(allErrorText()).toContain('Dialog d1 (beforeunload): "Leave site?"');
        expect(allErrorText()).toContain(
          "openclaw browser dialog --dismiss --dialog-id d1 --target-id t1",
        );
        expect(runtime.log).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])(
      "does not write over an existing --out file (json: %s)",
      async (withJson) => {
        const outputPath = path.join(tempDirs.make("openclaw-dialog-out-"), "snapshot.txt");
        fsSync.writeFileSync(outputPath, "previous snapshot\n");
        const priorBytes = fsSync.readFileSync(outputPath);
        request.mockResolvedValueOnce(blocked("ai"));

        await expect(
          runBrowserInspect(["snapshot", "--out", outputPath], withJson),
        ).rejects.toThrow("__exit__:1");

        expect(fsSync.readFileSync(outputPath)).toEqual(priorBytes);
        expect(allErrorText()).toContain("Snapshot not captured");
        expect(runtime.writeJson).not.toHaveBeenCalled();
      },
    );

    it("keeps a non-default browser profile in the dismiss command", async () => {
      request.mockResolvedValueOnce(blocked("ai"));

      await expect(runBrowserInspect(["--browser-profile", "work", "snapshot"])).rejects.toThrow(
        "__exit__:1",
      );

      expect(allErrorText()).toContain(
        "openclaw browser dialog --browser-profile=work --dismiss --dialog-id d1 --target-id t1",
      );
    });

    it("keeps returning the dialog details in --json mode", async () => {
      request.mockResolvedValueOnce(blocked("ai"));

      await runBrowserInspect(["snapshot"], true);

      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ blockedByDialog: true, browserState }),
      );
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    });

    it("still prints a genuinely blank page and exits 0", async () => {
      request.mockResolvedValueOnce({
        ok: true,
        format: "ai",
        targetId: "t1",
        url: "about:blank",
        snapshot: "",
      });

      await runSnapshot([]);

      expect(runtime.log).toHaveBeenCalledExactlyOnceWith("");
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });
});
