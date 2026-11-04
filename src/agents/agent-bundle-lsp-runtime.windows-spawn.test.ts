import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as hostEnv from "../infra/host-env-security.js";
import * as logger from "../logger.js";
import * as windowsSpawn from "../plugin-sdk/windows-spawn.js";
import type { WindowsSpawnProgram } from "../plugin-sdk/windows-spawn.js";
import * as bundleLspConfig from "../plugins/bundle-lsp.js";
import * as ownedStdio from "../process/owned-stdio.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { createBundleLspToolRuntime } from "./agent-bundle-lsp-runtime.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

const realSanitize = hostEnv.sanitizeHostExecEnv;
const resolve = vi.fn<typeof windowsSpawn.resolveWindowsSpawnProgram>();
const sanitize = vi.fn<typeof hostEnv.sanitizeHostExecEnv>();
const spawn = vi.fn<typeof ownedStdio.createOwnedStdioProcess>();
const { spawnAndWait } = vi.hoisted(() => ({ spawnAndWait: vi.fn() }));
vi.mock("../process/spawn-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/spawn-utils.js")>()),
  spawnAndWait,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(hostEnv, "sanitizeHostExecEnv").mockImplementation(sanitize);
  spawn.mockRejectedValue(new Error("stop after spawn"));
  spawnAndWait.mockRejectedValue(new Error("captured Windows spawn"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function program(shell: boolean): WindowsSpawnProgram {
  return {
    command: shell ? "cmd.exe" : "typescript-language-server",
    leadingArgv: shell ? ["/c", "typescript-language-server.cmd"] : [],
    resolution: shell ? "shell-fallback" : "direct",
    shell,
    windowsHide: true,
  };
}

async function expectFailedRuntime(
  config: StdioMcpServerLaunchConfig,
  options: { abortSignal?: AbortSignal; serverName?: string } = {},
  failure = "stop after spawn",
) {
  vi.spyOn(bundleLspConfig, "loadEnabledBundleLspConfig").mockReturnValue({
    config: { lspServers: { [options.serverName ?? "test-server"]: config } },
    diagnostics: [],
  });
  const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
  const runtime = await createBundleLspToolRuntime({
    workspaceDir: "/tmp/lsp-workspace",
    abortSignal: options.abortSignal,
  });
  try {
    expect(runtime.sessions).toEqual([]);
    expect(runtime.tools).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(failure));
  } finally {
    await runtime.dispose();
  }
}
const overrides = { MY_TOKEN: "secret", TOOL_PATH: "/custom" };
it.each([
  { shell: false, env: overrides, argv: ["typescript-language-server", "--stdio"] },
  {
    shell: true,
    env: undefined,
    argv: ["cmd.exe", "/c", "typescript-language-server.cmd", "--stdio"],
  },
])(
  "sanitizes and forwards the materialized LSP invocation (shell=$shell)",
  async ({ shell, env, argv }) => {
    vi.spyOn(windowsSpawn, "resolveWindowsSpawnProgram").mockImplementation(resolve);
    vi.spyOn(ownedStdio, "createOwnedStdioProcess").mockImplementation(spawn);
    const sanitized = { PATH: "/usr/bin", ...env };
    sanitize.mockReturnValue(sanitized);
    resolve.mockReturnValue(program(shell));
    const abortSignal = new AbortController().signal;
    await expectFailedRuntime(
      { command: "typescript-language-server", args: ["--stdio"], ...(env ? { env } : {}) },
      { abortSignal },
    );

    const sanitation = sanitize.mock.calls[0]?.[0];
    expect(sanitation?.baseEnv).not.toBe(process.env);
    expect(sanitation?.baseEnv).toMatchObject(getDefaultEnvironment());
    if (env) {
      expect(sanitation?.overrides).toStrictEqual(env);
    }
    expect(resolve.mock.calls[0]?.[0]?.env).toBe(sanitized);
    expect(resolve.mock.calls[0]?.[0]?.allowShellFallback).toBe(true);
    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      argv,
      env: sanitized,
      exactEnv: true,
      cwd: undefined,
      abortSignal,
      ...(shell ? { windowsShell: true } : {}),
    });
  },
);

it("preserves Windows shell arguments through the real owned adapter", async () => {
  const env = { PATH: "", PATHEXT: ".EXE;.CMD;.BAT" };
  const command = "C:\\Program Files\\language-server.cmd";
  const args = ["--stdio", "two words", "%LSP_ARGUMENT%", "echo ready & exit /b"];
  sanitize.mockReturnValue(env);
  await withMockedWindowsPlatform(() =>
    expectFailedRuntime({ command, args }, {}, "captured Windows spawn"),
  );
  expect(spawnAndWait).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      argv: [command, ...args],
      options: expect.objectContaining({ env, shell: true, windowsHide: true }),
    }),
  );
});

async function capturedChildEnv(env?: Record<string, string>, serverName?: string) {
  sanitize.mockImplementation(realSanitize);
  vi.spyOn(ownedStdio, "createOwnedStdioProcess").mockImplementation(spawn);
  await expectFailedRuntime(
    {
      command: "typescript-language-server",
      args: ["--stdio"],
      ...(env ? { env } : {}),
    },
    serverName === undefined ? {} : { serverName },
  );
  return spawn.mock.calls.at(-1)?.[0]?.env ?? {};
}

describe.skipIf(process.platform === "win32")("bundle LSP child environment", () => {
  it("withholds Gateway secrets while keeping process essentials", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-token-canary");
    vi.stubEnv("OPENAI_API_KEY", "provider-key-canary");
    vi.stubEnv("OP_CONNECT_TOKEN", "secret-manager-canary");
    vi.stubEnv("PATH", "/usr/local/bin:/usr/bin");
    vi.stubEnv("HOME", "/home/lsp-user");
    vi.stubEnv("LC_ALL", "C.UTF-8");
    vi.stubEnv("RUSTUP_HOME", "/opt/rustup");

    const env = await capturedChildEnv();

    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("OP_CONNECT_TOKEN");
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env.HOME).toBe("/home/lsp-user");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.RUSTUP_HOME).toBe("/opt/rustup");
  });

  it("still applies the server's configured env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key-canary");

    const env = await capturedChildEnv({
      LSP_LOG_LEVEL: "verbose",
      OPENAI_API_KEY: "server-owned",
    });

    expect(env.LSP_LOG_LEVEL).toBe("verbose");
    expect(env.OPENAI_API_KEY).toBe("server-owned");
  });

  it("keeps Go module and install dirs; the host env policy still drops GOPATH and CARGO_HOME", async () => {
    vi.stubEnv("GOMODCACHE", "/srv/go/mod");
    vi.stubEnv("GOBIN", "/srv/go/bin");
    vi.stubEnv("GOPATH", "/srv/go");
    vi.stubEnv("CARGO_HOME", "/srv/cargo");

    const env = await capturedChildEnv();

    expect(env.GOMODCACHE).toBe("/srv/go/mod");
    expect(env.GOBIN).toBe("/srv/go/bin");
    expect(env).not.toHaveProperty("GOPATH");
    expect(env).not.toHaveProperty("CARGO_HOME");
  });

  it("withholds GRADLE_USER_HOME, which the host env policy alone lets a child inherit", async () => {
    const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    vi.stubEnv("GRADLE_USER_HOME", "/srv/gradle");

    expect(realSanitize({ baseEnv: { GRADLE_USER_HOME: "/srv/gradle" } }).GRADLE_USER_HOME).toBe(
      "/srv/gradle",
    );
    const env = await capturedChildEnv(undefined, "env-gradle-probe");

    expect(env).not.toHaveProperty("GRADLE_USER_HOME");
    const message = warn.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.includes('"env-gradle-probe"'));
    expect(message).toMatch(/GRADLE_USER_HOME[^:]*: refused by the host exec env policy/);
  });

  it("warns once per server with withheld names only, never values", async () => {
    const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    vi.stubEnv(
      "HTTPS_PROXY",
      ["http://proxy-user", "proxy-pass-canary@proxy.example:3128"].join(":"),
    );
    vi.stubEnv("VIRTUAL_ENV", "/srv/venv-canary");
    vi.stubEnv("ANDROID_HOME", "/srv/android-canary");
    vi.stubEnv("NPM_TOKEN", "npm-token-canary");
    vi.stubEnv("GOMODCACHE", "/srv/go/mod-canary");

    await capturedChildEnv(undefined, "env-warn-probe");
    await capturedChildEnv(undefined, "env-warn-probe");

    const messages = warn.mock.calls.map(([message]) => message);
    const ours = messages.filter(
      (message) =>
        message.includes('"env-warn-probe"') &&
        message.includes("starts without these Gateway environment variables."),
    );
    expect(ours).toHaveLength(1);
    const [message] = ours;
    expect(message).toMatch(/ANDROID_HOME[^:]*: add to the server's "env"/);
    expect(message).toMatch(
      /HTTPS_PROXY[^:]*VIRTUAL_ENV[^:]*: refused by the host exec env policy/,
    );
    expect(message).toContain("https://docs.openclaw.ai/plugins/bundles#lsp-server-environment");
    expect(message).not.toContain("NPM_TOKEN");
    expect(message).not.toContain("GOMODCACHE");
    expect(message).not.toMatch(/canary|proxy-pass|proxy\.example/);
  });

  it("does not list a withheld name the server's env supplies", async () => {
    const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    vi.stubEnv("ANDROID_HOME", "/srv/android");
    vi.stubEnv("DOTNET_ROOT", "/srv/dotnet");

    await capturedChildEnv({ ANDROID_HOME: "/bundle/android" }, "env-covered-probe");

    const message = warn.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.includes('"env-covered-probe"'));
    expect(message).toContain("DOTNET_ROOT");
    expect(message).not.toContain("ANDROID_HOME");
  });
});
