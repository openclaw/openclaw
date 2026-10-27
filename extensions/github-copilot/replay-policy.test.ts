// Github Copilot tests cover replay policy transport dispatch.
import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderReplayPolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { registerProviderWithPluginConfig } from "./provider.test-support.js";
import { buildGithubCopilotReplayPolicy } from "./replay-policy.js";

function buildPolicy(modelApi: ProviderReplayPolicyContext["modelApi"], modelId: string) {
  return buildGithubCopilotReplayPolicy({ provider: "github-copilot", modelApi, modelId });
}

describe("buildGithubCopilotReplayPolicy", () => {
  it("leaves transcript tool ids to the Copilot stream wrapper", () => {
    const policy = buildPolicy("anthropic-messages", "claude-opus-5");
    expect(policy).toMatchObject({
      appendOnlyRuntimeContext: false,
      validateAnthropicTurns: true,
      sanitizeMode: "full",
      repairToolUseResultPairing: true,
      preserveSignatures: true,
      allowSyntheticToolResults: true,
      dropThinkingBlocks: true,
    });
    expect(policy).not.toHaveProperty("sanitizeToolCallIds");
    expect(policy).not.toHaveProperty("toolCallIdMode");
  });

  it("claims no policy for OpenAI-compatible transports", () => {
    expect(buildPolicy("openai-responses", "gpt-5.4")).toBeUndefined();
    expect(buildPolicy("openai-completions", "gemini-3.1-pro-preview")).toBeUndefined();
  });
});

describe("sanitizeReplayHistoryAsync", () => {
  const sanitize = expectDefined(
    registerProviderWithPluginConfig({}).sanitizeReplayHistoryAsync,
    "replay-history sanitizer",
  );
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private", thinkingSignature: "sig" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "visible" },
      ],
    },
  ];

  it("strips replayed thinking on the Anthropic transport", async () => {
    expect(
      await sanitize({
        provider: "github-copilot",
        modelApi: "anthropic-messages",
        modelId: "claude-opus-5",
        messages,
      } as never),
    ).toEqual([{ role: "assistant", content: [{ type: "text", text: "visible" }] }]);
  });

  it("passes history through on the OpenAI Completions transport", async () => {
    expect(
      await sanitize({
        provider: "github-copilot",
        modelApi: "openai-completions",
        modelId: "gpt-5.4",
        messages,
      } as never),
    ).toBe(messages);
  });
});
