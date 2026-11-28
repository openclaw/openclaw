import { describe, expect, it } from "vitest";
import {
  normalizeToolProviderPolicyKey,
  resolveProviderToolPolicy,
  resolveProviderToolPolicyEntry,
} from "./provider-tool-policy.js";

describe("provider tool policy", () => {
  it("normalizes provider and model keys", () => {
    expect(normalizeToolProviderPolicyKey(" OpenAI/GPT-5 ")).toBe("openai/gpt-5");
    expect(normalizeToolProviderPolicyKey("openai/")).toBe("openai");
  });

  it("prefers canonical entries over normalized keys", () => {
    const entry = resolveProviderToolPolicyEntry({
      byProvider: {
        "openai/": { profile: "alias" },
        openai: { profile: "canonical" },
      },
      modelProvider: "openai",
    });

    expect(entry).toEqual({
      key: "openai",
      policy: { profile: "canonical" },
    });
  });

  it("keeps slash-containing model ids inside the selected provider", () => {
    expect(
      resolveProviderToolPolicy({
        byProvider: {
          "anthropic/claude-sonnet": { deny: ["exec"] },
          "openrouter/anthropic/claude-sonnet": { deny: ["read"] },
        },
        modelProvider: "openrouter",
        modelId: "anthropic/claude-sonnet",
      }),
    ).toEqual({ deny: ["read"] });
  });

  it("ignores malformed provider policy entries", () => {
    expect(
      resolveProviderToolPolicy({
        byProvider: {
          openai: "not a policy",
          anthropic: { profile: "minimal" },
        },
        modelProvider: "openai",
      }),
    ).toBeUndefined();
  });
});
