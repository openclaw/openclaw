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

  it.each([
    { alias: "amazon-bedrock", canonical: "bedrock" },
    { alias: "openai/", canonical: "openai" },
  ])("prefers $canonical over $alias", ({ alias, canonical }) => {
    const entry = resolveProviderToolPolicyEntry({
      byProvider: {
        [alias]: { profile: "alias" },
        [canonical]: { profile: "canonical" },
      },
      modelProvider: canonical,
    });

    expect(entry).toEqual({
      key: canonical,
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
