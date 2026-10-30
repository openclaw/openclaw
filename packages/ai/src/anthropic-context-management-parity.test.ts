import { expect, it, vi } from "vitest";
import { capturePaths } from "./anthropic-parity.test-support.js";
import {
  anthropicEvents,
  anthropicModel,
  assistantMessage,
  captureAnthropicRequest,
  context,
  registerParityHostLifecycle,
  textBlock,
  userMessage,
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
    expect((await captureAnthropicRequest(implementation)).info).toEqual([]);
  }
});

it.each([
  ["haiku", undefined, "medium", false],
  ["haiku", "minimal", "low", false],
  ["haiku", "xhigh", "xhigh", false],
  ["haiku", "max", "max", false],
  ["haiku", "off", undefined, false],
  ["opus", undefined, "medium", false],
  ["opus", "off", "low", true],
  ["opus", "max", "max", false],
  ["sonnet", undefined, "high", true],
  ["sonnet", "minimal", "low", false],
  ["sonnet", "xhigh", "xhigh", false],
  ["sonnet", "off", undefined, true],
] as const)("%s %s uses %s effort (alias=%s)", async (family, reasoning, effort, alias) => {
  const haiku = family === "haiku";
  const sonnet = family === "sonnet";
  const forcedTool = { type: "tool" as const, name: "lookup" };
  const toolChoice =
    haiku || reasoning === "off" ? forcedTool : reasoning === "max" ? "auto" : "any";
  const display = reasoning === "max" ? "omitted" : "summarized";
  const id = `claude-${family}-5-5`;
  const model = alias
    ? { id: "production-claude", params: { canonicalModelId: id }, reasoning: false }
    : { id, ...(haiku && { maxTokens: 128_000 }) };
  const betweenTools = sonnet && reasoning === "off";
  const adaptive = !(betweenTools || (haiku && reasoning === "off"));
  for await (const { payload, headers } of capturePaths({
    model,
    reasoning,
    toolChoice,
    thinkingDisplay: haiku ? undefined : display,
    temperature: 0.2,
  })) {
    const beta = headers.get("anthropic-beta");
    expect(payload).toMatchObject({
      ...(haiku ? { max_tokens: 128_000 } : { model: model.id }),
      tool_choice: haiku ? { type: "tool", name: "lookup" } : { type: "auto" },
    });
    expect(payload.output_config).toEqual(adaptive ? { effort } : undefined);
    expect(payload.thinking).toEqual(
      !adaptive
        ? { type: betweenTools ? "between_tools" : "disabled" }
        : sonnet
          ? {
              type: "adaptive",
              display,
              block_binding: { prefix_mismatch_behavior: "drop_block" },
            }
          : expect.objectContaining(haiku ? { type: "adaptive" } : { type: "adaptive", display }),
    );
    const omitted = ["temperature"];
    if (sonnet) {
      omitted.push("service_tier", ...(adaptive ? ["speed"] : []));
      expect(beta?.includes("thinking-binding-controls-2026-08-01") ?? false).toBe(adaptive);
      if (adaptive) {
        expect(payload.fallbacks).toBe("default");
        expect(beta).toContain("server-side-fallback-2026-07-01");
      }
    }
    if (haiku) {
      omitted.push("service_tier", "fallbacks", "speed");
      if (reasoning !== "off") {
        expect(payload.thinking).not.toHaveProperty("budget_tokens");
      }
      expect(beta ?? "").not.toContain("server-side-fallback");
    }
    for (const key of omitted) {
      expect(payload).not.toHaveProperty(key);
    }
  }
});

it.each([
  { source: "claude-haiku-5-5", target: "claude-haiku-5-5", preserve: true },
  { source: "claude-haiku-5-5", target: "claude-haiku-4-5", preserve: false },
  { source: "claude-haiku-4-5", target: "claude-haiku-5-5", preserve: false },
  { source: "claude-haiku-5-5", target: "claude-fable-5-1", preserve: false },
  { source: "claude-haiku-5-5", target: "claude-sonnet-5-5", preserve: false },
  { source: "claude-opus-5-5", target: "claude-opus-5-5", preserve: true },
  { source: "claude-fable-5-1", target: "claude-opus-5-5", preserve: false },
  { source: "claude-opus-5-5", target: "claude-opus-5", preserve: false },
  { source: "claude-sonnet-5-5", target: "claude-sonnet-5-5", preserve: true },
  { source: "claude-sonnet-5", target: "claude-sonnet-5-5", preserve: true },
  { source: "claude-opus-4-8", target: "claude-sonnet-5-5", preserve: true },
  { source: "claude-opus-5-5", target: "claude-sonnet-5-5", preserve: false },
  { source: "claude-mythos-5-1", target: "claude-sonnet-5-5", preserve: false },
  { source: "claude-sonnet-5-5", target: "claude-sonnet-5", preserve: false },
  { source: "claude-sonnet-5-5", target: "claude-fable-5-1", preserve: false },
])("replays thinking from $source to $target", async ({ source, target, preserve }) => {
  const thinking = "  signed thinking\r\nwith exact whitespace  ";
  for await (const { payload } of capturePaths({
    model: { id: target },
    context: {
      messages: [
        userMessage("Start."),
        assistantMessage({ ...anthropicModel, id: source }, [
          { type: "thinking", thinking, thinkingSignature: "synthetic-signature" },
          textBlock("Visible answer."),
        ]),
        userMessage("Continue."),
      ],
    },
  })) {
    const expected: Record<string, string>[] = [{ type: "text", text: "Visible answer." }];
    if (preserve) {
      expected.unshift({ type: "thinking", thinking, signature: "synthetic-signature" });
    }
    expect(payload).toHaveProperty(
      "messages.1.content",
      expected.map((block) => expect.objectContaining(block)),
    );
  }
});
