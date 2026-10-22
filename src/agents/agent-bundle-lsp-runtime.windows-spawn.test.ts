/** Tests LSP server spawning with Windows shim and sanitized env handling. */
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as hostEnvSecurity from "../infra/host-env-security.js";
import * as logger from "../logger.js";
import * as windowsSpawn from "../plugin-sdk/windows-spawn.js";
import type { WindowsSpawnProgram } from "../plugin-sdk/windows-spawn.js";
import * as ownedStdio from "../process/owned-stdio.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { spawnLspServerProcess } from "./agent-bundle-lsp-process.js";

const realSanitize = hostEnvSecurity.sanitizeHostExecEnv;
const resolveWindowsSpawnProgramMock = vi.fn<typeof windowsSpawn.resolveWindowsSpawnProgram>();
const sanitizeHostExecEnvMock = vi.fn<typeof hostEnvSecurity.sanitizeHostExecEnv>();
const spawnMock = vi.fn<typeof ownedStdio.createOwnedStdioProcess>();
const { spawnWithFallbackMock } = vi.hoisted(() => ({ spawnWithFallbackMock: vi.fn() }));

vi.mock("../process/spawn-utils.js", () => ({ spawnWithFallback: spawnWithFallbackMock }));

describe("spawnLspServerProcess Windows .cmd shim handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(hostEnvSecurity, "sanitizeHostExecEnv").mockImplementation(sanitizeHostExecEnvMock);
    spawnMock.mockRejectedValue(new Error("stop after spawn"));
    spawnWithFallbackMock.mockRejectedValue(new Error("captured Windows spawn"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const directProgram: WindowsSpawnProgram = {
    command: "typescript-language-server",
    leadingArgv: [],
    resolution: "direct",
    shell: false,
    windowsHide: true,
  };

  it.each<{
    name: string;
    configEnv?: Record<string, string>;
    sanitizedEnv: Record<string, string>;
    program: WindowsSpawnProgram;
    expectedArgv: string[];
  }>([
    {
      name: "calls sanitizeHostExecEnv with baseEnv/overrides, not a flat merged object",
      configEnv: { MY_TOKEN: "secret", TOOL_PATH: "/custom" },
      sanitizedEnv: { PATH: "/usr/bin", MY_TOKEN: "secret", TOOL_PATH: "/custom" },
      program: directProgram,
      expectedArgv: ["typescript-language-server", "--stdio"],
    },
    {
      name: "passes sanitized env to resolveWindowsSpawnProgram",
      sanitizedEnv: { PATH: "C:\\Windows;C:\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      program: directProgram,
      expectedArgv: ["typescript-language-server", "--stdio"],
    },
    {
      name: "passes materialized invocation to spawn with the sanitized env",
      sanitizedEnv: { PATH: "/usr/bin" },
      program: {
        command: "cmd.exe",
        leadingArgv: ["/c", "typescript-language-server.cmd"],
        resolution: "shell-fallback",
        shell: true,
        windowsHide: true,
      },
      expectedArgv: ["cmd.exe", "/c", "typescript-language-server.cmd", "--stdio"],
    },
  ])("$name", async ({ configEnv, sanitizedEnv, program, expectedArgv }) => {
    vi.spyOn(windowsSpawn, "resolveWindowsSpawnProgram").mockImplementation(
      resolveWindowsSpawnProgramMock,
    );
    vi.spyOn(ownedStdio, "createOwnedStdioProcess").mockImplementation(spawnMock);
    sanitizeHostExecEnvMock.mockReturnValue(sanitizedEnv);
    resolveWindowsSpawnProgramMock.mockReturnValue(program);
    const abortSignal = new AbortController().signal;

    await expect(
      spawnLspServerProcess(
        {
          command: "typescript-language-server",
          args: ["--stdio"],
          ...(configEnv ? { env: configEnv } : {}),
        },
        { abortSignal },
      ),
    ).rejects.toThrow("stop after spawn");

    const sanitizeParams = sanitizeHostExecEnvMock.mock.calls[0]?.[0];
    expect(sanitizeParams?.baseEnv).not.toBe(process.env);
    expect(sanitizeParams?.baseEnv).toMatchObject(getDefaultEnvironment());
    if (configEnv) {
      expect(sanitizeParams?.overrides).toStrictEqual(configEnv);
    }
    const resolveParams = resolveWindowsSpawnProgramMock.mock.calls[0]?.[0];
    expect(resolveParams?.env).toBe(sanitizedEnv);
    expect(resolveParams?.allowShellFallback).toBe(true);
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith({
      argv: expectedArgv,
      env: sanitizedEnv,
      exactEnv: true,
      cwd: undefined,
      abortSignal,
      ...(program.shell ? { windowsShell: true } : {}),
    });
  });

  it("preserves the shipped Windows shell fallback through the owned adapter", async () => {
    const sanitizedEnv = { PATH: "", PATHEXT: ".EXE;.CMD;.BAT" };
    sanitizeHostExecEnvMock.mockReturnValue(sanitizedEnv);

    await expect(
      withMockedWindowsPlatform(() =>
        spawnLspServerProcess({
          command: "C:\\Program Files\\language-server.cmd",
          args: ["--stdio", "two words", "%LSP_ARGUMENT%", "echo ready & exit /b"],
        }),
      ),
    ).rejects.toThrow("captured Windows spawn");

    expect(spawnWithFallbackMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        argv: [
          "C:\\Program Files\\language-server.cmd",
          "--stdio",
          "two words",
          "%LSP_ARGUMENT%",
          "echo ready & exit /b",
        ],
        options: expect.objectContaining({
          env: sanitizedEnv,
          shell: true,
          windowsHide: true,
        }),
      }),
    );
  });
});

async function capturedChildEnv(env?: Record<string, string>, serverName?: string) {
  sanitizeHostExecEnvMock.mockImplementation(realSanitize);
  vi.spyOn(ownedStdio, "createOwnedStdioProcess").mockImplementation(spawnMock);
  await expect(
    spawnLspServerProcess(
      {
        command: "typescript-language-server",
        args: ["--stdio"],
        ...(env ? { env } : {}),
      },
      serverName === undefined ? {} : { serverName },
    ),
  ).rejects.toThrow("stop after spawn");
  return spawnMock.mock.calls.at(-1)?.[0]?.env ?? {};
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
    const ours = messages.filter((message) => message.includes('"env-warn-probe"'));
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
