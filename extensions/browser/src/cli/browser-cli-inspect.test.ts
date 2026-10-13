// Browser tests cover browser cli inspect plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import type { SnapshotResult } from "../browser/client.js";
import * as browserCliSharedModule from "./browser-cli-shared.js";

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({ browser: {} })),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => configMocks.getRuntimeConfig(),
}));

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(
    async (
      _opts: unknown,
      params: { path?: string; query?: Record<string, unknown> },
    ): Promise<SnapshotResult> => {
      const format = params.query?.format === "aria" ? "aria" : "ai";
      if (format === "aria") {
        return {
          ok: true,
          format: "aria",
          targetId: "t1",
          url: "https://example.com",
          nodes: [],
        };
      }
      return {
        ok: true,
        format: "ai",
        targetId: "t1",
        url: "https://example.com",
        snapshot: "ok",
      };
    },
  ),
}));
let registerBrowserInspectCommands: typeof import("./browser-cli-inspect.js").registerBrowserInspectCommands;
let inspectSpies: Array<{ mockRestore(): void }> = [];

function restoreInspectSpies() {
  for (const spy of inspectSpies.toReversed()) {
    spy.mockRestore();
  }
  inspectSpies = [];
}

function installInspectSpies() {
  restoreInspectSpies();
  inspectSpies = [
    vi
      .spyOn(browserCliSharedModule, "callBrowserRequest")
      .mockImplementation(sharedMocks.callBrowserRequest),
    vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log),
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(runtime.writeJson),
    vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error),
    vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit),
  ];
}

describe("browser cli snapshot defaults", () => {
  const runBrowserInspect = async (args: string[], withJson = false) => {
    const program = new Command().enablePositionalOptions();
    const browser = program
      .command("browser")
      .option("--json", "JSON output", false)
      .option("--timeout <ms>", "Timeout in ms", "30000");
    registerBrowserInspectCommands(browser, (cmd) => cmd.parent?.opts() ?? {});
    await program.parseAsync(withJson ? ["browser", "--json", ...args] : ["browser", ...args], {
      from: "user",
    });

    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return params as { path?: string; query?: Record<string, unknown> } | undefined;
  };

  const runSnapshot = async (args: string[]) => await runBrowserInspect(["snapshot", ...args]);

  beforeAll(async () => {
    installInspectSpies();
    ({ registerBrowserInspectCommands } = await import("./browser-cli-inspect.js"));
  });

  beforeEach(() => {
    installInspectSpies();
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreInspectSpies();
    resetRuntimeCapture();
    configMocks.getRuntimeConfig.mockReturnValue({ browser: {} });
  });

  it.each(["plain", "file"] as const)(
    "preserves the returned ARIA ref in %s output",
    async (output) => {
      const ref = "ax42";
      const result: SnapshotResult = {
        ok: true,
        format: "aria",
        targetId: "t1",
        url: "https://example.com",
        nodes: [{ ref, role: "textbox", name: "Entry", value: "Ready", depth: 2 }],
      };
      sharedMocks.callBrowserRequest.mockResolvedValueOnce(result);
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
        expect(runtime.writeJson).not.toHaveBeenCalled();
      } else {
        expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
          `    - textbox "Entry" = "Ready" [ref=${ref}]`,
        );
        expect(runtime.writeJson).not.toHaveBeenCalled();
      }
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      command: "screenshot",
      requestPath: "/screenshot",
      args: ["--timeout", "60000", "screenshot", "--timeout", "90000"],
      timeout: "90000",
      ownerTimeoutMs: 90000,
    },
    {
      command: "snapshot",
      requestPath: "/snapshot",
      args: ["--timeout", "60000", "snapshot", "--timeout", "90000"],
      timeout: "90000",
      ownerTimeoutMs: 90000,
    },
  ])(
    "keeps the gateway and $command owner on the explicit $timeout ms timeout",
    async ({ command, requestPath, args, timeout, ownerTimeoutMs }) => {
      await runBrowserInspect(args, true);

      expect(sharedMocks.callBrowserRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout }),
        expect.objectContaining({ path: requestPath }),
      );
      const [, request] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
      const payload = request as {
        query?: { timeoutMs?: number };
        body?: { timeoutMs?: number };
      };
      const ownerPayload = command === "snapshot" ? payload.query : payload.body;
      expect(ownerPayload?.timeoutMs).toBe(ownerTimeoutMs);
    },
  );

  it("uses config snapshot defaults when mode is not provided", async () => {
    configMocks.getRuntimeConfig.mockReturnValue({
      browser: { snapshotDefaults: { mode: "efficient" } },
    });

    const params = await runSnapshot([]);
    expect(params?.path).toBe("/snapshot");
    expect(params?.query?.format).toBe("ai");
    expect(params?.query?.mode).toBe("efficient");
  });

  it("applies explicit efficient mode without config defaults", async () => {
    configMocks.getRuntimeConfig.mockReturnValue({ browser: {} });
    const params = await runSnapshot(["--efficient"]);
    expect(params?.query?.format).toBe("ai");
    expect(params?.query?.mode).toBe("efficient");
  });

  it("passes URL expansion for snapshots", async () => {
    const params = await runSnapshot(["--urls"]);
    expect(params?.query?.format).toBe("ai");
    expect(params?.query?.urls).toBe(true);
  });

  it("rejects non-integer snapshot numeric options before dispatch", async () => {
    await expect(runSnapshot(["--limit", "1e3"])).rejects.toThrow("__exit__:1");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "Invalid --limit: must be an integer >= 1",
    );

    resetRuntimeCapture();
    await expect(runSnapshot(["--depth", "-1"])).rejects.toThrow("__exit__:1");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "Invalid --depth: must be an integer >= 0",
    );

    expect(sharedMocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("accepts signed decimal snapshot numeric options", async () => {
    const params = await runSnapshot(["--limit", "+10", "--depth", "+0"]);
    expect(params?.query?.limit).toBe(10);
    expect(params?.query?.depth).toBe(0);
  });

  it("rejects unsupported snapshot mode before dispatch", async () => {
    await expect(runBrowserInspect(["snapshot", "--mode", "full"])).rejects.toThrow("__exit__:1");

    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("Invalid --mode: expected efficient");
    expect(sharedMocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("sends screenshot request with trimmed target id and jpeg type", async () => {
    const params = await runBrowserInspect(["screenshot", " tab-1 ", "--type", "jpeg"], true);
    expect(params?.path).toBe("/screenshot");
    const body = (params as { body?: Record<string, unknown> } | undefined)?.body;
    expect(body?.targetId).toBe("tab-1");
    expect(body?.type).toBe("jpeg");
    expect(body?.fullPage).toBe(false);
  });

  it("keeps an existing AI snapshot when publication fails", async () => {
    const tempDir = fsSync.mkdtempSync(path.join(tmpdir(), "openclaw-browser-snapshot-"));
    try {
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
    } finally {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
