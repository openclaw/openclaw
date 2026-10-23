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

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(
    async (
      _opts: unknown,
      params: Parameters<typeof browserCliSharedModule.callBrowserRequest>[1],
    ): Promise<SnapshotResult> => {
      const base = { ok: true as const, targetId: "t1", url: "https://example.com" };
      return params.query?.format === "aria"
        ? { ...base, format: "aria", nodes: [] }
        : { ...base, format: "ai", snapshot: "ok" };
    },
  ),
}));
let registerBrowserInspectCommands: typeof import("./browser-cli-inspect.js").registerBrowserInspectCommands;

function installInspectSpies() {
  vi.restoreAllMocks();
  vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(
    sharedMocks.callBrowserRequest,
  );
  installRuntime();
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

    return sharedMocks.callBrowserRequest.mock.calls.at(-1)?.[1];
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
      } else {
        expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
          `    - textbox "Entry" = "Ready" [ref=${ref}]`,
        );
      }
      expect(runtime.writeJson).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each(["screenshot", "snapshot"])(
    "keeps the gateway and %s owner on the explicit 90000 ms timeout",
    async (command) => {
      const request = await runBrowserInspect(
        ["--timeout", "60000", command, "--timeout", "90000"],
        true,
      );

      expect(sharedMocks.callBrowserRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout: "90000" }),
        expect.objectContaining({ path: `/${command}` }),
      );
      expect(command === "snapshot" ? request?.query : request?.body).toMatchObject({
        timeoutMs: 90000,
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

  it.each([false, true])(
    "lets the CLI render invalid inspect options (json: %s)",
    async (withJson) => {
      for (const [args, message] of [
        [["snapshot", "--limit", "1e3"], "Invalid --limit: must be an integer >= 1"],
        [["snapshot", "--depth", "-1"], "Invalid --depth: must be an integer >= 0"],
        [["snapshot", "--format", "full"], "Invalid --format: expected aria or ai"],
        [["snapshot", "--mode", "full"], "Invalid --mode: expected efficient"],
        [["screenshot", "--type", "gif"], "Invalid --type: expected png or jpeg"],
      ] as const) {
        await expect(runBrowserInspect([...args], withJson)).rejects.toThrow(message);
      }
      expect(sharedMocks.callBrowserRequest).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("sends screenshot request with trimmed target id and jpeg type", async () => {
    const params = await runBrowserInspect(["screenshot", " tab-1 ", "--type", "jpeg"], true);
    expect(params).toMatchObject({
      path: "/screenshot",
      body: { targetId: "tab-1", type: "jpeg", fullPage: false },
    });
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
});
