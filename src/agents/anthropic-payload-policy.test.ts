import "./ai-transport-runtime-host.js";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "@openclaw/ai/transports";
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

function simpleTextPayload(): TestPayload {
  return {
    system: [{ type: "text", text: "Follow policy." }],
    messages: [{ role: "user", content: "Hello" }],
  };
}
function apply(payload: TestPayload, options: Parameters<typeof cachePolicy>[0] = {}) {
  applyAnthropicPayloadPolicyToParams(payload, cachePolicy(options), new Set());
}

describe("anthropic payload policy", () => {
  it.each([
    [200_000, undefined, 140_000],
    [200_000, 120_000, 120_000],
    [200_000, 42_000, 50_000],
    [32_000, undefined, 50_000],
  ])(
    "compacts context %s with threshold %s at %s",
    (contextWindow, threshold, expectedThreshold) => {
      const payload = simpleTextPayload();
      apply(payload, {
        contextWindow,
        enableCacheControl: false,
        enableServerCompaction: true,
        extraParams: { anthropicServerCompaction: true, anthropicCompactThreshold: threshold },
      });
      expect(payload.context_management).toEqual({
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: expectedThreshold },
            instructions: expect.stringContaining("Do not call any tools"),
          },
        ],
      });
    },
  );

  it("honors the compaction opt-out and preserves authored context management", () => {
    const disabledPayload = simpleTextPayload();
    apply(disabledPayload, {
      contextWindow: 200_000,
      enableCacheControl: false,
      enableServerCompaction: true,
      extraParams: { anthropicServerCompaction: false },
    });
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

  it.each([
    ["https://api.anthropic.com/v1", "standard_only", "standard_only"],
    ["https://proxy.example.com/anthropic", "auto", undefined],
  ] as const)("gates service tier at %s", (baseUrl, serviceTier, expected) => {
    const payload = simpleTextPayload();
    apply(payload, { baseUrl, serviceTier, cacheRetention: "long" });
    if (expected === undefined) {
      expect(payload).not.toHaveProperty("service_tier");
    } else {
      expect(payload.service_tier).toBe(expected);
    }
  });
  it("reserves the last message-cache slot for the latest tool result", () => {
    const payload: TestPayload = {
      system: ["Identity", "Policy"].map((text) => ({ type: "text", text })),
      tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "earlier" }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call", content: "latest" }],
        },
      ],
    };
    apply(payload);
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "earlier" }],
    });
    expect(payload.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call",
          content: "latest",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });
});
