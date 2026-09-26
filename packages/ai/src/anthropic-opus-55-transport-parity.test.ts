import type { Context } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { createZeroUsage } from "./usage.test-support.js";

describe("Anthropic Opus 5.5 transport parity", () => {
  registerParityHostLifecycle();

  it.each([
    {
      name: "defaults to medium and relaxes any-tool selection",
      model: { id: "claude-opus-5-5" },
      reasoning: undefined,
      toolChoice: "any",
      effort: "medium",
    },
    {
      name: "keeps adaptive thinking for off on deployment aliases",
      model: {
        id: "production-claude",
        params: { canonicalModelId: "claude-opus-5-5" },
        reasoning: false,
      },
      reasoning: "off",
      toolChoice: { type: "tool", name: "lookup" },
      effort: "low",
    },
    {
      name: "preserves explicit maximum effort",
      model: { id: "claude-opus-5-5" },
      reasoning: "max",
      toolChoice: "auto",
      effort: "max",
    },
    {
      name: "keeps the Opus 5 high default",
      model: { id: "claude-opus-5" },
      reasoning: undefined,
      toolChoice: "auto",
      effort: "high",
    },
  ] as const)("$name", async ({ model, reasoning, toolChoice, effort }) => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model,
        reasoning,
        toolChoice,
        temperature: 0.2,
      });
      expect(payload).toMatchObject({
        model: model.id,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
        tool_choice: { type: "auto" },
      });
      expect(payload).not.toHaveProperty("temperature");
    }
  });

  it("honors omitted thinking display in both request paths", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model: { id: "claude-opus-5-5" },
        thinkingDisplay: "omitted",
      });
      expect(payload.thinking).toMatchObject({ type: "adaptive", display: "omitted" });
    }
  });

  it.each([
    { source: "claude-opus-5-5", target: "claude-opus-5-5", preserve: true },
    { source: "claude-fable-5-1", target: "claude-opus-5-5", preserve: false },
    { source: "claude-mythos-5-1", target: "claude-opus-5-5", preserve: false },
    { source: "claude-opus-5-5", target: "claude-opus-5", preserve: false },
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
