import { expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { registerParityHostLifecycle } from "../provider-transport-parity.test-support.js";
import {
  applyAnthropicPayloadPolicyToParams,
  isAnthropicServerToolClearingEnabled,
  resolveAnthropicPayloadPolicy,
  resolveAnthropicEphemeralCacheControl,
  resolveAnthropicServerCompactionPlan,
} from "./anthropic-payload-policy.js";

const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };
const direct = { ...model, id: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com/v1" };

registerParityHostLifecycle();

it.each([
  ["https://us-east5-aiplatform.googleapis.com", { type: "ephemeral", ttl: "1h" }],
  ["https://proxy.example.test/vertex", { type: "ephemeral" }],
] as const)("gates env-configured long retention for %s", (baseUrl, expected) => {
  vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
  expect(resolveAnthropicEphemeralCacheControl(baseUrl, undefined)).toEqual(expected);
});
it("uses the same host-resolved credential shape as the transport", () => {
  configureAiTransportHost({
    ...getAiTransportHost(),
    resolveSecretSentinel: () => "test-sk-ant-oat-fixture",
  });
  expect(
    resolveAnthropicServerCompactionPlan(
      model,
      { anthropicServerCompaction: true },
      "credential-sentinel",
    ),
  ).toEqual({ enabled: false });
});
it.each([
  { name: "OAuth credentials", model: direct, apiKey: "test-sk-ant-oat-fixture" },
  { name: "a proxy host", model: { ...direct, baseUrl: "https://proxy.example.test/v1" } },
])("stays off for $name", ({ model: requestModel, apiKey = "test-api-key" }) => {
  expect(resolveAnthropicServerCompactionPlan(requestModel, {}, apiKey)).toEqual({
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
it("requires resolved authentication before disabling client pruning", () => {
  expect(isAnthropicServerToolClearingEnabled(model, "  ")).toBe(false);
});

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
        content: ["exec", "other", "lookup"].map((name) => ({
          type: "tool_use",
          id: `old_${name}`,
          name: `${name}_retired`,
          input: {},
        })),
      },
    ],
  };
  const policy = resolveAnthropicPayloadPolicy({ ...model, cacheTtlPruning: { tools } });
  applyAnthropicPayloadPolicyToParams(payload, policy, new Set());
  expect(payload.context_management).toEqual({
    edits: [expect.objectContaining({ type: "clear_tool_uses_20250919", exclude_tools: excluded })],
  });
});
