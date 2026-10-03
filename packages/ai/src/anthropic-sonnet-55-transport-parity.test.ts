import type { Context } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { createZeroUsage } from "./usage.test-support.js";

describe("Anthropic 5.5 transport parity", () => {
  registerParityHostLifecycle();

  it.each([
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
      const toolChoice =
        reasoning === "off"
          ? { type: "tool" as const, name: "lookup" }
          : reasoning === "max"
            ? "auto"
            : "any";
      const display = reasoning === "max" ? "omitted" : "summarized";
      const id = `claude-${family}-5-5`;
      const model = alias
        ? { id: "production-claude", params: { canonicalModelId: id }, reasoning: false }
        : { id };
      const betweenTools = family === "sonnet" && reasoning === "off";
      for (const implementation of ["provider", "transport"] as const) {
        const { payload, headers } = await captureAnthropicRequest(implementation, {
          model,
          reasoning,
          toolChoice,
          thinkingDisplay: display,
          temperature: 0.2,
        });
        expect(payload).toMatchObject({ model: model.id, tool_choice: { type: "auto" } });
        if (betweenTools) {
          expect(payload.thinking).toEqual({ type: "between_tools" });
          expect(payload).not.toHaveProperty("output_config");
          expect(headers.get("anthropic-beta")).not.toContain(
            "thinking-binding-controls-2026-08-01",
          );
        } else {
          expect(payload.output_config).toEqual({ effort });
          if (family === "sonnet") {
            expect(payload.thinking).toEqual({
              type: "adaptive",
              display,
              block_binding: { prefix_mismatch_behavior: "drop_block" },
            });
            expect(payload.fallbacks).toBe("default");
            expect(headers.get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01");
            expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
            expect(payload).not.toHaveProperty("speed");
          } else {
            expect(payload.thinking).toMatchObject({ type: "adaptive", display });
          }
        }
        expect(payload).not.toHaveProperty("temperature");
        if (family === "sonnet") {
          expect(payload).not.toHaveProperty("service_tier");
        }
      }
    },
  );

  it.each([
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
        { role: "user", content: "Start.", timestamp: 1 },
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: source,
          content: [
            { type: "thinking", thinking, thinkingSignature: "synthetic-signature" },
            { type: "text", text: "Visible answer." },
          ],
          stopReason: "stop",
          usage: createZeroUsage(),
          timestamp: 2,
        },
        { role: "user", content: "Continue.", timestamp: 3 },
      ],
    };
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model: { id: target },
        context,
      });
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
