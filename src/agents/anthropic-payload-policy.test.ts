import { describe, expect, it } from "vitest";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "./anthropic-payload-policy.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

type TestPayload = {
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
  messages: Array<{ role: string; content: unknown }>;
  service_tier?: string;
  system?: unknown;
};

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
  expect(payload.cache_control).toEqual({ type: "ephemeral" });
  // Automatic caching mode: messages are no longer mutated with per-turn breakpoints.
  expect(payload.messages[0]).toEqual({ role: "user", content: "Hello" });
}

describe("anthropic payload policy", () => {
  it("applies native Anthropic service tier and cache markers without widening cache scope", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
      serviceTier: "standard_only",
    });
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

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.service_tier).toBe("standard_only");
    expect(payload.system).toEqual([
      textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" }),
      textBlock("Use tools carefully.", { type: "ephemeral", ttl: "1h" }),
    ]);
    // Automatic caching: top-level cache_control set, messages left untouched.
    expect(payload.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Working." }],
    });
    expect(payload.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "done",
        },
      ],
    });
  });

  it("denies proxied Anthropic service tier but honors explicit long TTL for custom hosts", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://proxy.example.com/anthropic",
      cacheRetention: "long",
      enableCacheControl: true,
      serviceTier: "auto",
    });
    const payload = simpleTextPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload).not.toHaveProperty("service_tier");
    expect(payload.system).toEqual([textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" })]);
    expect(payload.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(payload.messages[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("keeps implicit env-driven long retention conservative for custom hosts", () => {
    const previous = process.env.PI_CACHE_RETENTION;
    process.env.PI_CACHE_RETENTION = "long";
    try {
      const policy = resolveAnthropicPayloadPolicy({
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://proxy.example.com/anthropic",
        enableCacheControl: true,
      });
      const payload = simpleTextPayload();

      applyAnthropicPayloadPolicyToParams(payload, policy);

      expectShortEphemeralTextPayload(payload);
    } finally {
      if (previous === undefined) {
        delete process.env.PI_CACHE_RETENTION;
      } else {
        process.env.PI_CACHE_RETENTION = previous;
      }
    }
  });

  it("keeps explicit short retention unchanged for custom hosts", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://proxy.example.com/anthropic",
      cacheRetention: "short",
      enableCacheControl: true,
    });
    const payload = simpleTextPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expectShortEphemeralTextPayload(payload);
  });

  it("splits cached stable system content from uncached dynamic content", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
    });
    const payload = boundarySystemPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      textBlock("Stable prefix", { type: "ephemeral", ttl: "1h" }),
      textBlock("Dynamic lab suffix"),
    ]);
  });

  it("applies 1h TTL for Vertex AI endpoints with long cache retention", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic-vertex",
      api: "anthropic-messages",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cacheRetention: "long",
      enableCacheControl: true,
    });
    const payload: TestPayload = {
      system: [
        { type: "text", text: "Follow policy." },
        { type: "text", text: "Use tools carefully." },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" }),
      textBlock("Use tools carefully.", { type: "ephemeral", ttl: "1h" }),
    ]);
    expect(payload.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(payload.messages[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("applies 5m ephemeral cache for Vertex AI endpoints with short cache retention", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic-vertex",
      api: "anthropic-messages",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cacheRetention: "short",
      enableCacheControl: true,
    });
    const payload = simpleTextPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([textBlock("Follow policy.", { type: "ephemeral" })]);
  });

  it("enables automatic prompt caching for multi-turn conversations without per-turn breakpoint churn", () => {
    // Regression test: previously this policy placed an explicit cache_control
    // on the trailing user block of every turn, which empirically failed to
    // extend the cache across turns (~26k cache-write tokens per turn for
    // ~120 chars of new conversation). Anthropic's automatic caching mode
    // (top-level cache_control) is the documented multi-turn shape.
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
    });
    const payload: TestPayload = {
      system: [{ type: "text", text: "Follow policy." }],
      messages: [
        { role: "user", content: "Turn 1 user." },
        { role: "assistant", content: [{ type: "text", text: "Turn 1 assistant." }] },
        { role: "user", content: "Turn 2 user." },
        { role: "assistant", content: [{ type: "text", text: "Turn 2 assistant." }] },
        { role: "user", content: "Turn 3 user." },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(payload.system).toEqual([
      textBlock("Follow policy.", { type: "ephemeral", ttl: "1h" }),
    ]);
    // None of the message blocks should carry a per-turn cache_control: the
    // top-level field is the single cache anchor and Anthropic auto-advances
    // it as the conversation grows.
    for (const msg of payload.messages) {
      if (typeof msg.content === "string") continue;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          expect(block).not.toHaveProperty("cache_control");
        }
      }
    }
    // The last user message specifically must not have been rewritten into a
    // block array with a cache_control tag (that was the old behaviour).
    expect(payload.messages[payload.messages.length - 1]).toEqual({
      role: "user",
      content: "Turn 3 user.",
    });
  });

  it("strips the boundary even when cache retention is disabled", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "none",
      enableCacheControl: true,
    });
    const payload = boundarySystemPayload();

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([textBlock("Stable prefix\nDynamic lab suffix")]);
  });
});
