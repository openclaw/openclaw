import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  applyAnthropicPayloadPolicyToParams,
  applyAnthropicRequestCacheControl,
  isAnthropicServerToolClearingEnabled,
  resolveAnthropicPayloadPolicy,
  resolveAnthropicEphemeralCacheControl,
  resolveAnthropicServerCompactionPlan,
} from "./anthropic-payload-policy.js";

describe("resolveAnthropicEphemeralCacheControl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    "https://aiplatform.googleapis.com",
    "https://us-east5-aiplatform.googleapis.com",
    "https://aiplatform.us.rep.googleapis.com",
    "https://aiplatform.eu.rep.googleapis.com",
  ])("preserves env-configured long retention for the official %s endpoint", (baseUrl) => {
    vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");

    expect(resolveAnthropicEphemeralCacheControl(baseUrl, undefined)).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("keeps env-configured long retention restricted for custom proxy endpoints", () => {
    vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");

    expect(
      resolveAnthropicEphemeralCacheControl("https://proxy.example.test/vertex", undefined),
    ).toEqual({ type: "ephemeral" });
  });

  it("preserves explicitly configured long retention for custom proxy endpoints", () => {
    expect(
      resolveAnthropicEphemeralCacheControl("https://proxy.example.test/vertex", "long"),
    ).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("Anthropic compaction authentication eligibility", () => {
  const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };
  const extraParams = { anthropicServerCompaction: true };

  it("rejects OAuth credentials without changing config-only threshold planning", () => {
    expect(resolveAnthropicServerCompactionPlan(model, extraParams)).toEqual({
      enabled: true,
      threshold: 140_000,
    });
    expect(resolveAnthropicServerCompactionPlan(model, extraParams, "test-api-key")).toEqual({
      enabled: true,
      threshold: 140_000,
    });
    expect(
      resolveAnthropicServerCompactionPlan(model, extraParams, "test-sk-ant-oat-fixture"),
    ).toEqual({ enabled: false });
  });

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

describe("Anthropic tool-clearing policy", () => {
  const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };

  it.each([undefined, "", "  "])(
    "requires resolved authentication before disabling client pruning: %j",
    (apiKey) => {
      expect(isAnthropicServerToolClearingEnabled(model, apiKey)).toBe(false);
    },
  );

  it.each([
    { tools: { allow: ["look*"] }, excluded: ["exec_retired", "other_retired", "search"] },
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

describe("applyAnthropicPayloadPolicyToParams message anchors", () => {
  const model = { provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 };

  function historyPayload(): Record<string, unknown> {
    return {
      system: [{ type: "text", text: "Stable system prompt." }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Earlier stable question." }] },
        { role: "assistant", content: [{ type: "text", text: "Answer." }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "log chunk" }],
        },
        { role: "assistant", content: [{ type: "text", text: "Analyzing." }] },
        { role: "user", content: [{ type: "text", text: "Volatile latest question." }] },
      ],
    };
  }

  function markerAt(message: unknown): unknown {
    const content = (message as { content: Array<Record<string, unknown>> }).content;
    return (content[0] as { cache_control?: unknown }).cache_control;
  }

  it("anchors the previous user turn before the latest tool result when budget remains", () => {
    const payload = historyPayload();
    applyAnthropicPayloadPolicyToParams(
      payload,
      resolveAnthropicPayloadPolicy({
        ...model,
        cacheRetention: "short",
        enableCacheControl: true,
      }),
      new Set(),
    );

    const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
    // system: 1 marker; history budget: 3 -> previous user turn, latest tool
    // result, newest user turn (issue #147168: a reshaped newest message must
    // not invalidate the whole cached history).
    expect(markerAt(messages[0])).toEqual({ type: "ephemeral" });
    expect(markerAt(messages[2])).toEqual({ type: "ephemeral" });
    expect(markerAt(messages[4])).toEqual({ type: "ephemeral" });
  });

  it("keeps the tool-result-only fallback when a single history marker remains", () => {
    const payload = {
      system: [
        { type: "text", text: "Stable system prompt one." },
        { type: "text", text: "Stable system prompt two." },
      ],
      tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Investigate the cache writes." }] },
        { role: "assistant", content: [{ type: "text", text: "I'll inspect the logs." }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "log chunk" }],
        },
      ],
    };
    applyAnthropicPayloadPolicyToParams(
      payload,
      resolveAnthropicPayloadPolicy({
        ...model,
        cacheRetention: "short",
        enableCacheControl: true,
      }),
      new Set(),
    );

    const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(markerAt(messages[0])).toBeUndefined();
    expect(markerAt(messages[2])).toEqual({ type: "ephemeral" });
  });

  it("reserves the trailing tool result checkpoint when two user turns precede it", () => {
    const payload = {
      system: [
        { type: "text", text: "Stable system prompt.", cache_control: { type: "ephemeral" } },
      ],
      tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "First stable question." }] },
        { role: "assistant", content: [{ type: "text", text: "Working." }] },
        { role: "user", content: [{ type: "text", text: "Follow-up question." }] },
        { role: "assistant", content: [{ type: "text", text: "Checking." }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "log chunk" }],
        },
      ],
    };

    // 1 system marker + 1 tool marker leave two history slots.
    applyAnthropicRequestCacheControl(payload, { type: "ephemeral" }, true, new Set());

    const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
    // The advancing tool-result anchor keeps its slot and the newest user
    // turn takes the remaining one; the older user turn is left unmarked.
    expect(markerAt(messages[0])).toBeUndefined();
    expect(markerAt(messages[2])).toEqual({ type: "ephemeral" });
    expect(markerAt(messages[4])).toEqual({ type: "ephemeral" });
  });

  it("still anchors earlier user turns once the tool result slot is reserved", () => {
    const payload = {
      system: [{ type: "text", text: "Stable system prompt." }],
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "First stable question." }] },
        { role: "assistant", content: [{ type: "text", text: "Working." }] },
        { role: "user", content: [{ type: "text", text: "Follow-up question." }] },
        { role: "assistant", content: [{ type: "text", text: "Checking." }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "log chunk" }],
        },
      ],
    };

    // Full four-marker budget: trailing tool result plus both user turns.
    applyAnthropicRequestCacheControl(payload, { type: "ephemeral" }, true, new Set());

    const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(markerAt(messages[0])).toEqual({ type: "ephemeral" });
    expect(markerAt(messages[2])).toEqual({ type: "ephemeral" });
    expect(markerAt(messages[4])).toEqual({ type: "ephemeral" });
  });
});
