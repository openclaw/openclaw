import type { Context, Model, UserMessage } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anthropicModel,
  captureAnthropicRequest,
  context,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import * as modelContract from "./providers/anthropic-model-contract.js";
import { createZeroUsage } from "./usage.test-support.js";

function appendToolRound(messages: Context["messages"], model: Model, round: number) {
  const ids = [`call_${round}_a`, `call_${round}_b`];
  messages.push({
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: round * 2,
    stopReason: "toolUse",
    usage: createZeroUsage(),
    content: ids.map((id) => ({
      type: "toolCall",
      id,
      name: "lookup",
      arguments: { query: id },
    })),
  });
  messages.push(
    ...ids.map((id) => ({
      role: "toolResult" as const,
      toolCallId: id,
      toolName: "lookup",
      timestamp: round * 2 + 1,
      isError: false,
      content: [{ type: "text" as const, text: `Answer ${id}` }],
    })),
  );
}

describe("Anthropic runtime-context cache lifecycle", () => {
  registerParityHostLifecycle();
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { retained: false, blocks: false, cacheRetention: "short" },
    { retained: false, blocks: true, cacheRetention: "long" },
    { retained: true, blocks: false, cacheRetention: "short" },
    { retained: true, blocks: true, cacheRetention: "long" },
  ] as const)(
    "preserves reusable prefixes through tool loops and a new turn: %j",
    async ({ retained, blocks, cacheRetention }) => {
      const model = anthropicModel;
      if (retained) {
        // Model classification has its own contract tests; exercise retained replay
        // without coupling this cache regression to a particular model generation.
        vi.spyOn(modelContract, "bindsClaudeThinkingPrefix").mockReturnValue(true);
      }
      const cacheControl = {
        type: "ephemeral",
        ...(cacheRetention === "long" ? { ttl: "1h" } : {}),
      };
      const carrier: UserMessage = {
        role: "user",
        content: blocks ? [{ type: "text", text: "Runtime context" }] : "Runtime context",
        timestamp: 1,
        runtimeContextCarrier: true,
      };
      for (const implementation of ["provider", "transport"] as const) {
        const messages: Context["messages"] = [
          { role: "user", content: "", timestamp: 0 },
          { role: "user", content: [{ type: "text", text: " " }], timestamp: 0 },
          { role: "user", content: "Question", timestamp: 1 },
          ...(retained ? [carrier] : []),
        ];
        let previousPrefix: unknown[] = [];
        for (let round = 0; round < 3; round++) {
          if (round > 0) {
            appendToolRound(messages, model, round);
          }
          const { payload } = await captureAnthropicRequest(implementation, {
            model,
            cacheRetention,
            context: { ...context, messages: retained ? messages : [...messages, carrier] },
          });
          const wire = payload.messages as Array<{ role: string; content: unknown }>;
          const stable = retained ? wire : wire.slice(0, -1);
          if (!retained) {
            expect(wire.at(-1)).toEqual({ role: "user", content: carrier.content });
          } else {
            expect(wire[1]?.content).toEqual([
              { type: "text", text: "Runtime context", cache_control: cacheControl },
            ]);
          }
          expect(stable.at(-1)?.content).toEqual(
            round === 0
              ? [
                  {
                    type: "text",
                    text: retained ? "Runtime context" : "Question",
                    cache_control: cacheControl,
                  },
                ]
              : [
                  expect.objectContaining({ type: "tool_result", tool_use_id: `call_${round}_a` }),
                  expect.objectContaining({
                    type: "tool_result",
                    tool_use_id: `call_${round}_b`,
                    cache_control: cacheControl,
                  }),
                ],
          );
          // Checkpoint metadata advances; the content preceding it must remain reusable.
          const prefix = JSON.parse(
            JSON.stringify(stable, (key, value) => (key === "cache_control" ? undefined : value)),
          );
          expect(prefix.slice(0, previousPrefix.length)).toEqual(previousPrefix);
          previousPrefix = prefix;
          expect(JSON.stringify(payload).match(/"cache_control":/g)?.length).toBeLessThanOrEqual(4);
        }

        messages.push(
          {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: 8,
            stopReason: "stop",
            usage: createZeroUsage(),
            content: [{ type: "text", text: "Done" }],
          },
          { role: "user", content: "Next question", timestamp: 9 },
          { ...carrier, timestamp: 10 },
        );
        const { payload } = await captureAnthropicRequest(implementation, {
          model,
          cacheRetention,
          context: { ...context, messages },
        });
        const wire = payload.messages as Array<{ content: unknown }>;
        expect(wire.at(retained ? -1 : -2)?.content).toEqual([
          {
            type: "text",
            text: retained ? "Runtime context" : "Next question",
            cache_control: cacheControl,
          },
        ]);
        if (!retained) {
          expect(wire.at(-1)?.content).toEqual(carrier.content);
        }
      }
    },
  );
});
