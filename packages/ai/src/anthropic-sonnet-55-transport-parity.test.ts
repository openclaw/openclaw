import type { Context } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { createZeroUsage } from "./usage.test-support.js";

describe("Anthropic Sonnet 5.5 transport parity", () => {
  registerParityHostLifecycle();

  it.each([
    { model: { id: "claude-sonnet-5-5" }, reasoning: undefined, effort: "high" },
    {
      model: {
        id: "production-claude",
        params: { canonicalModelId: "claude-sonnet-5-5" },
        reasoning: false,
      },
      reasoning: undefined,
      effort: "high",
    },
    { model: { id: "claude-sonnet-5-5" }, reasoning: "minimal", effort: "low" },
    { model: { id: "claude-sonnet-5-5" }, reasoning: "xhigh", effort: "xhigh" },
    { model: { id: "claude-sonnet-5-5" }, reasoning: "max", effort: "max" },
  ] as const)(
    "uses adaptive thinking at $effort for $model.id ($reasoning)",
    async ({ model, reasoning, effort }) => {
      for (const implementation of ["provider", "transport"] as const) {
        const { payload, headers } = await captureAnthropicRequest(implementation, {
          model,
          reasoning,
          toolChoice: "any",
          temperature: 0.2,
        });
        expect(payload).toMatchObject({
          model: model.id,
          output_config: { effort },
          tool_choice: { type: "auto" },
          fallbacks: "default",
        });
        expect(payload.thinking).toEqual({
          type: "adaptive",
          display: "summarized",
          block_binding: { prefix_mismatch_behavior: "drop_block" },
        });
        expect(headers.get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01");
        expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
        expect(payload).not.toHaveProperty("temperature");
        expect(payload).not.toHaveProperty("service_tier");
        expect(payload).not.toHaveProperty("speed");
      }
    },
  );

  it.each([
    { model: { id: "claude-sonnet-5-5" }, toolChoice: "any" },
    {
      model: {
        id: "production-claude",
        params: { canonicalModelId: "claude-sonnet-5-5" },
        reasoning: false,
      },
      toolChoice: { type: "tool", name: "lookup" },
    },
  ] as const)(
    "uses only between_tools and relaxes forced tools for $model.id",
    async ({ model, toolChoice }) => {
      for (const implementation of ["provider", "transport"] as const) {
        const { payload, headers } = await captureAnthropicRequest(implementation, {
          model,
          reasoning: "off",
          toolChoice,
          thinkingDisplay: "summarized",
          temperature: 0.2,
        });
        expect(payload.thinking).toEqual({ type: "between_tools" });
        expect(payload.tool_choice).toEqual({ type: "auto" });
        expect(payload).not.toHaveProperty("output_config");
        expect(payload).not.toHaveProperty("temperature");
        expect(payload).not.toHaveProperty("service_tier");
        expect(headers.get("anthropic-beta")).not.toContain("thinking-binding-controls-2026-08-01");
      }
    },
  );

  it.each([
    { source: "claude-sonnet-5-5", target: "claude-sonnet-5-5", preserve: true },
    { source: "claude-sonnet-5", target: "claude-sonnet-5-5", preserve: true },
    { source: "claude-opus-4-8", target: "claude-sonnet-5-5", preserve: true },
    { source: "claude-opus-5", target: "claude-sonnet-5-5", preserve: false },
    { source: "claude-opus-5-5", target: "claude-sonnet-5-5", preserve: false },
    { source: "claude-fable-5-1", target: "claude-sonnet-5-5", preserve: false },
    { source: "claude-mythos-5-1", target: "claude-sonnet-5-5", preserve: false },
    { source: "claude-sonnet-5-5", target: "claude-sonnet-5", preserve: false },
    { source: "claude-sonnet-5-5", target: "claude-opus-5-5", preserve: false },
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
