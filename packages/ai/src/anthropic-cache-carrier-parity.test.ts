import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  RuntimeContextMessage,
  UserMessage,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { createFailureMessage } from "../../agent-core/src/turn-interruption.js";
import {
  anthropicModel,
  assistantMessage,
  captureAnthropicRequest,
  context,
  registerParityHostLifecycle,
  textBlock,
  userMessage,
} from "./provider-transport-parity.test-support.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "./replay-turn-classification.js";

function user(content: string, timestamp: number, turnScoped?: boolean): UserMessage {
  return userMessage(content, {
    timestamp,
    ...(turnScoped === undefined ? {} : { operatorMessage: { turnScoped } }),
  });
}

function assistant(
  model: Model,
  content: AssistantMessage["content"],
  timestamp = 1,
  stopReason: "stop" | "toolUse" = "stop",
): Message {
  return assistantMessage(model, content, { timestamp, stopReason });
}

const runtimeText = "OpenClaw runtime context:\nRuntime context";
const opusModel = { ...anthropicModel, id: "claude-opus-5" };

function captureMessages(
  implementation: "provider" | "transport",
  model: Partial<Model<"anthropic-messages">>,
  messages: Context["messages"],
  options: Parameters<typeof captureAnthropicRequest>[1] = {},
) {
  return captureAnthropicRequest(implementation, {
    cacheRetention: "none",
    ...options,
    model,
    context: { ...context, messages },
  });
}

function system(text: string, turnScoped = false) {
  return {
    role: "system",
    content: [textBlock(text)],
    ...(turnScoped ? { clear_at: "next_user_message" } : {}),
  };
}

function appendToolRound(messages: Context["messages"], model: Model, round: number) {
  const ids = [`call_${round}_a`, `call_${round}_b`];
  const calls = ids.map((id) => ({
    type: "toolCall" as const,
    id,
    name: "lookup",
    arguments: { query: id },
  }));
  messages.push(
    assistant(model, calls, round * 2, "toolUse"),
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

  it("preserves shipped carrier bytes before signed thinking through provider replay", async () => {
    const legacyText = [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "retained v2026.9.7 context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");
    const legacyCarrier = userMessage([textBlock(legacyText)], {
      timestamp: 2,
      runtimeContextCarrier: true,
      runtimeContextCarrierRetained: true,
    });
    const messages: Context["messages"] = [
      user("Original question", 1),
      legacyCarrier,
      assistant(
        anthropicModel,
        [
          { type: "thinking", thinking: "signed thought", thinkingSignature: "signature" },
          { type: "text", text: "Original answer" },
        ],
        3,
      ),
      user("Continue", 4),
    ];

    const { payload } = await captureMessages("provider", anthropicModel, messages, {
      cacheRetention: undefined,
    });
    const serialized = JSON.stringify(payload.messages);
    expect(serialized).toContain(JSON.stringify(legacyText).slice(1, -1));
    expect(serialized).not.toContain("OpenClaw runtime context:");
    expect(serialized).toContain("signature");
  });

  it("keeps mixed-media canonical carriers before steering out of the cache through transport replay", async () => {
    const carrier = userMessage(
      [
        textBlock("legacy plugin runtime context"),
        { type: "image", mimeType: "image/png", data: "aW1n" },
      ],
      { timestamp: 2, runtimeContext: { retained: false } },
    );
    const messages = [user("Original question", 1), carrier, user("Steering correction", 3)];
    const { payload } = await captureMessages("transport", { input: ["text", "image"] }, messages, {
      cacheRetention: "short",
    });
    const wire = payload.messages as Array<{ content: unknown }>;

    expect(wire[0]?.content).toEqual([textBlock("Original question", { type: "ephemeral" })]);
    expect(wire[1]?.content).toEqual([
      textBlock("legacy plugin runtime context"),
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1n" },
      },
    ]);
    expect(wire[2]?.content).toBe("Steering correction");
  });

  it.each([false, true])(
    "preserves excluded-consult updates and the prompt prefix (prior conversation=%s)",
    async (priorConversation) => {
      const model = { ...anthropicModel, id: "claude-opus-5-5" };
      const answer = assistant(model, [{ type: "text", text: "Answer" }]);
      const prior: Context["messages"] = priorConversation
        ? [user("Earlier question", 0), answer]
        : [];
      // The generated consult prompt was excluded from replay; both updates survive.
      const messages: Context["messages"] = [
        ...prior,
        user("Changed instructions", 2, false),
        user("Consult facts", 3, true),
      ];
      appendToolRound(messages, model, 2);
      const expected = [
        ...(priorConversation
          ? [
              { role: "user", content: "Earlier question" },
              { role: "assistant", content: [textBlock("Answer")] },
            ]
          : []),
        { role: "user", content: "." },
        system("Changed instructions"),
        system("Consult facts", true),
        { role: "assistant", content: [{ type: "tool_use" }, { type: "tool_use" }] },
        { role: "user", content: [{ type: "tool_result" }, { type: "tool_result" }] },
      ];
      for (const implementation of ["provider", "transport"] as const) {
        const first = await captureMessages(implementation, model, messages);
        expect(first.payload.messages).toMatchObject(expected);
        const second = await captureMessages(implementation, model, [
          ...messages,
          answer,
          user("Next question", 6),
        ]);
        expect(second.payload.messages).toMatchObject([
          ...expected,
          { role: "assistant", content: [textBlock("Answer")] },
          { role: "user", content: "Next question" },
        ]);
        expect(second.payload.system).toEqual(first.payload.system);
        expect(second.payload.system).toEqual([textBlock(context.systemPrompt)]);
        expect((second.payload.messages as unknown[]).slice(0, expected.length)).toEqual(
          first.payload.messages,
        );
      }
    },
  );

  it("sends turn-scoped operator context with system authority", async () => {
    const messages: Context["messages"] = [
      user("Question", 1),
      user("Prompt update", 2, false),
      { ...user("Runtime facts", 3, true), content: [textBlock("Runtime facts")] },
    ];
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureMessages(implementation, opusModel, messages, {
        headers: { "anthropic-beta": "custom-beta" },
      });
      expect(payload.messages).toEqual([
        { role: "user", content: "Question" },
        system("Prompt update"),
        system("Runtime facts", true),
      ]);
      const betas = headers.get("anthropic-beta")?.split(",");
      expect(betas).toContain("custom-beta");
      expect(betas).toContain("mid-conversation-system-clear-at-2026-08-21");
    }
  });

  it("keeps tool-result scaffolding ahead of a mid-run operator update", async () => {
    const messages: Context["messages"] = [user("Question", 1)];
    appendToolRound(messages, opusModel, 1);
    const toolTurn = messages[1];
    if (toolTurn?.role === "assistant") {
      toolTurn.content.unshift({
        type: "thinking",
        thinking: "Use lookup",
        thinkingSignature: "signed-tool-turn",
      });
    }
    messages.push(user("Permission changed", 4, false));
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureMessages(implementation, opusModel, messages, {
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
        system("Permission changed"),
      ]);
    }
  });

  it("preserves historical operator positions before the next user with an aborted assistant", async () => {
    const messages: Context["messages"] = [
      user("First question", 1),
      user("First turn facts", 2, true),
    ];
    const nextMessages: Context["messages"] = [...messages];
    nextMessages.push(createFailureMessage(opusModel, new Error("Interrupted"), true));
    nextMessages.push(user("Second question", 4), user("Second turn facts", 5, true));
    for (const implementation of ["provider", "transport"] as const) {
      const initial = await captureMessages(implementation, opusModel, messages);
      const replay = await captureMessages(implementation, opusModel, nextMessages);
      if (!Array.isArray(initial.payload.messages)) {
        throw new Error("Expected initial messages");
      }
      expect(replay.payload.system).toEqual(initial.payload.system);
      expect(replay.payload.messages).toEqual([
        ...initial.payload.messages,
        {
          role: "assistant",
          content: [textBlock(STREAM_ERROR_FALLBACK_TEXT)],
        },
        { role: "user", content: "Second question" },
        system("Second turn facts", true),
      ]);
    }
  });

  it("preserves ordinary user context on an ineligible OAuth route", async () => {
    const messages = [
      user("Question", 1),
      user("Runtime facts", 2, true),
      user("Next question", 3),
    ];
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureMessages(implementation, opusModel, messages, {
        apiKey: "test-sk-ant-oat-fixture",
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
    ["claude-fable-5-1", false, false],
    ["claude-opus-5-5", true, undefined],
  ] as const)(
    "preserves reusable prefixes through tool loops and a new turn: %s",
    async (id, retained, carrierRetained) => {
      const model = { ...anthropicModel, id };
      const cacheRetention = retained ? "long" : "short";
      const cacheControl = {
        type: "ephemeral",
        ...(cacheRetention === "long" ? { ttl: "1h" } : {}),
      };
      const carrier: RuntimeContextMessage = {
        role: "user",
        content: retained ? [textBlock(runtimeText)] : runtimeText,
        timestamp: 1,
        runtimeContext: carrierRetained === undefined ? {} : { retained: carrierRetained },
      };
      for (const implementation of ["provider", "transport"] as const) {
        const messages: Context["messages"] = [
          user("", 0),
          { ...user(" ", 0), content: [textBlock(" ")] },
          user("Question", 1),
          ...(retained ? [carrier] : []),
        ];
        let previousPrefix: unknown[] = [];
        for (let round = 0; round < 3; round++) {
          if (round > 0) {
            appendToolRound(messages, model, round);
          }
          const replay = retained ? messages : [...messages, carrier];
          const { payload } = await captureMessages(implementation, model, replay, {
            cacheRetention,
          });
          const wire = payload.messages as Array<{ role: string; content: unknown }>;
          const stable = retained ? wire : wire.slice(0, -1);
          if (!retained) {
            expect(wire.at(-1)).toEqual({
              role: "user",
              content: runtimeText,
            });
          } else {
            const retainedContent = wire[1]?.content;
            expect(
              typeof retainedContent === "string"
                ? [{ type: "text", text: retainedContent }]
                : retainedContent,
            ).toEqual([textBlock(runtimeText, round < 2 ? cacheControl : undefined)]);
          }
          expect(stable.at(-1)?.content).toEqual(
            round === 0
              ? [textBlock(retained ? runtimeText : "Question", cacheControl)]
              : [
                  expect.objectContaining({ type: "tool_result", tool_use_id: `call_${round}_a` }),
                  expect.objectContaining({
                    type: "tool_result",
                    tool_use_id: `call_${round}_b`,
                    cache_control: cacheControl,
                  }),
                ],
          );
          // String content is Anthropic's shorthand for one text block; markers may move.
          const prefix = JSON.parse(
            JSON.stringify(stable, (key, value) => {
              if (key === "cache_control") {
                return undefined;
              }
              return key === "content" && typeof value === "string"
                ? [{ type: "text", text: value }]
                : value;
            }),
          );
          expect(prefix.slice(0, previousPrefix.length)).toEqual(previousPrefix);
          previousPrefix = prefix;
          expect(JSON.stringify(payload).match(/"cache_control":/g)?.length).toBeLessThanOrEqual(4);
        }

        messages.push(assistant(model, [textBlock("Done")], 8), user("Next question", 9), {
          ...carrier,
          timestamp: 10,
        });
        const { payload } = await captureMessages(implementation, model, messages, {
          cacheRetention,
        });
        const wire = payload.messages as Array<{ content: unknown }>;
        expect(wire.at(retained ? -1 : -2)?.content).toEqual([
          textBlock(retained ? runtimeText : "Next question", cacheControl),
        ]);
        if (!retained) {
          expect(wire.at(-1)?.content).toBe(runtimeText);
        }
      }
    },
  );
});
