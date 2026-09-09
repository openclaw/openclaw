import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeCodexNativeAuth } from "./native-auth.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runUtf8CommandWithTimeout: run }));

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
  });

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
