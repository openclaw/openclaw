import { describe, expect, it } from "vitest";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
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
          cache_control: { type: "ephemeral", ttl: "1h" },
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
});
