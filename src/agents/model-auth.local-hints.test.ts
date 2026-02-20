import { describe, expect, it } from "vitest";
import { resolveApiKeyForProvider } from "./model-auth.js";

describe("local provider auth hints", () => {
  it("includes ollama-specific hint when ollama key is missing", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "ollama",
        cfg: {} as Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
        agentDir: "/tmp/test-agent",
      }),
    ).rejects.toThrow("OLLAMA_API_KEY");
  });

  it("includes vllm-specific hint when vllm key is missing", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "vllm",
        cfg: {} as Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
        agentDir: "/tmp/test-agent",
      }),
    ).rejects.toThrow("VLLM_API_KEY");
  });

  it("includes generic hint for non-local providers", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "anthropic",
        cfg: {} as Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
        agentDir: "/tmp/test-agent",
      }),
    ).rejects.toThrow("Configure auth for this agent");
  });
});
