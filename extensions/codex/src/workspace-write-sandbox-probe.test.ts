import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/health";
import { runUtf8CommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveManagedCodexAppServerStartOptions } from "./app-server/managed-binary.js";
import { probeCodexWorkspaceWriteSandbox } from "./workspace-write-sandbox-probe.js";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runUtf8CommandWithTimeout: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/temp-path", () => ({ resolvePreferredOpenClawTmpDir: vi.fn() }));
vi.mock("./app-server/managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/managed-binary.js")>()),
  resolveManagedCodexAppServerStartOptions: vi.fn(),
  isManagedCodexDesktopCommand: (command: string) => command.startsWith("/Applications/"),
}));

const runner = vi.mocked(runUtf8CommandWithTimeout);
const resolveStart = vi.mocked(resolveManagedCodexAppServerStartOptions);
const args = [
  "sandbox",
  "-c",
  'sandbox_mode="workspace-write"',
  "-c",
  "sandbox_workspace_write.network_access=false",
  "--",
  "true",
];
const success: SpawnResult = {
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};

function config(appServer: Record<string, unknown> = {}, codex = true): OpenClawConfig {
  const model = codex ? "openai/gpt-5.6-sol" : "anthropic/claude-opus-4-7";
  return {
    agents: {
      defaults: {
        model: { primary: model },
        models: { [model]: { agentRuntime: { id: codex ? "codex" : "openclaw" } } },
      },
    },
    ...(codex ? { plugins: { entries: { codex: { enabled: true, config: { appServer } } } } } : {}),
  };
}

describe("Codex workspace-write sandbox probe", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  beforeEach(() => {
    vi.clearAllMocks();
    root = tempDirs.make("openclaw-codex-probe-test-");
    vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(root);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    resolveStart.mockImplementation(async (start) =>
      start.commandSource === "managed"
        ? { ...start, command: "/managed/codex", commandSource: "resolved-managed" }
        : start,
    );
    runner.mockResolvedValue(success);
  });
  afterEach(() => vi.restoreAllMocks());

  async function probe(cfg = config(), env: NodeJS.ProcessEnv = {}) {
    const result = await probeCodexWorkspaceWriteSandbox({ cfg, env, pluginRoot: "/plugin" });
    expect(await fs.readdir(root)).toEqual([]);
    return result;
  }

  it.each<[string | Partial<SpawnResult>, string]>([
    ["loopback: Failed RTM_NEWADDR: Operation not permitted", ""],
    ["loopback: Failed RTM_NEWLINK: Operation not permitted", ""],
    ["setting up uid map: Permission denied", ""],
    ["No permissions to create a new namespace", ""],
    [
      { code: 1, stderr: "wrapper: bwrap: loopback: Failed RTM_NEWADDR: denied" },
      "without a recognized bwrap denial",
    ],
    [
      { termination: "timeout", stderr: "bwrap: loopback: Failed RTM_NEWADDR: denied" },
      "timed out after 20000 ms",
    ],
    [{ code: null, termination: "signal", signal: "SIGKILL" }, "SIGKILL"],
    [{ outputLimitExceeded: true }, "capture limit"],
  ])("classifies sandbox outcome %j", async (result, reason) => {
    const denial = typeof result === "string" ? `bwrap: ${result}` : undefined;
    runner.mockResolvedValue({
      ...success,
      ...(typeof result === "string" ? { code: 1, stderr: `other output\n ${denial} \n` } : result),
    });
    expect(await probe()).toEqual({
      command: `/managed/codex sandbox -c 'sandbox_mode="workspace-write"' -c sandbox_workspace_write.network_access=false -- true`,
      ...(denial
        ? { status: "denied", denial }
        : {
            status: "inconclusive",
            reason: expect.stringContaining(reason),
          }),
    });
  });

  it("reports spawn errors without throwing and removes its temporary state", async () => {
    runner.mockRejectedValueOnce(new Error("spawn ENOENT"));
    expect(await probe()).toMatchObject({ status: "inconclusive", reason: "spawn ENOENT" });
  });

  it("uses the stdio launcher and environment with a disposable home and writable sibling cwd", async () => {
    resolveStart.mockImplementationOnce(async (start) => ({
      ...start,
      command: "/managed path/codex/bin/codex.js",
      commandSource: "resolved-managed",
      env: { KEEP: "override", CODEX_HOME: "/real/home" },
      clearEnv: ["DROP"],
    }));
    runner.mockImplementationOnce(async (argv, options) => {
      expect(argv).toEqual([process.execPath, "/managed path/codex/bin/codex.js", ...args]);
      expect(options).toMatchObject({
        input: "",
        timeoutMs: 20_000,
        maxOutputBytes: 64 * 1024,
        outputCapture: "head",
        terminateOnOutputLimit: true,
        killProcessTree: true,
        killSignal: "SIGKILL",
        killGraceMs: 0,
        baseEnv: { KEEP: "override", BASE: "kept", CODEX_HOME: expect.any(String) },
      });
      if (typeof options === "number" || !options.cwd || !options.baseEnv?.CODEX_HOME) {
        throw new Error("Probe did not supply temporary directories");
      }
      expect(options.baseEnv).not.toHaveProperty("DROP");
      expect(options.baseEnv).not.toHaveProperty("LD_PRELOAD");
      const home = options.baseEnv.CODEX_HOME;
      expect(home).not.toBe("/real/home");
      expect(path.dirname(home)).toBe(path.dirname(options.cwd));
      expect(home).not.toBe(options.cwd);
      expect(path.dirname(home).startsWith(root)).toBe(true);
      expect((await fs.stat(home)).isDirectory()).toBe(true);
      await fs.writeFile(path.join(options.cwd, "writable"), "ok");
      return success;
    });
    expect(
      await probe(config(), { KEEP: "base", BASE: "kept", DROP: "removed", LD_PRELOAD: "removed" }),
    ).toEqual({
      status: "ok",
      command: `${process.execPath} '/managed path/codex/bin/codex.js' sandbox -c 'sandbox_mode="workspace-write"' -c sandbox_workspace_write.network_access=false -- true`,
    });
  });

  it.each([
    {
      command: "node",
      launchArgs: ["./codex-wrapper.js", "app-server"],
      expected: ["node", "/runtime/codex-wrapper.js"],
    },
    { command: "./bin/codex", launchArgs: ["app-server"], expected: ["/runtime/bin/codex"] },
  ])(
    "preserves the custom launcher $command outside the disposable cwd",
    async ({ command, launchArgs, expected }) => {
      resolveStart.mockImplementationOnce(async (start) => ({ ...start, cwd: "/runtime" }));
      expect(await probe(config({ command, args: launchArgs }))).toMatchObject({ status: "ok" });
      expect(runner).toHaveBeenCalledWith([...expected, ...args], expect.any(Object));
    },
  );

  it.each([
    [
      "proxy",
      config({
        command: "/custom/codex",
        args: ["app-server", "proxy", "--sock", "/run/codex.sock"],
      }),
    ],
    ["websocket", config({ transport: "websocket", url: "ws://localhost:4500" })],
    ["non-linux", config()],
    ["no-runtime", config({}, false)],
    ["desktop", config()],
  ] satisfies [string, OpenClawConfig][])("skips %s", async (kind, cfg) => {
    if (kind === "non-linux") {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    } else if (kind === "desktop") {
      resolveStart.mockImplementation(async (start) => ({
        ...start,
        command: "/Applications/ChatGPT.app/Contents/Resources/codex",
        commandSource: "resolved-managed",
      }));
    }
    expect(await probe(cfg)).toMatchObject({ status: "skipped", reason: expect.any(String) });
    expect(runner).not.toHaveBeenCalled();
  });

  it("reports an unresolvable configured runtime as unverified without throwing", async () => {
    resolveStart.mockRejectedValueOnce(new Error("managed launcher missing"));
    expect(await probe()).toEqual({ status: "inconclusive", reason: "managed launcher missing" });
    expect(runner).not.toHaveBeenCalled();
  });
});
