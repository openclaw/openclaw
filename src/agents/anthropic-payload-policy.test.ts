import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
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

function boundarySystemPayload(): TestPayload {
  return {
    system: [
      {
        type: "text",
        text: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic lab suffix`,
      },
    ],
    messages: [{ role: "user", content: "Hello" }],
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
      name: "uses 70 percent of the context window by default",
      contextWindow: 200_000,
      extraParams: { anthropicServerCompaction: true },
      expectedThreshold: 140_000,
    },
    {
      name: "uses an explicit threshold",
      contextWindow: 200_000,
      extraParams: {
        anthropicServerCompaction: true,
        anthropicCompactThreshold: 120_000,
      },
      expectedThreshold: 120_000,
    },
    {
      name: "clamps an explicit threshold to the API minimum",
      contextWindow: 200_000,
      extraParams: {
        anthropicServerCompaction: true,
        anthropicCompactThreshold: 42_000,
      },
      expectedThreshold: 50_000,
    },
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

  it("applies native Anthropic service tier and cache markers without widening cache scope", () => {
    const policy = cachePolicy({ cacheRetention: "long", serviceTier: "standard_only" });
    const payload: TestPayload = {
      system: [
        { type: "text", text: "Follow policy." },
        { type: "text", text: "Use tools carefully." },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Working." }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_result", tool_use_id: "tool_1", content: "done" },
          ],
        },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.service_tier).toBe("standard_only");
    expect(payload.system).toEqual([
      textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" }),
      textBlock("Use tools carefully.", { type: "ephemeral", ttl: "1h" }),
    ]);
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Working." }],
    });
    expect(payload.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } },
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "done",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    });
  });

  it("falls back to the latest tool result when no user text or image exists", () => {
    const policy = cachePolicy();
    const payload: TestPayload = {
      system: [{ type: "text", text: "Follow policy." }],
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "first" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Continue." }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_2", content: "second" }],
        },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_1", content: "first" }],
    });
    expect(payload.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_2",
          content: "second",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  it("uses the latest tool result when only one message cache marker remains", () => {
    const policy = cachePolicy();
    const payload: TestPayload = {
      system: [
        { type: "text", text: "Claude Code identity." },
        { type: "text", text: "Follow policy." },
      ],
      tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Investigate the cache writes." }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'll inspect the logs." }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "log chunk" }],
        },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Investigate the cache writes." }],
    });
    expect(payload.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "log chunk",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  it("denies proxied Anthropic service tier but honors explicit long TTL for custom hosts", () => {
    const policy = cachePolicy({
      baseUrl: "https://proxy.example.com/anthropic",
      cacheRetention: "long",
      serviceTier: "auto",
    });
    const payload = simpleTextPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload).not.toHaveProperty("service_tier");
    expect(payload.system).toEqual([textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" })]);
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
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

  it("strips the boundary even when cache retention is disabled", () => {
    const policy = cachePolicy({ cacheRetention: "none" });
    const payload = boundarySystemPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy, new Set());

    expect(payload.system).toEqual([textBlock("Stable prefix\nDynamic lab suffix")]);
  });
});
