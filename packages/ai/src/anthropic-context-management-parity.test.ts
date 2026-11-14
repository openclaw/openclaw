import { describe, expect, it, vi } from "vitest";
import {
  anthropicEvents,
  captureAnthropicRequest,
  context,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

describe("Anthropic server context management parity", () => {
  registerParityHostLifecycle();

  it.each([
    { name: "default endpoint", model: { baseUrl: undefined }, enabled: true },
    { name: "OAuth", apiKey: "sk-ant-oat01-synthetic", enabled: false },
    { name: "Foundry", model: { provider: "microsoft-foundry" }, enabled: false },
  ])("gates tool clearing for $name in both request paths", async ({ enabled, ...options }) => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        ...options,
        cacheTtlPruning: {},
      });
      expect(payload.context_management).toEqual(
        enabled
          ? {
              edits: [
                {
                  type: "clear_tool_uses_20250919",
                  trigger: { type: "input_tokens", value: 60_000 },
                  keep: { type: "tool_uses", value: 3 },
                  clear_at_least: { type: "input_tokens", value: 12_500 },
                  exclude_tools: [],
                  clear_tool_inputs: false,
                },
              ],
            }
          : undefined,
      );
      expect(
        headers.get("anthropic-beta")?.includes("context-management-2025-06-27") ?? false,
      ).toBe(enabled);
    }
  });

  it("keeps clearing enabled after simple dispatch selects the Anthropic transport alias", async () => {
    const { payload, headers } = await captureAnthropicRequest("transport", {
      transportApi: "openclaw-anthropic-messages-transport",
      cacheTtlPruning: {},
    });
    expect(payload.context_management).toEqual({
      edits: [expect.objectContaining({ type: "clear_tool_uses_20250919" })],
    });
    expect(headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
  });

  it("clamps small-window thresholds and enables clearing without thinking", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        model: { contextWindow: 100_000 },
        reasoning: "off",
        cacheTtlPruning: {},
      });
      expect(payload.context_management).toEqual({
        edits: [
          expect.objectContaining({
            trigger: { type: "input_tokens", value: 50_000 },
            clear_at_least: { type: "input_tokens", value: 12_500 },
          }),
        ],
      });
      expect(headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
      expect(headers.get("anthropic-beta") ?? "").not.toContain("thinking-binding-controls");
    }
  });

  it("derives thresholds, tool exclusions, and clearing-before-compaction order", async () => {
    const tools = context.tools.flatMap((tool) =>
      ["lookup", "read", "write", "exec", "search", "special+tool"].map((name) =>
        Object.assign({}, tool, { name }),
      ),
    );
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        model: { contextWindow: 1_000_000 },
        context: { ...context, tools },
        cacheTtlPruning: {
          tools: {
            allow: ["READ", "look*", "write", "special+*"],
            deny: ["write", "ex*", "retired_tool"],
          },
        },
        anthropicServerCompaction: true,
        anthropicCompactThreshold: 650_000,
        headers: { "Anthropic-Beta": "synthetic-beta" },
      });
      expect(payload.context_management).toEqual({
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: 300_000 },
            keep: { type: "tool_uses", value: 3 },
            clear_at_least: { type: "input_tokens", value: 50_000 },
            exclude_tools: ["exec", "retired_tool", "search", "write"],
            clear_tool_inputs: false,
          },
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 650_000 },
            instructions: expect.stringContaining("Do not call any tools"),
          },
        ],
      });
      expect(headers.get("anthropic-beta")).toContain("synthetic-beta");
      expect(headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
    }
  });

  it("respects the effective environment endpoint", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example/v1");
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        model: { baseUrl: undefined },
        cacheTtlPruning: {},
      });
      expect(payload.context_management).toBeUndefined();
      expect(headers.get("anthropic-beta") ?? "").not.toContain("context-management-2025-06-27");
    }
  });

  it("logs bounded aggregate clearing counts from the final message delta", async () => {
    const events = anthropicEvents.map((event) =>
      event.type === "message_delta"
        ? Object.assign({}, event, {
            context_management: {
              applied_edits: [
                {
                  type: "clear_tool_uses_20250919",
                  cleared_tool_uses: 8,
                  cleared_input_tokens: 50_000,
                },
                {
                  type: "clear_tool_uses_20250919",
                  cleared_tool_uses: 2,
                  cleared_input_tokens: 5_000,
                },
                { type: "future", content: "must not log" },
              ],
            },
          })
        : event,
    );
    for (const implementation of ["provider", "transport"] as const) {
      const { info } = await captureAnthropicRequest(implementation, { events });
      expect(info).toEqual([
        "server-side context edit: cleared 10 tool results (55000 input tokens)",
      ]);
      const empty = await captureAnthropicRequest(implementation);
      expect(empty.info).toEqual([]);
    }
  });
});

describe("strict unknown Claude request parity", () => {
  registerParityHostLifecycle();

  it("keeps the full output cap, mandatory thinking, default sampling and no prefill", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model: { id: "claude-zzz-9-9", maxTokens: 128_000 },
        reasoning: "off",
        temperature: 0.4,
        context: {
          ...context,
          messages: [
            ...context.messages,
            {
              role: "assistant",
              api: "anthropic-messages",
              provider: "anthropic",
              model: "claude-zzz-9-9",
              content: [{ type: "text", text: "partial answer" }],
              stopReason: "stop",
              timestamp: 2,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          ],
        },
      });
      expect(payload.max_tokens).toBe(128_000);
      expect(payload.thinking).toEqual(expect.objectContaining({ type: "adaptive" }));
      expect(payload.temperature).toBeUndefined();
      expect(payload.messages).toEqual([expect.objectContaining({ role: "user" })]);
    }
  });

  it.each([
    { source: "claude-opus-5", target: "claude-fable-5-2", preserve: true },
    { source: "claude-fable-5-2", target: "claude-opus-5-5", preserve: false },
    { source: "claude-fable-5-2", target: "claude-zzz-9-9", preserve: false },
    { source: "claude-zzz-9-9", target: "claude-zzz-9-9", preserve: true },
  ])("replays thinking from $source to $target", async ({ source, target, preserve }) => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model: { id: target },
        context: {
          ...context,
          messages: [
            ...context.messages,
            {
              role: "assistant",
              api: "anthropic-messages",
              provider: "anthropic",
              model: source,
              content: [
                { type: "thinking", thinking: "signed thought", thinkingSignature: "signed-proof" },
                { type: "text", text: "answer" },
              ],
              stopReason: "stop",
              timestamp: 2,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
            { role: "user", content: "continue", timestamp: 3 },
          ],
        },
      });
      expect(JSON.stringify(payload.messages).includes('"type":"thinking"')).toBe(preserve);
    }
  });
});
