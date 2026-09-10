import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeCodexNativeAuth } from "./native-auth.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runUtf8CommandWithTimeout: run,
}));

const config: OpenClawConfig = {
  plugins: { entries: { codex: { config: { appServer: { command: "native-codex-fixture" } } } } },
};

describe("Codex native login discovery", () => {
  beforeEach(() => run.mockReset());

  it.each([
    ["Logged in using an API key - sk-synthetic***11111", "api-key"],
    ["Logged in using ChatGPT", "oauth"],
    ["Logged in using access token", "token"],
  ])("projects %s as a native-only fact", async (line, mode) => {
    run.mockResolvedValue({ termination: "exit", code: 0, stdout: "", stderr: line });
    expect(await probeCodexNativeAuth({ config, env: {} })).toMatchObject({
      source: "Codex native login",
      mode,
      nativeAuth: { runtime: "codex", mode },
    });
  });

  it.each([
    [0, "Logged in using Amazon Bedrock"],
    [0, "Logged in using workload identity"],
    [1, "Not logged in"],
    [0, "unexpected response"],
  ])("does not authorize OpenAI from exit %s and %s", async (code, stderr) => {
    run.mockResolvedValue({ termination: "exit", code, stdout: "", stderr });
    expect(await probeCodexNativeAuth({ config })).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(["config", "env"] as const)(
    "uses the effective %s arguments and environment",
    async (source) => {
      run.mockResolvedValue({
        termination: "exit",
        code: 0,
        stdout: "",
        stderr: "Logged in using ChatGPT",
      });
      const args = [
        "-c",
        'cli_auth_credentials_store="keyring"',
        "app-server",
        "--listen",
        "stdio://",
        '--config=log_dir="app-server"',
        "--enable",
        "fixture_feature",
      ];
      const env = {
        CODEX_HOME: "/fixture/native-home",
        CODEX_API_KEY: "must-be-cleared",
        ...(source === "env"
          ? {
              OPENCLAW_CODEX_APP_SERVER_ARGS:
                "-c 'cli_auth_credentials_store=\"keyring\"' app-server --listen stdio:// --config='log_dir=\"app-server\"' --enable fixture_feature",
            }
          : {}),
      };
      expect(
        await probeCodexNativeAuth({
          pluginConfig: {
            appServer: {
              command: "native-codex-fixture",
              mode: "yolo",
              clearEnv: ["CODEX_API_KEY"],
              ...(source === "config" ? { args } : {}),
            },
          },
          env,
        }),
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
    },
  );

  it("does not borrow the user login for an explicitly isolated home", async () => {
    expect(
      await probeCodexNativeAuth({
        config: {
          plugins: { entries: { codex: { config: { appServer: { homeScope: "agent" } } } } },
        },
      }),
    ).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not publish a result after its capture is cancelled", async () => {
    const owner = new AbortController();
    run.mockImplementation(async () => {
      owner.abort(new Error("capture replaced"));
      return { termination: "exit", code: 0, stdout: "", stderr: "Logged in using ChatGPT" };
    });
    await expect(probeCodexNativeAuth({ config, signal: owner.signal })).rejects.toThrow(
      "capture replaced",
    );
  });
});
