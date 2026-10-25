import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
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

const ephemeral = { type: "ephemeral" } as const;
const longCache = { ...ephemeral, ttl: "1h" } as const;
const textBlock = (text: string, cache_control?: typeof ephemeral | typeof longCache) => ({
  type: "text",
  text,
  ...(cache_control ? { cache_control } : {}),
});
const user = (content: unknown) => ({ role: "user", content });
function simpleTextPayload(system = [textBlock("Follow policy.")]): TestPayload {
  return {
    system,
    messages: [user("Hello")],
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

  it("applies native Anthropic service tier and checkpoints the user-message tail", () => {
    const payload: TestPayload = {
      system: [textBlock("Follow policy."), textBlock("Use tools carefully.")],
      messages: [
        { role: "assistant", content: [textBlock("Working.")] },
        user([textBlock("Hello"), { type: "tool_result", tool_use_id: "tool_1", content: "done" }]),
      ],
    };
    apply(payload, { cacheRetention: "long", serviceTier: "standard_only" });
    expect(payload.service_tier).toBe("standard_only");
    expect(payload.system).toEqual([
      textBlock("Follow policy.", longCache),
      textBlock("Use tools carefully.", longCache),
    ]);
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [textBlock("Working.")],
    });
    expect(payload.messages[1]).toEqual({
      role: "user",
      content: [
        textBlock("Hello"),
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "done",
          cache_control: longCache,
        },
      ],
    });
  });

  it.each([
    {
      name: "keeps the previous tool-result checkpoint when the latest result advances",
      systemTexts: ["Follow policy."],
      earlier: { type: "tool_result", tool_use_id: "tool_1", content: "first" },
      assistant: "Continue.",
      latest: { tool_use_id: "tool_2", content: "second" },
      toolMarker: false,
      earlierCache: true,
    },
    {
      name: "uses the latest tool result when only one message cache marker remains",
      systemTexts: ["Claude Code identity.", "Follow policy."],
      earlier: { type: "text", text: "Investigate the cache writes." },
      assistant: "I'll inspect the logs.",
      latest: { tool_use_id: "tool_1", content: "log chunk" },
      toolMarker: true,
      earlierCache: false,
    },
  ])("$name", (row) => {
    const payload: TestPayload = {
      system: row.systemTexts.map((text) => textBlock(text)),
      ...(row.toolMarker
        ? { tools: [{ name: "Read", cache_control: { type: "ephemeral" } }] }
        : {}),
      messages: [
        { role: "user", content: [{ ...row.earlier }] },
        { role: "assistant", content: [textBlock(row.assistant)] },
        { role: "user", content: [{ type: "tool_result", ...row.latest }] },
      ],
    };

    apply(payload);

    expect(payload.messages[0]).toEqual(
      user([{ ...row.earlier, ...(row.earlierCache ? { cache_control: ephemeral } : {}) }]),
    );
    expect(payload.messages[2]).toEqual(
      user([{ type: "tool_result", ...row.latest, cache_control: ephemeral }]),
    );
  });

  it("denies proxied Anthropic service tier but honors explicit long TTL for custom hosts", () => {
    const payload = simpleTextPayload();
    apply(payload, {
      baseUrl: "https://proxy.example.com/anthropic",
      cacheRetention: "long",
      serviceTier: "auto",
    });
    expect(payload).not.toHaveProperty("service_tier");
    expect(payload.system).toEqual([textBlock("Follow policy.", longCache)]);
    expect(payload.messages[0]).toEqual(user([textBlock("Hello", longCache)]));
  });

  it("keeps explicit short retention unchanged for custom hosts", () => {
    const payload = simpleTextPayload();
    apply(payload, { baseUrl: "https://proxy.example.com/anthropic" });
    expect(payload.system).toEqual([textBlock("Follow policy.", ephemeral)]);
    expect(payload.messages[0]).toEqual(user([textBlock("Hello", ephemeral)]));
  });

  it("applies 1h TTL for Vertex AI endpoints with long cache retention", () => {
    const payload = simpleTextPayload([
      textBlock("Follow policy."),
      textBlock("Use tools carefully."),
    ]);
    apply(payload, {
      provider: "anthropic-vertex",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cacheRetention: "long",
    });
    expect(payload.system).toEqual([
      textBlock("Follow policy.", longCache),
      textBlock("Use tools carefully.", longCache),
    ]);
    expect(payload.messages[0]).toEqual(user([textBlock("Hello", longCache)]));
  });

  it("strips the boundary even when cache retention is disabled", () => {
    const payload = simpleTextPayload([
      textBlock(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic lab suffix`),
    ]);
    apply(payload, { cacheRetention: "none" });
    expect(payload.system).toEqual([textBlock("Stable prefix\nDynamic lab suffix")]);
  });
});
