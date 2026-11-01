import fs from "node:fs/promises";
import path from "node:path";
import { createWindowsCmdShimFixture, withTempDir } from "openclaw/plugin-sdk/test-env";
import { withRestoredMocks } from "openclaw/plugin-sdk/test-node-mocks";
import * as windowsSpawn from "openclaw/plugin-sdk/windows-spawn";
import { beforeEach, expect, it, vi } from "vitest";

const runCommand = vi.hoisted(() => vi.fn());

// mock-isolation: auth status fixtures must not execute the host's Claude CLI.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runUtf8CommandWithTimeout: runCommand }));

const { probeClaudeCliAuthStatus } = await import("./cli-auth-api.js");
const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/process-runtime")>(
  "openclaw/plugin-sdk/process-runtime",
);

beforeEach(() => {
  runCommand.mockReset();
});

function mockStatus(payload: unknown, code: number | null = 0) {
  const termination = code === null ? "timeout" : "exit";
  const stdout = typeof payload === "string" ? payload : JSON.stringify(payload);
  runCommand.mockResolvedValue({ code, termination, stdout });
}

it("asks Claude CLI for its active account and returns only safe display fields", async () => {
  const account = { authMethod: "claude.ai", email: "account@example.test" };
  mockStatus({
    loggedIn: true,
    ...account,
    email: " account@example.test ",
    orgId: "private-organization",
    accessToken: "synthetic-access-token",
  });

  expect(await probeClaudeCliAuthStatus({ command: "/test/claude" })).toEqual({
    status: "available",
    ...account,
  });

  expect(runCommand).toHaveBeenCalledWith(
    ["/test/claude", "auth", "status", "--json"],
    expect.objectContaining({ timeoutMs: 10_000, killProcessTree: true }),
  );
});

it.each(['["CLAUDE_CODE_OAUTH_TOKEN"]', "CLAUDE_CODE_OAUTH_TOKEN, OTHER"])(
  "keeps the runtime child's preserved login: %s",
  async (preserve) => {
    mockStatus({ loggedIn: true, authMethod: "oauth_token" });

    const result = await probeClaudeCliAuthStatus({
      command: "/test/claude",
      env: {
        OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV: preserve,
        CLAUDE_CODE_OAUTH_TOKEN: "synthetic-preserved-token",
        ANTHROPIC_API_KEY: "synthetic-cleared-api-key",
      },
    });
    expect(result).toEqual({ status: "available", authMethod: "oauth_token" });

    const baseEnv = runCommand.mock.calls[0]?.[1]?.baseEnv;
    expect(baseEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe("synthetic-preserved-token");
    expect(baseEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  },
);

it("runs a Windows Claude npm shim selected by PATH", () =>
  withTempDir("anthropic-cli-auth-", async (dir) => {
    const home = await fs.realpath(dir);
    const shimPath = path.join(home, "claude.cmd");
    const scriptPath = path.join(home, "node_modules", "@anthropic-ai", "claude-code", "cli.cjs");
    const configDir = path.join(home, "selected account");
    const account = { authMethod: "claude.ai", email: "windows@example.test" };
    await createWindowsCmdShimFixture({
      shimPath,
      scriptPath,
      shimLine: [
        "GOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nCALL :find_dp0",
        `"${process.execPath}" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.cjs" %*`,
      ].join("\r\n"),
    });
    await fs.writeFile(
      scriptPath,
      `
        const assert = require("node:assert/strict");
        assert.deepEqual(process.argv.slice(2), ["auth", "status", "--json"]);
        assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
        assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
        assert.equal(process.env.CLAUDE_CONFIG_DIR, ${JSON.stringify(configDir)});
        process.stdout.write(${JSON.stringify(JSON.stringify({ loggedIn: true, ...account }))});
      `,
    );
    runCommand.mockImplementation(actual.runUtf8CommandWithTimeout);
    const resolveProgram = windowsSpawn.resolveWindowsSpawnProgram;
    const resolver = vi
      .spyOn(windowsSpawn, "resolveWindowsSpawnProgram")
      .mockImplementation((params) => resolveProgram({ ...params, platform: "win32" }));
    // Resolve the Windows wrapper, then execute its real JS entrypoint on the host platform.
    await withRestoredMocks([resolver], async () => {
      const result = await probeClaudeCliAuthStatus({
        env: {
          PATH: `${home};${path.dirname(process.execPath)}`,
          PATHEXT: ".CMD;.EXE;.BAT",
          HOME: home,
          USERPROFILE: home,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ANTHROPIC_API_KEY: "synthetic-ignored-api-key",
          CLAUDE_CODE_OAUTH_TOKEN: "synthetic-ignored-token",
          CLAUDE_CONFIG_DIR: configDir,
        },
      });
      expect(result).toEqual({ status: "available", ...account });
      expect(runCommand).toHaveBeenCalledWith(
        [process.execPath, scriptPath, "auth", "status", "--json"],
        expect.any(Object),
      );
    });
  }));

it.each([
  [
    { loggedIn: true, authMethod: "unknown-method", email: "inactive@example.test" },
    0,
    { status: "available" },
  ],
  [{ loggedIn: false }, 0, { status: "missing" }],
  [{ loggedIn: false }, 1, { status: "missing" }],
  ["keychain unavailable", 1, { status: "unreadable" }],
  [{}, 0, { status: "unreadable" }],
  [{ loggedIn: "false" }, 0, { status: "unreadable" }],
  [{ loggedIn: true }, 1, { status: "unreadable" }],
  [{ loggedIn: true }, null, { status: "timeout", timeoutMs: 10_000 }],
] as const)("auth status %j / %s", async (payload, code, expected) => {
  mockStatus(payload, code);
  expect(await probeClaudeCliAuthStatus()).toEqual(expected);
});

it("reports a host without the Claude executable as not installed", () =>
  withTempDir("anthropic-cli-auth-", async (dir) => {
    runCommand.mockImplementation(actual.runUtf8CommandWithTimeout);
    expect(await probeClaudeCliAuthStatus({ env: { PATH: dir } })).toEqual({
      status: "not-installed",
    });
  }));

it("does not turn a cancelled probe into a logged-out account", async () => {
  const controller = new AbortController();
  const reason = new Error("native auth cancelled");
  runCommand.mockImplementation(async () => {
    controller.abort(reason);
    return { code: null, termination: "signal", stdout: "" };
  });
  await expect(probeClaudeCliAuthStatus({ signal: controller.signal })).rejects.toBe(reason);
});
