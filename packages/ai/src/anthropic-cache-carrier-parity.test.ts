import type { Context, Model, UserMessage } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { createFailureMessage } from "../../agent-core/src/turn-interruption.js";
import {
  anthropicModel,
  captureAnthropicRequest,
  context,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "./replay-turn-classification.js";
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

  it.each([false, true])(
    "sends operator context with system authority (turn-scoped=%s)",
    async (turnScoped) => {
      const messages: Context["messages"] = [
        { role: "user", content: "Question", timestamp: 1 },
        {
          role: "user",
          content: "Prompt update",
          timestamp: 2,
          operatorMessage: { turnScoped: false },
        },
        ...(turnScoped
          ? [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: "Runtime facts" }],
                timestamp: 3,
                operatorMessage: { turnScoped: true },
              },
            ]
          : []),
      ];
      for (const implementation of ["provider", "transport"] as const) {
        const { payload, headers } = await captureAnthropicRequest(implementation, {
          model: { id: "claude-opus-5" },
          cacheRetention: "none",
          headers: { "anthropic-beta": "custom-beta" },
          context: { ...context, messages },
        });
        expect(payload.messages).toEqual([
          { role: "user", content: "Question" },
          { role: "system", content: [{ type: "text", text: "Prompt update" }] },
          ...(turnScoped
            ? [
                {
                  role: "system",
                  content: [{ type: "text", text: "Runtime facts" }],
                  clear_at: "next_user_message",
                },
              ]
            : []),
        ]);
        const betas = headers.get("anthropic-beta")?.split(",");
        expect(betas).toContain("custom-beta");
        expect(betas?.includes("mid-conversation-system-clear-at-2026-08-21")).toBe(turnScoped);
      }
    },
  );

  it("keeps tool-result scaffolding ahead of a mid-run operator update", async () => {
    const model = { ...anthropicModel, id: "claude-opus-5" };
    const messages: Context["messages"] = [{ role: "user", content: "Question", timestamp: 1 }];
    appendToolRound(messages, model, 1);
    const toolTurn = messages[1];
    if (toolTurn?.role === "assistant") {
      toolTurn.content.unshift({
        type: "thinking",
        thinking: "Use lookup",
        thinkingSignature: "signed-tool-turn",
      });
    }
    messages.push({
      role: "user",
      content: "Permission changed",
      timestamp: 4,
      operatorMessage: { turnScoped: false },
    });
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model,
        context: { ...context, messages },
        cacheRetention: "none",
        reasoning: "off",
      });
      expect(payload.messages).toMatchObject([
        { role: "user" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Use lookup", signature: "signed-tool-turn" },
            { type: "tool_use" },
            { type: "tool_use" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1_a" },
            { type: "tool_result", tool_use_id: "call_1_b" },
          ],
        },
        { role: "system", content: [{ type: "text", text: "Permission changed" }] },
      ]);
    }
  });

  it.each(["missing", "error", "aborted", "stop"] as const)(
    "preserves historical operator positions before the next user with a %s assistant",
    async (ending) => {
      const model = { ...anthropicModel, id: "claude-opus-5" };
      const messages: Context["messages"] = [
        { role: "user", content: "First question", timestamp: 1 },
        {
          role: "user",
          content: "First turn facts",
          timestamp: 2,
          operatorMessage: { turnScoped: true },
        },
      ];
      const nextMessages: Context["messages"] = [...messages];
      if (ending !== "missing") {
        const assistant = createFailureMessage(
          model,
          new Error("Interrupted"),
          ending === "aborted",
        );
        if (ending === "stop") {
          assistant.stopReason = "stop";
          assistant.content = [{ type: "text", text: "First answer" }];
        }
        nextMessages.push(assistant);
      }
      nextMessages.push(
        { role: "user", content: "Second question", timestamp: 4 },
        {
          role: "user",
          content: "Second turn facts",
          timestamp: 5,
          operatorMessage: { turnScoped: true },
        },
      );
      for (const implementation of ["provider", "transport"] as const) {
        const initial = await captureAnthropicRequest(implementation, {
          model,
          cacheRetention: "none",
          context: { ...context, messages },
        });
        const replay = await captureAnthropicRequest(implementation, {
          model,
          cacheRetention: "none",
          context: { ...context, messages: nextMessages },
        });
        if (!Array.isArray(initial.payload.messages)) {
          throw new Error("Expected initial messages");
        }
        expect(replay.payload.system).toEqual(initial.payload.system);
        expect(replay.payload.messages).toEqual([
          ...initial.payload.messages,
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: ending === "stop" ? "First answer" : STREAM_ERROR_FALLBACK_TEXT,
              },
            ],
          },
          { role: "user", content: "Second question" },
          {
            role: "system",
            content: [{ type: "text", text: "Second turn facts" }],
            clear_at: "next_user_message",
          },
        ]);
      }
    },
  );

  it.each([
    { model: { id: "claude-opus-5" }, apiKey: "test-sk-ant-oat-fixture" },
    { model: { id: "claude-opus-5", baseUrl: "https://proxy.example.test" } },
    { model: { id: "claude-sonnet-4-6" } },
  ])("preserves ordinary user context on an ineligible route: %j", async (route) => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        ...route,
        cacheRetention: "none",
        context: {
          ...context,
          messages: [
            { role: "user", content: "Question", timestamp: 1 },
            {
              role: "user",
              content: "Runtime facts",
              timestamp: 2,
              operatorMessage: { turnScoped: true },
            },
            { role: "user", content: "Next question", timestamp: 3 },
          ],
        },
      });
      expect(payload.messages).toEqual([
        { role: "user", content: "Question" },
        { role: "user", content: "Runtime facts" },
        { role: "user", content: "Next question" },
      ]);
      expect(headers.get("anthropic-beta")?.split(",") ?? []).not.toContain(
        "mid-conversation-system-clear-at-2026-08-21",
      );
    }
  });

  it.each([
    {
      id: "claude-fable-5-1",
      retained: false,
      carrierRetained: false,
      blocks: false,
      cacheRetention: "short",
    },
    {
      id: "claude-opus-5-5",
      retained: false,
      carrierRetained: false,
      blocks: true,
      cacheRetention: "long",
    },
    {
      id: "claude-sonnet-4-6",
      retained: true,
      carrierRetained: true,
      blocks: false,
      cacheRetention: "short",
    },
    {
      id: "claude-sonnet-4-6",
      retained: true,
      carrierRetained: true,
      blocks: true,
      cacheRetention: "long",
    },
    {
      id: "claude-fable-5-1",
      retained: true,
      carrierRetained: undefined,
      blocks: false,
      cacheRetention: "short",
    },
    {
      id: "claude-opus-5-5",
      retained: true,
      carrierRetained: undefined,
      blocks: true,
      cacheRetention: "long",
    },
  ] as const)(
    "preserves reusable prefixes through tool loops and a new turn: %j",
    async ({ id, retained, carrierRetained, blocks, cacheRetention }) => {
      const model = { ...anthropicModel, id };
      const cacheControl = {
        type: "ephemeral",
        ...(cacheRetention === "long" ? { ttl: "1h" } : {}),
      };
      const carrier: UserMessage = {
        role: "user",
        content: blocks ? [{ type: "text", text: "Runtime context" }] : "Runtime context",
        timestamp: 1,
        runtimeContextCarrier: true,
        ...(carrierRetained === undefined
          ? {}
          : { runtimeContextCarrierRetained: carrierRetained }),
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
