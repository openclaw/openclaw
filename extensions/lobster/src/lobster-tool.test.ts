import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../runtime-api.js";
import {
  createWindowsCmdShimFixture,
  restorePlatformPathEnv,
  setProcessPlatform,
  snapshotPlatformPathEnv,
} from "./test-helpers.js";
import { resolveWindowsLobsterSpawn } from "./windows-spawn.js";

const spawnState = vi.hoisted(() => ({
  queue: [] as Array<{ stdout: string; stderr?: string; exitCode?: number }>,
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnState.spawn(...args),
  };
});

let createLobsterTool: typeof import("./lobster-tool.js").createLobsterTool;

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: "lobster",
    name: "lobster",
    source: "test",
    registrationMode: "full",
    config: {},
    pluginConfig: {},
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { version: "test" } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerCliBackend() {},
    registerProvider() {},
    registerSpeechProvider() {},
    registerMediaUnderstandingProvider() {},
    registerImageGenerationProvider() {},
    registerWebSearchProvider() {},
    registerInteractiveHandler() {},
    onConversationBindingResolved() {},
    registerHook() {},
    registerHttpRoute() {},
    registerCommand() {},
    registerContextEngine() {},
    registerMemoryPromptSection() {},
    registerMemoryFlushPlan() {},
    registerMemoryRuntime() {},
    registerMemoryEmbeddingProvider() {},
    on() {},
    resolvePath: (p) => p,
    ...overrides,
  };
}

function fakeCtx(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return {
    config: {},
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    agentId: "main",
    sessionKey: "main",
    messageChannel: undefined,
    agentAccountId: undefined,
    sandboxed: false,
    ...overrides,
  };
}

async function expectUnwrappedShim(params: {
  scriptPath: string;
  shimPath: string;
  shimLine: string;
}) {
  await createWindowsCmdShimFixture(params);

  const target = resolveWindowsLobsterSpawn(params.shimPath, ["run", "noop"], process.env);
  expect(target.command).toBe(process.execPath);
  expect(target.argv).toEqual([params.scriptPath, "run", "noop"]);
  expect(target.windowsHide).toBe(true);
}

describe("lobster plugin tool", () => {
  let tempDir = "";
  const originalProcessState = snapshotPlatformPathEnv();

  beforeAll(async () => {
    ({ createLobsterTool } = await import("./lobster-tool.js"));

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-plugin-"));
  });

  afterEach(() => {
    restorePlatformPathEnv(originalProcessState);
  });

  afterAll(async () => {
    if (!tempDir) {
      return;
    }
    if (process.platform === "win32") {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    spawnState.queue.length = 0;
    spawnState.spawn.mockReset();
    spawnState.spawn.mockImplementation(() => {
      const next = spawnState.queue.shift() ?? { stdout: "" };
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: (signal?: string) => boolean;
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => true;

      setImmediate(() => {
        if (next.stderr) {
          stderr.end(next.stderr);
        } else {
          stderr.end();
        }
        stdout.end(next.stdout);
        child.emit("exit", next.exitCode ?? 0);
      });

      return child;
    });
  });

  const queueSuccessfulEnvelope = (hello = "world") => {
    spawnState.queue.push({
      stdout: JSON.stringify({
        ok: true,
        status: "ok",
        output: [{ hello }],
        requiresApproval: null,
      }),
    });
  };

  it("runs lobster and returns parsed envelope in details", async () => {
    spawnState.queue.push({
      stdout: JSON.stringify({
        ok: true,
        status: "ok",
        output: [{ hello: "world" }],
        requiresApproval: null,
      }),
    });

    const tool = createLobsterTool(fakeApi());
    const res = await tool.execute("call1", {
      action: "run",
      pipeline: "noop",
      timeoutMs: 1000,
    });

    expect(spawnState.spawn).toHaveBeenCalled();
    expect(res.details).toMatchObject({ ok: true, status: "ok" });
  });

  it("tolerates noisy stdout before the JSON envelope", async () => {
    const payload = { ok: true, status: "ok", output: [], requiresApproval: null };
    spawnState.queue.push({
      stdout: `noise before json\n${JSON.stringify(payload)}`,
    });

    const tool = createLobsterTool(fakeApi());
    const res = await tool.execute("call-noisy", {
      action: "run",
      pipeline: "noop",
      timeoutMs: 1000,
    });

    expect(res.details).toMatchObject({ ok: true, status: "ok" });
  });

  it("requires action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("requires pipeline for run action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-pipeline-missing", {
        action: "run",
      }),
    ).rejects.toThrow(/pipeline required/);
  });

  it("requires token and approve for resume action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-resume-token-missing", {
        action: "resume",
        approve: true,
      }),
    ).rejects.toThrow(/token required/);
    await expect(
      tool.execute("call-resume-approve-missing", {
        action: "resume",
        token: "resume-token",
      }),
    ).rejects.toThrow(/approve required/);
  });

  it("rejects unknown action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-action-unknown", {
        action: "explode",
      }),
    ).rejects.toThrow(/Unknown action/);
  });

  it("rejects absolute cwd", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call2c", {
        action: "run",
        pipeline: "noop",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/cwd must be a relative path/);
  });

  it("rejects cwd that escapes the gateway working directory", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call2d", {
        action: "run",
        pipeline: "noop",
        cwd: "../../etc",
      }),
    ).rejects.toThrow(/must stay within/);
  });

  it("rejects invalid JSON from lobster", async () => {
    spawnState.queue.push({ stdout: "nope" });

    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call3", {
        action: "run",
        pipeline: "noop",
      }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("runs Windows cmd shims through Node without enabling shell", async () => {
    setProcessPlatform("win32");
    const shimScriptPath = path.join(tempDir, "shim-dist", "lobster-cli.cjs");
    const shimPath = path.join(tempDir, "shim-bin", "lobster.cmd");
    await createWindowsCmdShimFixture({
      shimPath,
      scriptPath: shimScriptPath,
      shimLine: `"%dp0%\\..\\shim-dist\\lobster-cli.cjs" %*`,
    });
    process.env.PATHEXT = ".CMD;.EXE";
    process.env.PATH = `${path.dirname(shimPath)};${process.env.PATH ?? ""}`;
    queueSuccessfulEnvelope();

    const tool = createLobsterTool(fakeApi());
    await tool.execute("call-win-shim", {
      action: "run",
      pipeline: "noop",
    });

    const [command, argv, options] = spawnState.spawn.mock.calls[0] ?? [];
    expect(command).toBe(process.execPath);
    expect(argv).toEqual([shimScriptPath, "run", "--mode", "tool", "noop"]);
    expect(options).toMatchObject({ windowsHide: true });
    expect(options).not.toHaveProperty("shell");
  });

  it("does not retry a failed Windows spawn with shell fallback", async () => {
    setProcessPlatform("win32");
    spawnState.spawn.mockReset();
    spawnState.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: (signal?: string) => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      const err = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
      setImmediate(() => child.emit("error", err));
      return child;
    });

    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-win-no-retry", {
        action: "run",
        pipeline: "noop",
      }),
    ).rejects.toThrow(/spawn failed/);
    expect(spawnState.spawn).toHaveBeenCalledTimes(1);
  });

  it("can be gated off in sandboxed contexts", async () => {
    const api = fakeApi();
    const factoryTool = (ctx: OpenClawPluginToolContext) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api);
    };

    expect(factoryTool(fakeCtx({ sandboxed: true }))).toBeNull();
    expect(factoryTool(fakeCtx({ sandboxed: false }))?.name).toBe("lobster");
  });
});

describe("resolveWindowsLobsterSpawn", () => {
  let tempDir = "";
  const originalProcessState = snapshotPlatformPathEnv();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-win-spawn-"));
    setProcessPlatform("win32");
  });

  afterEach(async () => {
    restorePlatformPathEnv(originalProcessState);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("unwraps cmd shim with %dp0% token", async () => {
    const scriptPath = path.join(tempDir, "shim-dist", "lobster-cli.cjs");
    const shimPath = path.join(tempDir, "shim", "lobster.cmd");
    await expectUnwrappedShim({
      shimPath,
      scriptPath,
      shimLine: `"%dp0%\\..\\shim-dist\\lobster-cli.cjs" %*`,
    });
  });

  it("unwraps cmd shim with %~dp0% token", async () => {
    const scriptPath = path.join(tempDir, "shim-dist", "lobster-cli.cjs");
    const shimPath = path.join(tempDir, "shim", "lobster.cmd");
    await expectUnwrappedShim({
      shimPath,
      scriptPath,
      shimLine: `"%~dp0%\\..\\shim-dist\\lobster-cli.cjs" %*`,
    });
  });

  it("ignores node.exe shim entries and picks lobster script", async () => {
    const shimDir = path.join(tempDir, "shim-with-node");
    const scriptPath = path.join(tempDir, "shim-dist-node", "lobster-cli.cjs");
    const shimPath = path.join(shimDir, "lobster.cmd");
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.mkdir(shimDir, { recursive: true });
    await fs.writeFile(path.join(shimDir, "node.exe"), "", "utf8");
    await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");
    await fs.writeFile(
      shimPath,
      `@echo off\r\n"%~dp0%\\node.exe" "%~dp0%\\..\\shim-dist-node\\lobster-cli.cjs" %*\r\n`,
      "utf8",
    );

    const target = resolveWindowsLobsterSpawn(shimPath, ["run", "noop"], process.env);
    expect(target.command).toBe(process.execPath);
    expect(target.argv).toEqual([scriptPath, "run", "noop"]);
    expect(target.windowsHide).toBe(true);
  });

  it("resolves lobster.cmd from PATH and unwraps npm layout shim", async () => {
    const binDir = path.join(tempDir, "node_modules", ".bin");
    const packageDir = path.join(tempDir, "node_modules", "lobster");
    const scriptPath = path.join(packageDir, "dist", "cli.js");
    const shimPath = path.join(binDir, "lobster.cmd");
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(shimPath, "@echo off\r\n", "utf8");
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "lobster", version: "0.0.0", bin: { lobster: "dist/cli.js" } }),
      "utf8",
    );
    await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");

    const env = {
      ...process.env,
      PATH: `${binDir};${process.env.PATH ?? ""}`,
      PATHEXT: ".CMD;.EXE",
    };
    const target = resolveWindowsLobsterSpawn("lobster", ["run", "noop"], env);
    expect(target.command).toBe(process.execPath);
    expect(target.argv).toEqual([scriptPath, "run", "noop"]);
    expect(target.windowsHide).toBe(true);
  });

  it("fails fast when wrapper cannot be resolved without shell execution", async () => {
    const badShimPath = path.join(tempDir, "bad-shim", "lobster.cmd");
    await fs.mkdir(path.dirname(badShimPath), { recursive: true });
    await fs.writeFile(badShimPath, "@echo off\r\nREM no entrypoint\r\n", "utf8");

    expect(() => resolveWindowsLobsterSpawn(badShimPath, ["run", "noop"], process.env)).toThrow(
      /without shell execution/,
    );
  });
});
