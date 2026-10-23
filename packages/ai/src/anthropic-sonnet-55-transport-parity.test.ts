import type { Context } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { capturePaths } from "./anthropic-parity.test-support.js";
import {
  anthropicModel,
  assistantMessage,
  registerParityHostLifecycle,
  textBlock,
  userMessage,
} from "./provider-transport-parity.test-support.js";

describe("Anthropic 5.5 transport parity", () => {
  registerParityHostLifecycle();

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
  ] as const)(
    "sends %s %s thinking at %s effort (alias=%s)",
    async (family, reasoning, effort, alias) => {
      const haiku = family === "haiku";
      const sonnet = family === "sonnet";
      const toolChoice =
        haiku || reasoning === "off"
          ? { type: "tool" as const, name: "lookup" }
          : reasoning === "max"
            ? "auto"
            : "any";
      const display = reasoning === "max" ? "omitted" : "summarized";
      const id = `claude-${family}-5-5`;
      const model = haiku
        ? { id, maxTokens: 128_000 }
        : alias
          ? { id: "production-claude", params: { canonicalModelId: id }, reasoning: false }
          : { id };
      const betweenTools = sonnet && reasoning === "off";
      for await (const { payload, headers } of capturePaths({
        model,
        reasoning,
        toolChoice,
        thinkingDisplay: haiku ? undefined : display,
        temperature: 0.2,
      })) {
        const beta = headers.get("anthropic-beta");
        expect(payload).toMatchObject(
          haiku
            ? { max_tokens: 128_000, tool_choice: { type: "tool", name: "lookup" } }
            : { model: model.id, tool_choice: { type: "auto" } },
        );
        if (betweenTools || (haiku && reasoning === "off")) {
          expect(payload.thinking).toEqual({ type: betweenTools ? "between_tools" : "disabled" });
          expect(payload).not.toHaveProperty("output_config");
          if (betweenTools) {
            expect(beta).not.toContain("thinking-binding-controls-2026-08-01");
          }
        } else {
          expect(payload.output_config).toEqual({ effort });
          if (sonnet) {
            expect(payload.thinking).toEqual({
              type: "adaptive",
              display,
              block_binding: { prefix_mismatch_behavior: "drop_block" },
            });
            expect(payload.fallbacks).toBe("default");
            expect(beta).toContain("thinking-binding-controls-2026-08-01");
            expect(beta).toContain("server-side-fallback-2026-07-01");
            expect(payload).not.toHaveProperty("speed");
          } else {
            expect(payload.thinking).toMatchObject(
              haiku ? { type: "adaptive" } : { type: "adaptive", display },
            );
          }
        }
        expect(payload).not.toHaveProperty("temperature");
        if (sonnet) {
          expect(payload).not.toHaveProperty("service_tier");
        }
        if (haiku) {
          for (const key of ["service_tier", "fallbacks", "speed"]) {
            expect(payload).not.toHaveProperty(key);
          }
          if (reasoning !== "off") {
            expect(payload.thinking).not.toHaveProperty("budget_tokens");
          }
          expect(beta ?? "").not.toContain("server-side-fallback");
        }
      }
    },
  );

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
    const context: Context = {
      messages: [
        userMessage("Start."),
        assistantMessage(
          { ...anthropicModel, id: source },
          [
            { type: "thinking", thinking, thinkingSignature: "synthetic-signature" },
            textBlock("Visible answer."),
          ],
          { timestamp: 2 },
        ),
        userMessage("Continue.", { timestamp: 3 }),
      ],
    };
    for await (const { payload } of capturePaths({
      model: { id: target },
      context,
    })) {
      expect(payload.messages).toMatchObject([
        { role: "user" },
        {
          role: "assistant",
          content: [
            ...(preserve ? [{ type: "thinking", thinking, signature: "synthetic-signature" }] : []),
            { type: "text", text: "Visible answer." },
          ],
        },
        { role: "user" },
      ]);
    }
  });
});
