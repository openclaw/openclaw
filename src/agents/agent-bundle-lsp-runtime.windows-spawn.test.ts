import { expect, it, vi, beforeEach, afterEach } from "vitest";
import * as hostEnv from "../infra/host-env-security.js";
import * as windowsSpawn from "../plugin-sdk/windows-spawn.js";
import type { WindowsSpawnProgram } from "../plugin-sdk/windows-spawn.js";
import * as ownedStdio from "../process/owned-stdio.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { spawnLspServerProcess } from "./agent-bundle-lsp-process.js";

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
afterEach(() => vi.restoreAllMocks());

function program(shell: boolean): WindowsSpawnProgram {
  return {
    command: shell ? "cmd.exe" : "typescript-language-server",
    leadingArgv: shell ? ["/c", "typescript-language-server.cmd"] : [],
    resolution: shell ? "shell-fallback" : "direct",
    shell,
    windowsHide: true,
  };
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
    await expect(
      spawnLspServerProcess(
        { command: "typescript-language-server", args: ["--stdio"], ...(env ? { env } : {}) },
        { abortSignal },
      ),
    ).rejects.toThrow("stop after spawn");

    const sanitation = sanitize.mock.calls[0]?.[0];
    expect(sanitation?.baseEnv).toBe(process.env);
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
  await expect(
    withMockedWindowsPlatform(() => spawnLspServerProcess({ command, args })),
  ).rejects.toThrow("captured Windows spawn");
  expect(spawnAndWait).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      argv: [command, ...args],
      options: expect.objectContaining({ env, shell: true, windowsHide: true }),
    }),
  );
});
