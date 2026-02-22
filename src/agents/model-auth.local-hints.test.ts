import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveApiKeyForProvider } from "./model-auth.js";

describe("local provider auth hints", () => {
  it("includes ollama-specific hint when ollama key is missing", async () => {
    const snapshot = captureEnv(["OLLAMA_API_KEY"]);
    delete process.env.OLLAMA_API_KEY;
    try {
      await expect(
        resolveApiKeyForProvider({
          provider: "ollama",
          cfg: {} as Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
          agentDir: "/tmp/test-agent",
        }),
      ).rejects.toThrow("OLLAMA_API_KEY");
    } finally {
      snapshot.restore();
    }
  });

  it("includes vllm-specific hint when vllm key is missing", async () => {
    const snapshot = captureEnv(["VLLM_API_KEY"]);
    delete process.env.VLLM_API_KEY;
    try {
      await expect(
        resolveApiKeyForProvider({
          provider: "vllm",
          cfg: {} as Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
          agentDir: "/tmp/test-agent",
        }),
      ).rejects.toThrow("VLLM_API_KEY");
    } finally {
      snapshot.restore();
    }
  });

  it("includes generic hint for non-local providers", async () => {
    const snapshot = captureEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    try {
      await expect(
        resolveApiKeyForProvider({
          provider: "anthropic",
          cfg: {} as Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
          agentDir: "/tmp/test-agent",
        }),
      ).rejects.toThrow("Configure auth for this agent");
    } finally {
      snapshot.restore();
    }
  });
});
