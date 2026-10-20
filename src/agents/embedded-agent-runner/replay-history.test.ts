import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { convertMessages } from "../../../packages/ai/src/openai-completions-messages.js";
import { transformMessages } from "../../../packages/ai/src/transcript-transform.js";
import { resolveOpenAICompletionsCompat } from "../../../packages/ai/src/transports/openai-completions-compat.js";
import { markInboundContextLabel } from "../../auto-reply/reply/inbound-context-marker.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { OPENCLAW_TRANSCRIPT_ARTIFACT_API } from "../../shared/transcript-only-openclaw-assistant.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../harness/transcript-visibility.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
} from "../internal-runtime-context.js";
import type { StreamFn } from "../runtime/index.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { normalizeAssistantReplayContent, validateReplayTurns } from "./replay-history.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./run/attempt-tool-call-replay-sanitization.js";

// Preface of carriers persisted before the stable system prompt explained the markers.
const LEGACY_NEXT_TURN_RUNTIME_CONTEXT_HEADER =
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.";

const FALLBACK_TEXT = "[assistant turn failed before producing content]";
const COPIED_INBOUND_METADATA_ONLY_TEXT = [
  markInboundContextLabel("Conversation info:"),
  "```json",
  '{"message_id":"msg-abc","sender":"+1555000"}',
  "```",
].join("\n");

function bedrockAssistant(
  content: unknown,
  stopReason: "error" | "stop" | "toolUse" | "length" = "error",
  usageOverrides: Record<string, number> = {},
): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    model: "anthropic.claude-3-haiku-20240307-v1:0",
    usage: { ...createZeroUsageFixture(), ...usageOverrides },
    stopReason,
    timestamp: 0,
  } as unknown as AgentMessage;
}

const textBlock = (text: string) => ({ type: "text" as const, text });
const thinkingBlock = (thinking: string, thinkingSignature: string) => ({
  type: "thinking" as const,
  thinking,
  thinkingSignature,
});
const providerMessages = (messages: AgentMessage[]) =>
  messages.filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
function completionsModel() {
  return makeProviderModelFixture<"openai-completions">({
    id: "test-model",
    api: "openai-completions",
    provider: "custom-openai-compatible",
    baseUrl: "https://proxy.example/v1",
  });
}
function lateMediaUser(media: Record<string, unknown>[], content: unknown = ""): AgentMessage {
  return {
    role: "user",
    content,
    __openclaw: { lateMedia: true, media },
  } as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function expectReplayDrop(before: string, dropped: AgentMessage | AgentMessage[], after: string) {
  const kept = [userMessage(before), userMessage(after)];
  const messages = [kept[0]!, ...[dropped].flat(), ...kept.slice(1)];
  const result = normalizeAssistantReplayContent(messages);
  expect(result).toEqual(kept);
  return result;
}

function openclawTranscriptAssistant(model: "delivery-mirror" | "gateway-injected"): AgentMessage {
  return {
    role: "assistant",
    content: [textBlock("channel mirror")],
    api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
    provider: "openclaw",
    model,
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe("normalizeAssistantReplayContent", () => {
  it("reconstructs hidden tool calls, results, and internal answers in the provider request", () => {
    const model = completionsModel();
    const toolCall = { type: "toolCall" as const, id: "call_hidden", name: "read", arguments: {} };
    const hiddenCall = projectAgentHarnessTranscriptMessageForDisplay({
      hidden: true,
      message: makeAssistantMessageFixture({
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [toolCall],
        stopReason: "toolUse",
        errorMessage: undefined,
      }),
    });
    const hiddenAnswer = projectAgentHarnessTranscriptMessageForDisplay({
      hidden: true,
      message: makeAssistantMessageFixture({
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [textBlock("Internal result: file is ready.")],
        stopReason: "stop",
        errorMessage: undefined,
      }),
    });
    const messages: AgentMessage[] = [
      userMessage("Read the file internally."),
      hiddenCall,
      {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [textBlock("file contents")],
        isError: false,
        timestamp: 1,
      },
      hiddenAnswer,
      userMessage("What did the file contain?"),
    ];
    const converted = convertMessages(
      model,
      {
        tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
        messages: providerMessages(normalizeAssistantReplayContent(messages)),
      },
      resolveOpenAICompletionsCompat(model),
    );

    expect(converted.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(converted[1]).toMatchObject({
      tool_calls: [
        { id: "call_hidden", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    });
    expect(converted[2]).toMatchObject({
      tool_call_id: "call_hidden",
      content: "file contents",
    });
    expect(converted[3]?.content).toBe("Internal result: file is ready.");
    expect(hiddenCall).toHaveProperty("display", false);
    expect(hiddenAnswer).toHaveProperty("display", false);
  });

  it.each(["error", "aborted"] as const)(
    "preserves signed thinking for completed calls after %s",
    (stopReason) => {
      const model = makeProviderModelFixture({
        id: "claude-sonnet-4-6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
      });
      const thinking = thinkingBlock("tool planning", "signed-tool-planning");
      const completed = { type: "toolCall" as const, id: "done", name: "read", arguments: {} };
      const unfinished = { ...completed, id: "unfinished" };
      const source: Extract<AgentMessage, { role: "assistant" }> = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [thinking, textBlock("partial response"), completed, unfinished],
        usage: createZeroUsageFixture(),
        stopReason,
        timestamp: 1,
      };
      const messages: AgentMessage[] = [
        source,
        {
          role: "toolResult",
          toolCallId: completed.id,
          toolName: completed.name,
          content: [textBlock("file contents")],
          isError: false,
          timestamp: 2,
        },
      ];
      const normalized = normalizeAssistantReplayContent(messages);
      const replay = transformMessages(providerMessages(normalized), model);
      expect(replay).toHaveLength(2);
      expect(replay[0]).toMatchObject({ content: [thinking, completed], stopReason: "toolUse" });
      expect(source.content).toEqual([
        thinking,
        textBlock("partial response"),
        completed,
        unfinished,
      ]);
    },
  );

  it.each([false, true])(
    "replays speech-only assistant content without changing the transcript (empty block: %s)",
    (emptyBlock) => {
      const model = completionsModel();
      const speech = makeAssistantMessageFixture({
        content: [
          thinkingBlock("plan the reply", "reasoning_content"),
          ...(emptyBlock ? [{ type: "text" as const, text: "" }] : []),
        ],
        stopReason: "stop",
        errorMessage: undefined,
        usage: { ...createZeroUsageFixture(), output: 5, totalTokens: 5 },
        api: model.api,
        provider: model.provider,
        model: model.id,
        openclawDelivery: { tts: { tagged: true, text: "Done, it is sent." } },
      });
      const storedContent = structuredClone(speech.content);

      const normalized = normalizeAssistantReplayContent([
        userMessage("send it"),
        speech,
        userMessage("heartbeat"),
      ]);
      const converted = convertMessages(
        model,
        {
          messages: providerMessages(normalized),
        },
        resolveOpenAICompletionsCompat(model),
      );

      expect(converted.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      expect(converted[1]?.content).toBe("Done, it is sent.");
      const written = makeAssistantMessageFixture({
        ...speech,
        content: [textBlock("Written answer")],
      });
      const withText = [userMessage("send it"), written];
      expect(normalizeAssistantReplayContent(withText)).toBe(withText);
      expect(speech.content).toEqual(storedContent);
    },
  );

  it("removes persisted attachment display blocks before model replay", () => {
    const damaged = bedrockAssistant(
      [
        textBlock("Slides ready"),
        { type: "attachment", attachment: { label: "slides.pptx" } },
        { type: "attachment_error", attachment: { label: "missing.txt" } },
      ],
      "stop",
      { output: 1, totalTokens: 1 },
    );

    expect(normalizeAssistantReplayContent([damaged, userMessage("continue")])).toEqual([
      { ...damaged, content: [textBlock("Slides ready")] },
      userMessage("continue"),
    ]);
  });

  it("preserves unknown assistant blocks outside the managed display contract", () => {
    const unknown = { customType: "legacy_data", data: "preserve me" };
    const message = bedrockAssistant([unknown], "stop", { output: 1, totalTokens: 1 });

    expect(normalizeAssistantReplayContent([message])).toEqual([message]);
  });

  it("keeps bare marked late-media turns alive while rejecting whitespace-only media fields", () => {
    const blankString = lateMediaUser([{ path: "/tmp/late.png" }]);
    const blankArray = lateMediaUser([{}, { path: "/tmp/late-array.png" }], [textBlock("  ")]);
    const whitespaceOnlyPath = lateMediaUser([{ path: "   " }]);
    const urlOnly = lateMediaUser([{ url: "https://example.test/late.png", kind: "image" }]);
    const legacyOnly = {
      role: "user",
      content: "",
      MediaPath: "/tmp/legacy-late.png",
      __openclaw: { lateMedia: true },
    } as unknown as AgentMessage;

    const out = normalizeAssistantReplayContent([
      blankString,
      blankArray,
      whitespaceOnlyPath,
      urlOnly,
      legacyOnly,
    ]);

    expect(out).toEqual([blankString, { ...blankArray, content: "" }, urlOnly]);
  });

  it.each([{ content: [] }, { content: [{ type: "text", text: FALLBACK_TEXT }] }])(
    "drops failed attempt content $content before a later reply and across user turns",
    async ({ content }) => {
      const before = userMessage("hello");
      const reply = bedrockAssistant([textBlock("recovered")], "stop");
      const after = userMessage("continue");
      expect(
        normalizeAssistantReplayContent([
          before,
          bedrockAssistant(content, "error"),
          bedrockAssistant(content, "error"),
          reply,
          after,
        ]),
      ).toEqual([before, reply, after]);
      for (const api of ["bedrock-converse-stream", "anthropic-messages"] as const) {
        const normalized = normalizeAssistantReplayContent([
          before,
          bedrockAssistant(content, "error"),
        ]);
        expect(normalized).toEqual([before]);
        const history = await validateReplayTurns({
          messages: normalized,
          modelApi: api,
        });
        const messages = [...history, after];
        if (!messages.every((message) => message.role === "user")) {
          throw new Error("Expected repaired history and the current prompt to contain only users");
        }
        const baseFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
        const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
          baseFn,
          undefined,
          {
            validateAnthropicTurns: true,
            validateGeminiTurns: false,
            preserveSignatures: true,
            dropThinkingBlocks: false,
            appendOnlyRuntimeContext: true,
          },
          api === "bedrock-converse-stream" ? "amazon-bedrock" : "anthropic",
        );
        void wrapped(
          makeProviderModelFixture({
            id: "claude-sonnet-4-6",
            provider: api === "bedrock-converse-stream" ? "amazon-bedrock" : "anthropic",
            api,
            baseUrl: "https://example.test",
          }),
          { messages },
        );
        expect(baseFn.mock.calls[0]?.[1].messages).toEqual(
          api === "anthropic-messages"
            ? messages
            : [
                {
                  ...after,
                  content: [textBlock("hello"), textBlock("continue")],
                },
              ],
        );
      }
    },
  );

  it("preserves consecutive ambient user rows", () => {
    const messages = [
      userMessage("#10 Sam: first ambient"),
      userMessage("#11 Lee: second ambient"),
      userMessage("#12 Pat: @bot what now?"),
    ];
    expect(normalizeAssistantReplayContent(messages)).toBe(messages);
  });
  it("removes blank user text blocks while preserving non-text content", () => {
    const imageBlock = { type: "image", data: "AA==", mimeType: "image/png" };
    const messages = [
      {
        role: "user",
        content: [textBlock("   "), imageBlock],
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).not.toBe(messages);
    expect((out[0] as { content: unknown[] }).content).toEqual([imageBlock]);
  });

  it("preserves nonzero-usage silent-reply turns (stopReason=stop, content=[]) untouched", () => {
    // A billed silent reply is not a failed attempt; never fabricate replay text.
    const silentStop = bedrockAssistant([], "stop", { input: 100, totalTokens: 100 });
    const messages = [userMessage("hello"), silentStop];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out[1]).toBe(silentStop);
  });

  it.each([{ content: [] }, { content: null }])(
    "drops mid-turn zero-usage empty stop content $content",
    ({ content }) => {
      expectReplayDrop("hello", bedrockAssistant(content, "stop"), "retry");
    },
  );

  it.each([
    { type: "openai-responses-retained-compaction", stopReason: "stop", retained: true },
    { type: "openai-responses-retained-compaction", stopReason: "error", retained: false },
    { type: "openai-responses-compaction-suppression", stopReason: "stop", retained: false },
    { type: "unrelated-provider-replay", stopReason: "stop", retained: false },
  ] as const)("keeps only successful empty compaction carriers: $type/$stopReason", (testCase) => {
    const message = bedrockAssistant([], testCase.stopReason);
    if (message.role !== "assistant") {
      throw new Error("Expected an assistant fixture");
    }
    message.providerReplay = {
      type: testCase.type,
      v: 1,
      data: "opaque-checkpoint",
      provider: message.provider,
      api: message.api,
      model: message.model,
    };
    expect(normalizeAssistantReplayContent([message])).toEqual(testCase.retained ? [message] : []);
  });

  it("preserves empty content with non-error stopReasons (toolUse, length) untouched", () => {
    // Empty tool/length states are real provider turns, not failed attempts.
    const toolUse = bedrockAssistant([], "toolUse");
    const length = bedrockAssistant([], "length");
    const messages = [userMessage("hello"), toolUse, length];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out[1]).toBe(toolUse);
    expect(out[2]).toBe(length);
  });

  it("drops reasoning-only length turns before provider replay", () => {
    const reasoningOnly = bedrockAssistant(
      [thinkingBlock("partial hidden reasoning", "partial-signature"), textBlock("  ")],
      "length",
      { output: 42, totalTokens: 42 },
    );
    const out = expectReplayDrop("before", reasoningOnly, "continue");
    expect(JSON.stringify(out)).not.toContain("partial-signature");
  });

  it("drops length turns that become reasoning-only after content normalization", () => {
    expectReplayDrop(
      "before",
      [
        bedrockAssistant(
          [thinkingBlock("partial hidden reasoning", "partial-signature"), textBlock("NO_REPLY")],
          "length",
        ),
        {
          ...bedrockAssistant([], "length"),
          content: thinkingBlock("partial object reasoning", "partial-object-signature"),
        },
      ] as AgentMessage[],
      "continue",
    );
  });

  it("preserves length turns with visible text or tool calls", () => {
    const visible = bedrockAssistant(
      [thinkingBlock("partial reasoning", "sig_visible"), textBlock("partial visible answer")],
      "length",
    );
    const toolCall = bedrockAssistant(
      [
        thinkingBlock("partial reasoning", "sig_tool"),
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      ],
      "length",
    );
    const messages = [userMessage("before"), visible, toolCall, userMessage("continue")];

    const out = normalizeAssistantReplayContent(messages);

    expect(out).toBe(messages);
  });

  it("wraps legacy string assistant content as a single text block (regression)", () => {
    const messages = [userMessage("hi"), bedrockAssistant("plain string content")];
    const out = normalizeAssistantReplayContent(messages);
    const wrapped = out[1] as AgentMessage & { content: { type: string; text: string }[] };
    expect(wrapped.content).toEqual([textBlock("plain string content")]);
  });

  it("wraps legacy object assistant content as a single block (regression)", () => {
    const block = textBlock("plain object content");
    const messages = [userMessage("hi"), bedrockAssistant(block, "stop")];
    const out = normalizeAssistantReplayContent(messages);
    const wrapped = out[1] as AgentMessage & { content: unknown[] };
    expect(wrapped.content).toEqual([block]);
  });

  it("normalizes null assistant content to an empty block array (regression)", () => {
    const messages = [userMessage("hi"), bedrockAssistant(null, "toolUse")];
    const out = normalizeAssistantReplayContent(messages);
    const normalized = out[1] as AgentMessage & { content: unknown[] };
    expect(normalized.content).toEqual([]);
  });

  it("drops metadata-only legacy string assistant content from replay", () => {
    const out = expectReplayDrop(
      "first",
      bedrockAssistant(COPIED_INBOUND_METADATA_ONLY_TEXT),
      "second",
    );
    expect(JSON.stringify(out)).not.toContain("assistant copied inbound metadata omitted");
  });

  it.each(["NO_REPLY", "no_reply", "No_Reply"])(
    "drops standalone %s assistant replay text",
    (text) => {
      expectReplayDrop("first", bedrockAssistant(text), "second");
    },
  );

  it.each([
    ["directly", "NO_REPLY", thinkingBlock("yield reasoning", "sig_yield")],
    ["with redacted reasoning", "NO_REPLY", { type: "redacted_thinking", data: "redacted-yield" }],
  ])("drops thinking-only silent replies %s (#99620)", (_label, text, reasoning) => {
    const kept = userMessage("hi");
    expect(
      normalizeAssistantReplayContent([
        kept,
        bedrockAssistant([reasoning, { type: "text", text }], "stop"),
      ]),
    ).toStrictEqual([kept]);
  });

  it("drops silent thinking residue before a follow-up tool turn (#99620)", () => {
    const nextToolTurn = bedrockAssistant(
      [
        thinkingBlock("next reasoning", "sig_next"),
        { type: "toolCall", id: "call_1", name: "exec", arguments: {} },
      ],
      "toolUse",
    );
    const messages = [
      userMessage("hi"),
      bedrockAssistant(
        [thinkingBlock("yield reasoning", "sig_yield"), textBlock("NO_REPLY")],
        "stop",
      ),
      nextToolTurn,
      userMessage("tool result"),
    ];

    expect(normalizeAssistantReplayContent(messages)).toEqual([
      messages[0],
      nextToolTurn,
      messages[3],
    ]);
  });

  it("preserves silent-reply turns with tool calls", () => {
    const companion = { type: "toolCall", id: "call_1", name: "exec", arguments: {} };
    const messages = [
      userMessage("hi"),
      bedrockAssistant(
        [thinkingBlock("useful reasoning", "sig"), companion, textBlock("NO_REPLY")],
        "stop",
      ),
    ];

    const out = normalizeAssistantReplayContent(messages);
    expect(out).toHaveLength(2);
    expect((out[1] as { content: unknown[] }).content).toEqual([
      thinkingBlock("useful reasoning", "sig"),
      companion,
      textBlock("NO_REPLY"),
    ]);
  });

  it.each(["NO_REPLY.", '"NO_REPLY"', '{"action":"NO_REPLY"}', "Done\nNO_REPLY"])(
    "preserves ordinary assistant replay text %s",
    (text) => {
      const messages = [userMessage("first"), bedrockAssistant(text), userMessage("NO_REPLY")];
      expect(normalizeAssistantReplayContent(messages)).toEqual([
        messages[0],
        { ...messages[1], content: [{ type: "text", text }] },
        messages[2],
      ]);
    },
  );

  it("classifies the raw whole row before removing metadata", () => {
    const message = bedrockAssistant(`${COPIED_INBOUND_METADATA_ONLY_TEXT}\n\nNO_REPLY`);
    expect(normalizeAssistantReplayContent([message])).toHaveLength(1);
  });

  it("does not classify a text block separately from the answer", () => {
    const message = bedrockAssistant([
      textBlock("NO_REPLY"),
      textBlock(" is the protocol marker."),
    ]);
    expect(normalizeAssistantReplayContent([message])).toEqual([message]);
  });

  it("strips copied runtime context from assistant replay text", () => {
    const messages = [
      userMessage("first"),
      bedrockAssistant([
        {
          type: "text",
          text: [
            "Visible before",
            INTERNAL_RUNTIME_CONTEXT_BEGIN,
            "keep this internal",
            INTERNAL_RUNTIME_CONTEXT_END,
            LEGACY_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
            OPENCLAW_RUNTIME_CONTEXT_NOTICE,
            "",
            "Visible after",
          ].join("\n"),
        },
      ]),
    ];
    const out = normalizeAssistantReplayContent(messages);
    const normalized = out[1] as AgentMessage & { content: unknown[] };
    expect(normalized.content).toEqual([textBlock("Visible before\n\nVisible after")]);
  });

  it("drops metadata-only assistant text blocks without fabricating placeholder output", () => {
    const toolCall = { type: "toolCall", id: "call_1", name: "read", arguments: {} };
    const messages = [
      userMessage("hi"),
      bedrockAssistant(
        [
          { type: "text", text: COPIED_INBOUND_METADATA_ONLY_TEXT },
          { type: "text", text: `${COPIED_INBOUND_METADATA_ONLY_TEXT}\n\nVisible reply` },
          toolCall,
        ],
        "toolUse",
      ),
    ];
    const out = normalizeAssistantReplayContent(messages);
    const normalized = out[1] as AgentMessage & { content: unknown[] };
    expect(normalized.content).toEqual([textBlock("Visible reply"), toolCall]);
    expect(JSON.stringify(out)).not.toContain("assistant copied inbound metadata omitted");
  });

  it("filters openclaw delivery-mirror and gateway-injected assistant messages from replay", () => {
    // Transcript artifacts must not become provider input.
    const messages = [
      userMessage("hello"),
      openclawTranscriptAssistant("delivery-mirror"),
      bedrockAssistant([textBlock("real reply")]),
      openclawTranscriptAssistant("gateway-injected"),
    ];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toHaveLength(2);
    expect((out[0] as { role: string }).role).toBe("user");
    expect((out[1] as { provider: string }).provider).toBe("amazon-bedrock");
  });

  it.each([
    "channel-final",
    "channel-final-suppressed",
    "message-tool-source-reply",
    "model-fallback",
  ] as const)("filters a stripped delivery mirror identified by %s", (kind) => {
    const strippedMirror = {
      ...bedrockAssistant([textBlock("channel mirror")], "stop"),
      provider: undefined,
      model: undefined,
      openclawDeliveryMirror: { kind },
    } as unknown as AgentMessage;
    const realReply = bedrockAssistant([textBlock("real reply")], "stop", {
      input: 1,
      output: 1,
      totalTokens: 2,
    });

    expect(
      normalizeAssistantReplayContent([userMessage("hello"), strippedMirror, realReply]),
    ).toEqual([expect.objectContaining({ role: "user" }), realReply]);
  });

  it("preserves an assistant carrying an invalid delivery-mirror marker", () => {
    const assistant = {
      ...bedrockAssistant([textBlock("real reply")], "stop", {
        input: 1,
        output: 1,
        totalTokens: 2,
      }),
      openclawDeliveryMirror: { kind: "unknown" },
    } as unknown as AgentMessage;
    const messages = [userMessage("hello"), assistant];

    expect(normalizeAssistantReplayContent(messages)).toBe(messages);
  });

  it("filters an adjacent marker-free zero-usage delivery mirror", () => {
    const content = [textBlock("real reply")];
    const realReply = bedrockAssistant(content, "stop", {
      input: 1,
      output: 1,
      totalTokens: 2,
    });
    const bareMirror = bedrockAssistant([{ text: "real reply", type: "text" }], "stop");

    expect(normalizeAssistantReplayContent([userMessage("hello"), realReply, bareMirror])).toEqual([
      expect.objectContaining({ role: "user" }),
      realReply,
    ]);
  });

  it("preserves an identical canonical automation result after an assistant reply", () => {
    const content = [textBlock("Report ready")];
    const reply = bedrockAssistant(content, "stop", { output: 1, totalTokens: 1 });
    const result = {
      ...bedrockAssistant(content, "stop"),
      api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
      provider: "openclaw",
      model: "automation-result",
    };
    const messages = [userMessage("report"), reply, result, userMessage("explain")];

    expect(normalizeAssistantReplayContent(messages)).toEqual(messages);
  });

  it("preserves adjacent identical assistant turns with nonzero usage", () => {
    const content = [textBlock("intentional repeat")];
    const first = bedrockAssistant(content, "stop", { output: 1, totalTokens: 1 });
    const second = bedrockAssistant(content, "stop", { output: 1, totalTokens: 1 });
    const messages = [userMessage("repeat"), first, second];

    expect(normalizeAssistantReplayContent(messages)).toBe(messages);
  });

  it("preserves adjacent zero-usage assistant turns with tool calls", () => {
    const content = [
      textBlock("checking"),
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "file.txt" } },
    ];
    const first = bedrockAssistant(content, "stop");
    const second = bedrockAssistant(content, "stop");
    const messages = [userMessage("check"), first, second];

    expect(normalizeAssistantReplayContent(messages)).toBe(messages);
  });

  it("preserves a trailing real model reply whose only content happens to be the sentinel text (clawsweeper review on #77287)", () => {
    // Sentinel text alone is not synthetic provenance.
    const realReplyAsStop = bedrockAssistant([{ type: "text", text: FALLBACK_TEXT }], "stop", {
      input: 1,
      output: 1,
      totalTokens: 2,
    });
    const messages = [userMessage("hi"), realReplyAsStop];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out).toHaveLength(2);
    expect((out[1] as { content: unknown[] }).content).toEqual([
      { type: "text", text: FALLBACK_TEXT },
    ]);
  });

  it("preserves a trailing turn whose sentinel content is paired with stopReason: toolUse (real provider state, not synthetic)", () => {
    const toolUseSentinel = bedrockAssistant([{ type: "text", text: FALLBACK_TEXT }], "toolUse");
    const messages = [userMessage("hi"), toolUseSentinel];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out).toHaveLength(2);
  });

  it("still drops a trailing zero-usage stop turn whose content was already lifted to the sentinel block (post-rewrite shape)", () => {
    // Zero usage plus stop identifies the persisted synthetic sentinel.
    const persistedZeroUsageSentinel = bedrockAssistant(
      [{ type: "text", text: FALLBACK_TEXT }],
      "stop",
    );
    const kept = userMessage("hi");
    expect(normalizeAssistantReplayContent([kept, persistedZeroUsageSentinel])).toStrictEqual([
      kept,
    ]);
  });
});
