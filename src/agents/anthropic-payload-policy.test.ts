import { describe, expect, it } from "vitest";
import {
  applyAnthropicServerCompactionToParams,
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
  resolveAnthropicRequiredBetaFeatures,
  shouldEnableAnthropicServerCompaction,
} from "./anthropic-payload-policy.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

type TestPayload = {
  messages: Array<{ role: string; content: unknown }>;
  service_tier?: string;
  system?: unknown;
};

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
      {
        type: "text",
        text: "Follow policy.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        type: "text",
        text: "Use tools carefully.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
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
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  it("denies proxied Anthropic service tier and omits long-TTL upgrades for custom hosts", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://proxy.example.com/anthropic",
      cacheRetention: "long",
      enableCacheControl: true,
      serviceTier: "auto",
    });
    const payload: TestPayload = {
      system: [{ type: "text", text: "Follow policy." }],
      messages: [{ role: "user", content: "Hello" }],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload).not.toHaveProperty("service_tier");
    expect(payload.system).toEqual([
      {
        type: "text",
        text: "Follow policy.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
    });
  });

  it("splits cached stable system content from uncached dynamic content", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
    });
    const payload: TestPayload = {
      system: [
        {
          type: "text",
          text: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic lab suffix`,
        },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      {
        type: "text",
        text: "Stable prefix",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        type: "text",
        text: "Dynamic lab suffix",
      },
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
      {
        type: "text",
        text: "Follow policy.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        type: "text",
        text: "Use tools carefully.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
    });
  });

  it("applies 5m ephemeral cache for Vertex AI endpoints with short cache retention", () => {
    const policy = resolveAnthropicPayloadPolicy({
      provider: "anthropic-vertex",
      api: "anthropic-messages",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cacheRetention: "short",
      enableCacheControl: true,
    });
    const payload: TestPayload = {
      system: [{ type: "text", text: "Follow policy." }],
      messages: [{ role: "user", content: "Hello" }],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      {
        type: "text",
        text: "Follow policy.",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("requires explicit opt-in before enabling Anthropic server compaction", () => {
    expect(
      shouldEnableAnthropicServerCompaction("anthropic", "https://api.anthropic.com/v1", undefined),
    ).toBe(false);
    expect(
      shouldEnableAnthropicServerCompaction("anthropic", "https://api.anthropic.com/v1", false),
    ).toBe(false);
    expect(
      shouldEnableAnthropicServerCompaction("anthropic", "https://api.anthropic.com/v1", true),
    ).toBe(true);
  });

  it("clamps Anthropic compaction triggers to the documented minimum", () => {
    const payload: Record<string, unknown> = {
      messages: [{ role: "user", content: "Hello" }],
    };

    applyAnthropicServerCompactionToParams(payload, {
      compactThreshold: 25_000,
      pauseAfterCompaction: true,
    });

    expect(payload.context_management).toEqual({
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: 50_000 },
          pause_after_compaction: true,
        },
      ],
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
    const payload: TestPayload = {
      system: [
        {
          type: "text",
          text: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic lab suffix`,
        },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      {
        type: "text",
        text: "Stable prefix\nDynamic lab suffix",
      },
    ]);
  });

  it("injects Anthropic server compaction edits without replacing existing edits", () => {
    const payload: Record<string, unknown> = {
      context_management: {
        edits: [{ type: "clear_tool_uses_20250919" }],
      },
    };

    applyAnthropicServerCompactionToParams(payload, {
      compactThreshold: 123_456,
      pauseAfterCompaction: true,
      instructions: "Preserve code decisions.",
    });

    expect(payload.context_management).toEqual({
      edits: [
        { type: "clear_tool_uses_20250919" },
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: 123_456 },
          pause_after_compaction: true,
          instructions: "Preserve code decisions.",
        },
      ],
    });
  });

  it("adds Anthropic compaction beta features when compaction is enabled or blocks are present", () => {
    expect(
      resolveAnthropicRequiredBetaFeatures({
        enableServerCompaction: true,
        hasCompactionBlocks: false,
      }),
    ).toEqual(["context-management-2025-06-27", "compact-2026-01-12"]);
    expect(
      resolveAnthropicRequiredBetaFeatures({
        enableServerCompaction: false,
        hasCompactionBlocks: true,
      }),
    ).toEqual(["context-management-2025-06-27", "compact-2026-01-12"]);
  });
});
