import { describe, expect, it } from "vitest";
import {
  buildGoogleAntigravityCliBackend,
  GOOGLE_ANTIGRAVITY_MODEL_ALIASES,
} from "./backend.js";

describe("google-antigravity-cli CLI backend", () => {
  it("declares a stateless agy print contract", () => {
    const backend = buildGoogleAntigravityCliBackend({});

    expect(backend.nativeToolMode).toBe("always-on");
    expect(backend.config).toEqual(
      expect.objectContaining({
        command: "agy",
        args: ["--print", "{prompt}", "--print-timeout", "5m0s"],
        input: "arg",
        output: "text",
        maxPromptArgChars: 8000,
        modelArg: "--model",
        sessionMode: "none",
        reseedFromRawTranscriptWhenUncompacted: true,
        serialize: true,
      }),
    );
    expect(GOOGLE_ANTIGRAVITY_MODEL_ALIASES).toMatchObject({
      flash: "gemini-3-flash",
      pro: "gemini-3-pro-low",
      "pro-high": "gemini-3-pro-high",
    });
    expect(GOOGLE_ANTIGRAVITY_MODEL_ALIASES).not.toHaveProperty("gemini-3.1-pro");
  });

  it("forwards only the Antigravity user-data directory and clears Google API auth", async () => {
    const backend = buildGoogleAntigravityCliBackend({
      ANTIGRAVITY_USER_DATA_DIR: " /tmp/antigravity-profile ",
      GEMINI_API_KEY: "secret",
    });

    const prepared = await backend.prepareExecution?.({
      workspaceDir: "/tmp/workspace",
      provider: "google-antigravity-cli",
      modelId: "gemini-3-flash",
    });

    expect(prepared).toEqual({
      env: { ANTIGRAVITY_USER_DATA_DIR: "/tmp/antigravity-profile" },
      clearEnv: [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_PROJECT_ID",
      ],
    });
  });
});
