import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  applyAnthropicPayloadPolicyToParams,
  isAnthropicServerToolClearingEnabled,
  resolveAnthropicPayloadPolicy,
  resolveAnthropicEphemeralCacheControl,
  resolveAnthropicServerCompactionPlan,
} from "./anthropic-payload-policy.js";

describe("resolveAnthropicEphemeralCacheControl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["https://us-east5-aiplatform.googleapis.com"])(
    "preserves env-configured long retention for the official %s endpoint",
    (baseUrl) => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");

      expect(resolveAnthropicEphemeralCacheControl(baseUrl, undefined)).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    },
  );

  it("keeps env-configured long retention restricted for custom proxy endpoints", () => {
    vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");

    expect(
      resolveAnthropicEphemeralCacheControl("https://proxy.example.test/vertex", undefined),
    ).toEqual({ type: "ephemeral" });
  });
});

describe("Anthropic compaction authentication eligibility", () => {
  const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };
  const extraParams = { anthropicServerCompaction: true };

  it("uses the same host-resolved credential shape as the transport", () => {
    const host = getAiTransportHost();
    configureAiTransportHost({ ...host, resolveSecretSentinel: () => "test-sk-ant-oat-fixture" });
    try {
      expect(
        resolveAnthropicServerCompactionPlan(model, extraParams, "credential-sentinel"),
      ).toEqual({ enabled: false });
    } finally {
      configureAiTransportHost(host);
    }
  });
});

describe("Anthropic server compaction default", () => {
  const direct = {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    contextWindow: 200_000,
  };

  it.each([
    { name: "OAuth credentials", model: direct, apiKey: "test-sk-ant-oat-fixture" },
    { name: "a proxy host", model: { ...direct, baseUrl: "https://proxy.example.test/v1" } },
  ])("stays off for $name", ({ model, apiKey = "test-api-key" }) => {
    expect(resolveAnthropicServerCompactionPlan(model, {}, apiKey)).toEqual({
      enabled: false,
    });
  });

  it("triggers inside a configured input cap", () => {
    expect(
      resolveAnthropicServerCompactionPlan(
        { ...direct, contextWindow: 1_000_000, contextTokens: 200_000 },
        {},
        "test-api-key",
      ),
    ).toEqual({ enabled: true, threshold: 140_000 });
  });
});

describe("Anthropic tool-clearing policy", () => {
  const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };

  it.each(["  "])(
    "requires resolved authentication before disabling client pruning: %j",
    (apiKey) => {
      expect(isAnthropicServerToolClearingEnabled(model, apiKey)).toBe(false);
    },
  );

  it.each([
    {
      tools: { allow: ["look*"], deny: ["exec*"] },
      excluded: ["exec_retired", "other_retired", "search"],
    },
    { tools: { deny: ["exec*"] }, excluded: ["exec_retired"] },
  ])("applies pruning filters to exposed and historical tools: $tools", ({ tools, excluded }) => {
    const payload: Record<string, unknown> = {
      tools: [{ name: "lookup" }, { name: "search" }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "old_exec", name: "exec_retired", input: {} },
            { type: "tool_use", id: "old_other", name: "other_retired", input: {} },
            { type: "tool_use", id: "old_lookup", name: "lookup_retired", input: {} },
          ],
        },
      ],
    };
    const policy = resolveAnthropicPayloadPolicy({
      ...model,
      cacheTtlPruning: { tools },
    });
    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());
    expect(payload.context_management).toEqual({
      edits: [
        expect.objectContaining({
          type: "clear_tool_uses_20250919",
          exclude_tools: excluded,
        }),
      ],
    });
  });
});
