import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { runUtf8CommandWithTimeout } = vi.hoisted(() => ({
  runUtf8CommandWithTimeout: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runUtf8CommandWithTimeout }));

import { observeClaudeCliNativeLogin } from "./cli-auth-api.js";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "claude-native-login-"));
  await fs.mkdir(path.join(home, ".claude"));
  runUtf8CommandWithTimeout.mockReset();
  runUtf8CommandWithTimeout.mockResolvedValue({ termination: "exit", code: 44 });
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

it("admits Claude-owned credentials without interpreting zero expiry or reading token bytes", async () => {
  await fs.writeFile(
    path.join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", expiresAt: 0 } }),
  );
  expect(await observeClaudeCliNativeLogin({ env: { HOME: home } })).toEqual({
    readiness: "configured",
  });
  expect(runUtf8CommandWithTimeout).not.toHaveBeenCalled();
});

it("reports a truly empty selected login and picks up a login without restarting", async () => {
  const configDir = path.join(home, "selected");
  await fs.mkdir(configDir);
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: "ignored-api-key",
    CLAUDE_CODE_OAUTH_TOKEN: "ignored-oauth-token",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
  };
  const missing = await observeClaudeCliNativeLogin({ env });
  expect(missing).toMatchObject({
    readiness: "missing",
    message: expect.stringContaining(configDir),
  });
  expect(missing).toMatchObject({ message: expect.stringContaining("claude auth login") });
  if (process.platform === "darwin") {
    const [command, options] = runUtf8CommandWithTimeout.mock.calls[0]!;
    expect(command).not.toContain("-w");
    expect(command).not.toContain("-g");
    expect(options.baseEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.baseEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(options.baseEnv.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(options.baseEnv.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
  }
  await fs.writeFile(path.join(configDir, ".credentials.json"), "opaque native credentials");
  expect(await observeClaudeCliNativeLogin({ env })).toEqual({ readiness: "configured" });
});

it("does not call user settings or an inaccessible keychain a logged-out account", async () => {
  await fs.writeFile(path.join(home, ".claude", "settings.json"), "opaque user settings");
  expect(await observeClaudeCliNativeLogin({ env: { HOME: home } })).toEqual({
    readiness: "unknown",
  });
  if (process.platform === "darwin") {
    await fs.rm(path.join(home, ".claude", "settings.json"));
    runUtf8CommandWithTimeout.mockResolvedValue({ termination: "timeout", code: null });
    expect(await observeClaudeCliNativeLogin({ env: { HOME: home } })).toEqual({
      readiness: "unknown",
    });
  }
});
