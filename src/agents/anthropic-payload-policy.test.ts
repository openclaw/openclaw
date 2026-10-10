import "./ai-transport-runtime-host.js";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "@openclaw/ai/transports";
/**
 * Tests Anthropic payload policy mutation.
 * Covers service tier, cache-control retention, prompt cache boundaries, and
 * deprecated marker compatibility.
 */
import { describe, expect, it } from "vitest";

type TestPayload = {
  context_management?: unknown;
  messages: Array<{ role: string; content: unknown }>;
  service_tier?: string;
  system?: unknown;
  tools?: unknown;
};

function cachePolicy(overrides: Parameters<typeof resolveAnthropicPayloadPolicy>[0] = {}) {
  return resolveAnthropicPayloadPolicy({
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    cacheRetention: "short",
    enableCacheControl: true,
    ...overrides,
  });
}

function textBlock(text: string, cache_control?: { type: "ephemeral"; ttl?: "1h" }) {
  return {
    type: "text",
    text,
    ...(cache_control ? { cache_control } : {}),
  };
}

function simpleTextPayload(): TestPayload {
  return {
    system: [{ type: "text", text: "Follow policy." }],
    messages: [{ role: "user", content: "Hello" }],
  };
}

function expectShortEphemeralTextPayload(payload: TestPayload) {
  expect(payload.system).toEqual([textBlock("Follow policy.", { type: "ephemeral" })]);
  expect(payload.messages[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
  });
}

describe("anthropic payload policy", () => {
  it.each([
    {
      name: "uses the API minimum for a small context window",
      contextWindow: 32_000,
      extraParams: { anthropicServerCompaction: true },
      expectedThreshold: 50_000,
    },
  ])("$name", ({ contextWindow, extraParams, expectedThreshold }) => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      contextWindow,
      enableServerCompaction: true,
      extraParams,
    });
    const payload = simpleTextPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.context_management).toEqual({
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: expectedThreshold },
        },
      ],
    });
  });

  it("keeps compaction opt-in and preserves authored context management", () => {
    const disabledPolicy = resolveAnthropicPayloadPolicy({
      contextWindow: 200_000,
      enableServerCompaction: true,
      extraParams: {},
    });
    const disabledPayload = simpleTextPayload();
    applyAnthropicPayloadPolicyToParams(disabledPayload, disabledPolicy, new Set());
    expect(disabledPayload).not.toHaveProperty("context_management");

    const configuredPolicy = resolveAnthropicPayloadPolicy({
      contextWindow: 200_000,
      enableServerCompaction: true,
      extraParams: { anthropicServerCompaction: true },
    });
    const existing = { edits: [{ type: "clear_tool_uses_20250919" }] };
    const configuredPayload = { ...simpleTextPayload(), context_management: existing };
    applyAnthropicPayloadPolicyToParams(configuredPayload, configuredPolicy, new Set());
    expect(configuredPayload.context_management).toBe(existing);
  });

  it("keeps explicit short retention unchanged for custom hosts", () => {
    const policy = cachePolicy({ baseUrl: "https://proxy.example.com/anthropic" });
    const payload = simpleTextPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expectShortEphemeralTextPayload(payload);
  });

  it("applies 1h TTL for Vertex AI endpoints with long cache retention", () => {
    const policy = cachePolicy({
      provider: "anthropic-vertex",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cacheRetention: "long",
    });
    const payload: TestPayload = {
      system: [
        { type: "text", text: "Follow policy." },
        { type: "text", text: "Use tools carefully." },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.system).toEqual([
      textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" }),
      textBlock("Use tools carefully.", { type: "ephemeral", ttl: "1h" }),
    ]);
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
  });
});
