import { describe, expect, it, vi } from "vitest";
import { capturePaths } from "./anthropic-parity.test-support.js";
import {
  anthropicEvents,
  captureAnthropicRequest,
  context,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

const clearingEdit = (trigger = 60_000, clearAtLeast = 12_500, exclude_tools: string[] = []) => ({
  type: "clear_tool_uses_20250919",
  trigger: { type: "input_tokens", value: trigger },
  keep: { type: "tool_uses", value: 3 },
  clear_at_least: { type: "input_tokens", value: clearAtLeast },
  exclude_tools,
  clear_tool_inputs: false,
});
const contextBeta = "context-management-2025-06-27";
type CaptureOptions = NonNullable<Parameters<typeof capturePaths>[0]>;
const transportApi = "openclaw-anthropic-messages-transport";

describe("Anthropic server context management parity", () => {
  registerParityHostLifecycle();

  it.each<[string, CaptureOptions, boolean, number?, ("proxy" | "transport")?]>([
    ["default endpoint", { model: { baseUrl: undefined } }, true],
    ["OAuth", { apiKey: "sk-ant-oat01-synthetic" }, false],
    ["Foundry", { model: { provider: "microsoft-foundry" } }, false],
    ["environment proxy", { model: { baseUrl: undefined } }, false, 60_000, "proxy"],
    ["small window", { model: { contextWindow: 100_000 }, reasoning: "off" }, true, 50_000],
    ["transport alias", { transportApi }, true, 60_000, "transport"],
  ])("gates tool clearing for %s", async (_name, options, enabled, trigger, mode) => {
    if (mode === "proxy") {
      vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example/v1");
    }
    for await (const { payload, headers } of capturePaths(
      { ...options, cacheTtlPruning: {} },
      mode === "transport",
    )) {
      expect(payload.context_management).toEqual(
        enabled ? { edits: [clearingEdit(trigger ?? 60_000)] } : undefined,
      );
      expect(headers.get("anthropic-beta")?.includes(contextBeta) ?? false).toBe(enabled);
      if (options.reasoning === "off") {
        expect(headers.get("anthropic-beta") ?? "").not.toContain("thinking-binding-controls");
      }
    }
  });

  it("derives thresholds, tool exclusions, and clearing-before-compaction order", async () => {
    const tools = context.tools.flatMap((tool) =>
      ["lookup", "read", "write", "exec", "search", "special+tool"].map((name) =>
        Object.assign({}, tool, { name }),
      ),
    );
    for await (const { payload, headers } of capturePaths({
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
    })) {
      expect(payload.context_management).toEqual({
        edits: [
          clearingEdit(300_000, 50_000, ["exec", "retired_tool", "search", "write"]),
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 650_000 },
            instructions: expect.stringContaining("Do not call any tools"),
          },
        ],
      });
      expect(headers.get("anthropic-beta")).toContain("synthetic-beta");
      expect(headers.get("anthropic-beta")).toContain(contextBeta);
    }
  });

  it("logs bounded aggregate clearing counts from the final message delta", async () => {
    const cleared = (cleared_tool_uses: number, cleared_input_tokens: number) => ({
      type: "clear_tool_uses_20250919",
      cleared_tool_uses,
      cleared_input_tokens,
    });
    const applied_edits = [
      cleared(8, 50_000),
      cleared(2, 5_000),
      { type: "future", content: "must not log" },
    ];
    const events = anthropicEvents.map((event) =>
      event.type === "message_delta"
        ? Object.assign({}, event, { context_management: { applied_edits } })
        : event,
    );
    for await (const { info, implementation } of capturePaths({ events })) {
      expect(info).toEqual([
        "server-side context edit: cleared 10 tool results (55000 input tokens)",
      ]);
      const empty = await captureAnthropicRequest(implementation);
      expect(empty.info).toEqual([]);
    }
  });
});
