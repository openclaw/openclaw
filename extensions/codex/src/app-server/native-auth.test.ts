import { createRequire } from "node:module";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexPluginConfig } from "./config-contracts.js";
import { probeCodexNativeAuth } from "./native-auth.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runUtf8CommandWithTimeout: run,
}));

const appServer = { command: "native-codex-fixture", homeScope: "user" as const };
const configFor = (options: CodexPluginConfig["appServer"]): OpenClawConfig => ({
  plugins: { entries: { codex: { config: { appServer: options } } } },
});
const config = configFor(appServer);
const loginResult = (stderr = "Logged in using ChatGPT", code = 0) => ({
  termination: "exit",
  code,
  stdout: "",
  stderr,
});
const probe = (options: CodexPluginConfig["appServer"], env: NodeJS.ProcessEnv = {}) =>
  probeCodexNativeAuth({ pluginConfig: { appServer: options }, env });

describe("Codex native login discovery", () => {
  beforeEach(() => void run.mockReset().mockResolvedValue(loginResult()));

  it("projects API key login as a native-only fact", async () => {
    run.mockResolvedValue(loginResult("Logged in using an API key - sk-synthetic***11111"));
    expect(await probeCodexNativeAuth({ config, env: {} })).toMatchObject({
      source: "Codex native login",
      mode: "api-key",
      nativeAuth: { runtime: "codex", mode: "api-key" },
    });
  });

  it.each([
    [0, "Logged in using Amazon Bedrock"],
    [1, "Not logged in"],
  ])("does not authorize OpenAI from exit %s and %s", async (code, stderr) => {
    run.mockResolvedValue(loginResult(stderr, code));
    expect(await probeCodexNativeAuth({ config })).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it("uses the effective environment arguments and clears excluded variables", async () => {
    const env = {
      CODEX_HOME: "/fixture/native-home",
      CODEX_API_KEY: "must-be-cleared",
      OPENCLAW_CODEX_APP_SERVER_ARGS:
        "-c 'cli_auth_credentials_store=\"keyring\"' app-server --listen stdio:// --config='log_dir=\"app-server\"' --enable fixture_feature",
    };
    expect(
      await probe({ ...appServer, mode: "yolo", clearEnv: ["CODEX_API_KEY"] }, env),
    ).toMatchObject({ mode: "oauth" });
    expect(run).toHaveBeenCalledWith(
      [
        "native-codex-fixture",
        "-c",
        'cli_auth_credentials_store="keyring"',
        '--config=log_dir="app-server"',
        "--enable",
        "fixture_feature",
        "login",
        "status",
      ],
      expect.objectContaining({
        baseEnv: expect.objectContaining({ CODEX_HOME: "/fixture/native-home" }),
      }),
    );
    expect(run.mock.calls[0]?.[1].baseEnv).not.toHaveProperty("CODEX_API_KEY");
    expect(env.CODEX_API_KEY).toBe("must-be-cleared");
  });

  it("does not borrow the user login for homeScope=agent", async () => {
    expect(
      await probeCodexNativeAuth({ config: configFor({ homeScope: "agent" }) }),
    ).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves the official Node launcher and native config when probing login", async () => {
    const launcher = createRequire(new URL("../../package.json", import.meta.url)).resolve(
      "@openai/codex/bin/codex.js",
    );
    const authArgs = ["-c", 'cli_auth_credentials_store="file"'];
    const logArgs = ["--config", 'log_dir="app-server"'];
    expect(
      await probe({
        command: process.execPath,
        homeScope: "user",
        args: [launcher, ...authArgs, "app-server", ...logArgs, "--listen", "stdio://", "--"],
      }),
    ).toMatchObject({ mode: "oauth" });
    expect(run).toHaveBeenCalledWith(
      [process.execPath, launcher, ...authArgs, ...logArgs, "login", "status"],
      expect.any(Object),
    );
  });

  it("does not borrow the local login for a proxy selected through environment arguments", async () => {
    expect(
      await probeCodexNativeAuth({
        config,
        env: { OPENCLAW_CODEX_APP_SERVER_ARGS: "app-server proxy --sock /fixture/server.sock" },
      }),
    ).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not publish a result after its capture is cancelled", async () => {
    const owner = new AbortController();
    run.mockImplementation(async () => {
      owner.abort(new Error("capture replaced"));
      return loginResult();
    });
    await expect(probeCodexNativeAuth({ config, signal: owner.signal })).rejects.toThrow(
      "capture replaced",
    );
  });
});
