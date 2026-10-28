import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { convertMessages } from "../../../packages/ai/src/openai-completions-messages.js";
import { transformMessages } from "../../../packages/ai/src/transcript-transform.js";
import { resolveOpenAICompletionsCompat } from "../../../packages/ai/src/transports/openai-completions-compat.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { markInboundContextLabel } from "../../auto-reply/reply/inbound-context-marker.js";
import { normalizeTranscriptJsonValue } from "../../config/sessions/transcript-json.js";
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
import {
  normalizeAssistantReplayContent as normalize,
  validateReplayTurns,
} from "./replay-history.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./run/attempt-tool-call-replay-sanitization.js";

// Preface of carriers persisted before the stable system prompt explained the markers.
const LEGACY_HEADER =
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.";
const FALLBACK_TEXT = "[assistant turn failed before producing content]";
const INBOUND_METADATA = [
  markInboundContextLabel("Conversation info:"),
  "```json",
  '{"message_id":"msg-abc","sender":"+1555000"}',
  "```",
].join("\n");

function assistant(
  content: unknown,
  stopReason: "error" | "stop" | "toolUse" | "length" = "error",
  usageOverrides: Record<string, number> = {},
): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content,
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    model: "anthropic.claude-3-haiku-20240307-v1:0",
    usage: { ...createZeroUsageFixture(), ...usageOverrides },
    stopReason,
    timestamp: 0,
  } as unknown as Extract<AgentMessage, { role: "assistant" }>;
}

const textBlock = (text: string) => ({ type: "text" as const, text });
const thinkingBlock = (thinking: string, thinkingSignature: string) => ({
  type: "thinking" as const,
  thinking,
  thinkingSignature,
});
const providerMessages = (messages: AgentMessage[]) =>
  messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
const call = (id = "call_1", name = "read", args: Record<string, unknown> = {}) =>
  ({ type: "toolCall", id, name, arguments: args }) as const;
function convertReplay(
  model: ReturnType<typeof completionsModel>,
  messages: AgentMessage[],
  withTools = false,
) {
  return convertMessages(
    model,
    {
      ...(withTools
        ? { tools: [{ name: "read", description: "Read", parameters: { type: "object" } }] }
        : {}),
      messages: providerMessages(normalize(messages)),
    },
    resolveOpenAICompletionsCompat(model),
  );
}
function hiddenAssistant(
  model: ReturnType<typeof completionsModel>,
  content: NonNullable<Parameters<typeof makeAssistantMessageFixture>[0]>["content"],
  stopReason: "toolUse" | "stop",
) {
  return projectAgentHarnessTranscriptMessageForDisplay({
    hidden: true,
    message: makeAssistantMessageFixture({
      api: model.api,
      provider: model.provider,
      model: model.id,
      content,
      stopReason,
      errorMessage: undefined,
    }),
  });
}
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

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function expectReplayDrop(before: string, dropped: AgentMessage | AgentMessage[], after: string) {
  const kept = [user(before), user(after)];
  const messages = [kept[0]!, ...[dropped].flat(), ...kept.slice(1)];
  const result = normalize(messages);
  expect(result).toEqual(kept);
  return result;
}

function billedReply(content: unknown) {
  return assistant(content, "stop", { input: 1, output: 1, totalTokens: 2 });
}
function transcriptArtifact(model: "delivery-mirror" | "gateway-injected"): AgentMessage {
  return {
    ...assistant([textBlock("channel mirror")], "stop"),
    api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
    provider: "openclaw",
    model,
  } as unknown as AgentMessage;
}

describe("normalizeAssistantReplayContent", () => {
  it("reconstructs hidden tool calls, results, and internal answers in the provider request", () => {
    const model = completionsModel();
    const toolCall = call("call_hidden");
    const hiddenCall = hiddenAssistant(model, [toolCall], "toolUse");
    const hiddenAnswer = hiddenAssistant(
      model,
      [textBlock("Internal result: file is ready.")],
      "stop",
    );
    const messages: AgentMessage[] = [
      user("Read the file internally."),
      hiddenCall,
      makeTextToolResult(toolCall.id, toolCall.name, "file contents", false, 1),
      hiddenAnswer,
      user("What did the file contain?"),
    ];
    const converted = convertReplay(model, messages, true);

    expect(converted).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_hidden", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_hidden", content: "file contents" },
      { role: "assistant", content: "Internal result: file is ready." },
      { role: "user" },
    ]);
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
      const completed = call("done");
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
        makeTextToolResult(completed.id, completed.name, "file contents", false, 2),
      ];
      normalizeTranscriptJsonValue({ message: source }, "entry");
      expect(normalize([source])).toEqual([]);
      const normalized = normalize(messages);
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

  it("reuses immutable message normalization while new and mutable content is still sanitized", () => {
    const source = assistant([textBlock("answer"), { type: "audio", data: "managed" }], "stop");
    normalizeTranscriptJsonValue({ message: source }, "entry");
    const first = normalize([source]).find((message) => message.role === "assistant");
    expect(first?.content).toEqual([textBlock("answer")]);
    const tail = assistant([textBlock("new answer"), { type: "audio", data: "managed" }], "stop");
    const next = normalize([source, tail]);
    expect(next[0]).toBe(first);
    expect(next[1]).toHaveProperty("content", [textBlock("new answer")]);
    expect(Object.isFrozen(first?.content)).toBe(true);
    tail.content = [textBlock("edited")];
    expect(normalize([source, tail])[1]).toHaveProperty("content", [textBlock("edited")]);
    expect(source.content).toEqual([textBlock("answer"), { type: "audio", data: "managed" }]);
  });

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

      const converted = convertReplay(model, [user("send it"), speech, user("heartbeat")]);

      expect(converted.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      expect(converted[1]?.content).toBe("Done, it is sent.");
      const written = makeAssistantMessageFixture({
        ...speech,
        content: [textBlock("Written answer")],
      });
      const withText = [user("send it"), written];
      expect(normalize(withText)).toBe(withText);
      expect(speech.content).toEqual(storedContent);
    },
  );

  it("removes persisted attachment display blocks before model replay", () => {
    const damaged = assistant(
      [
        textBlock("Slides ready"),
        { type: "attachment", attachment: { label: "slides.pptx" } },
        { type: "attachment_error", attachment: { label: "missing.txt" } },
      ],
      "stop",
      { output: 1, totalTokens: 1 },
    );

    expect(normalize([damaged, user("continue")])).toEqual([
      { ...damaged, content: [textBlock("Slides ready")] },
      user("continue"),
    ]);
  });

  it("preserves unknown assistant blocks outside the managed display contract", () => {
    const unknown = { customType: "legacy_data", data: "preserve me" };
    const message = assistant([unknown], "stop", { output: 1, totalTokens: 1 });

    expect(normalize([message])).toEqual([message]);
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

    const out = normalize([blankString, blankArray, whitespaceOnlyPath, urlOnly, legacyOnly]);

    expect(out).toEqual([blankString, { ...blankArray, content: "" }, urlOnly]);
  });

  it.each([{ content: [] }, { content: [{ type: "text", text: FALLBACK_TEXT }] }])(
    "drops failed attempt content $content before a later reply and across user turns",
    async ({ content }) => {
      const before = user("hello");
      const reply = assistant([textBlock("recovered")], "stop");
      const after = user("continue");
      expect(
        normalize([before, assistant(content, "error"), assistant(content, "error"), reply, after]),
      ).toEqual([before, reply, after]);
      for (const api of ["bedrock-converse-stream", "anthropic-messages"] as const) {
        const normalized = normalize([before, assistant(content, "error")]);
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
      user("#10 Sam: first ambient"),
      user("#11 Lee: second ambient"),
      user("#12 Pat: @bot what now?"),
    ];
    expect(normalize(messages)).toBe(messages);
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
    const out = normalize(messages);
    expect(out).not.toBe(messages);
    expect((out[0] as { content: unknown[] }).content).toEqual([imageBlock]);
  });

  it.each(["billed silence", "unfinished empty turns"])(
    "preserves %s without rewriting rows",
    (kind) => {
      const replies =
        kind === "billed silence"
          ? [assistant([], "stop", { input: 100, totalTokens: 100 })]
          : [assistant([], "toolUse"), assistant([], "length")];
      const messages = [user("hello"), ...replies];
      const out = normalize(messages);
      expect(out).toBe(messages);
      replies.forEach((reply, index) => expect(out[index + 1]).toBe(reply));
    },
  );

  it.each([{ content: [] }, { content: null }])(
    "drops mid-turn zero-usage empty stop content $content",
    ({ content }) => {
      expectReplayDrop("hello", assistant(content, "stop"), "retry");
    },
  );

  it.each([
    { type: "openai-responses-retained-compaction", stopReason: "stop", retained: true },
    { type: "openai-responses-retained-compaction", stopReason: "error", retained: false },
    { type: "openai-responses-compaction-suppression", stopReason: "stop", retained: false },
    { type: "unrelated-provider-replay", stopReason: "stop", retained: false },
  ] as const)("keeps only successful empty compaction carriers: $type/$stopReason", (testCase) => {
    const message = assistant([], testCase.stopReason);
    message.providerReplay = {
      type: testCase.type,
      v: 1,
      data: "opaque-checkpoint",
      provider: message.provider,
      api: message.api,
      model: message.model,
    };
    expect(normalize([message])).toEqual(testCase.retained ? [message] : []);
  });

  it.each(["billed", "normalized"])("drops %s reasoning-only length turns", (kind) => {
    const thinking = thinkingBlock("partial hidden reasoning", "partial-signature");
    const replies =
      kind === "billed"
        ? assistant([thinking, textBlock("  ")], "length", { output: 42, totalTokens: 42 })
        : ([
            assistant([thinking, textBlock("NO_REPLY")], "length"),
            {
              ...assistant([], "length"),
              content: thinkingBlock("partial object reasoning", "partial-object-signature"),
            },
          ] as AgentMessage[]);
    const out = expectReplayDrop("before", replies, "continue");
    if (kind === "billed") {
      expect(JSON.stringify(out)).not.toContain("partial-signature");
    }
  });

  it("preserves length turns with visible text or tool calls", () => {
    const visible = assistant(
      [thinkingBlock("partial reasoning", "sig_visible"), textBlock("partial visible answer")],
      "length",
    );
    const toolCall = assistant([thinkingBlock("partial reasoning", "sig_tool"), call()], "length");
    const messages = [user("before"), visible, toolCall, user("continue")];
    expect(normalize(messages)).toBe(messages);
  });

  it.each([
    ["string", "plain string content", [textBlock("plain string content")], "error"],
    ["object", textBlock("plain object content"), [textBlock("plain object content")], "stop"],
    ["null", null, [], "toolUse"],
  ] as const)("normalizes legacy %s assistant content", (_shape, content, expected, stop) => {
    const out = normalize([user("hi"), assistant(content, stop)]);
    expect(out[1]).toHaveProperty("content", expected);
  });

  it("drops metadata-only legacy string assistant content from replay", () => {
    const out = expectReplayDrop("first", assistant(INBOUND_METADATA), "second");
    expect(JSON.stringify(out)).not.toContain("assistant copied inbound metadata omitted");
  });

  it.each(["NO_REPLY", "no_reply", "No_Reply"])(
    "drops standalone %s assistant replay text",
    (text) => {
      expectReplayDrop("first", assistant(text), "second");
    },
  );

  it("drops silent replies with redacted reasoning (#99620)", () => {
    const kept = user("hi");
    const reasoning = { type: "redacted_thinking", data: "redacted-yield" };
    expect(normalize([kept, assistant([reasoning, textBlock("NO_REPLY")], "stop")])).toStrictEqual([
      kept,
    ]);
  });

  it("drops silent thinking residue before a follow-up tool turn (#99620)", () => {
    const nextToolTurn = assistant(
      [thinkingBlock("next reasoning", "sig_next"), call("call_1", "exec")],
      "toolUse",
    );
    const messages = [
      user("hi"),
      assistant([thinkingBlock("yield reasoning", "sig_yield"), textBlock("NO_REPLY")], "stop"),
      nextToolTurn,
      user("tool result"),
    ];

    expect(normalize(messages)).toEqual([messages[0], nextToolTurn, messages[3]]);
  });

  it("preserves silent-reply turns with tool calls", () => {
    const companion = call("call_1", "exec");
    const messages = [
      user("hi"),
      assistant(
        [thinkingBlock("useful reasoning", "sig"), companion, textBlock("NO_REPLY")],
        "stop",
      ),
    ];

    const out = normalize(messages);
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
      const messages = [user("first"), assistant(text), user("NO_REPLY")];
      expect(normalize(messages)).toEqual([
        messages[0],
        { ...messages[1], content: [{ type: "text", text }] },
        messages[2],
      ]);
    },
  );

  it("classifies the raw whole row before removing metadata", () => {
    const message = assistant(`${INBOUND_METADATA}\n\nNO_REPLY`);
    expect(normalize([message])).toHaveLength(1);
  });

  it("does not classify a text block separately from the answer", () => {
    const message = assistant([textBlock("NO_REPLY"), textBlock(" is the protocol marker.")]);
    expect(normalize([message])).toEqual([message]);
  });

  it("strips copied runtime context from assistant replay text", () => {
    const content = [
      "Visible before",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "keep this internal",
      INTERNAL_RUNTIME_CONTEXT_END,
      LEGACY_HEADER,
      OPENCLAW_RUNTIME_CONTEXT_NOTICE,
      "",
      "Visible after",
    ].join("\n");
    const out = normalize([user("first"), assistant([textBlock(content)])]);
    expect(out[1]).toHaveProperty("content", [textBlock("Visible before\n\nVisible after")]);
  });

  it("drops metadata-only assistant text blocks without fabricating placeholder output", () => {
    const toolCall = call();
    const messages = [
      user("hi"),
      assistant(
        [
          { type: "text", text: INBOUND_METADATA },
          { type: "text", text: `${INBOUND_METADATA}\n\nVisible reply` },
          toolCall,
        ],
        "toolUse",
      ),
    ];
    const out = normalize(messages);
    expect(out[1]).toHaveProperty("content", [textBlock("Visible reply"), toolCall]);
    expect(JSON.stringify(out)).not.toContain("assistant copied inbound metadata omitted");
  });

  it("filters openclaw delivery-mirror and gateway-injected assistant messages from replay", () => {
    const messages = [
      user("hello"),
      transcriptArtifact("delivery-mirror"),
      assistant([textBlock("real reply")]),
      transcriptArtifact("gateway-injected"),
    ];
    expect(normalize(messages)).toMatchObject([{ role: "user" }, { provider: "amazon-bedrock" }]);
  });

  it.each([
    "channel-final",
    "channel-final-suppressed",
    "message-tool-source-reply",
    "model-fallback",
    "bare",
  ] as const)("filters a delivery mirror identified by %s", (kind) => {
    const realReply = billedReply([textBlock("real reply")]);
    const mirror =
      kind === "bare"
        ? assistant([{ text: "real reply", type: "text" }], "stop")
        : ({
            ...assistant([textBlock("channel mirror")], "stop"),
            provider: undefined,
            model: undefined,
            openclawDeliveryMirror: { kind },
          } as unknown as AgentMessage);
    const input =
      kind === "bare" ? [user("hello"), realReply, mirror] : [user("hello"), mirror, realReply];
    normalizeTranscriptJsonValue({ message: mirror }, "entry");
    if (kind === "bare") {
      expect(normalize([mirror])).toEqual([mirror]);
    }
    expect(normalize(input)).toEqual([expect.objectContaining({ role: "user" }), realReply]);
  });

  it("preserves an assistant carrying an invalid delivery-mirror marker", () => {
    const reply = {
      ...billedReply([textBlock("real reply")]),
      openclawDeliveryMirror: { kind: "unknown" },
    } as unknown as AgentMessage;
    const messages = [user("hello"), reply];

    expect(normalize(messages)).toBe(messages);
  });

  it("preserves an identical canonical automation result after an assistant reply", () => {
    const content = [textBlock("Report ready")];
    const reply = assistant(content, "stop", { output: 1, totalTokens: 1 });
    const result = {
      ...assistant(content, "stop"),
      api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
      provider: "openclaw",
      model: "automation-result",
    };
    const messages = [user("report"), reply, result, user("explain")];

    expect(normalize(messages)).toEqual(messages);
  });

  it("sends only the accepted notice through provider replay while retaining its local display artifact", () => {
    const text = "Restart recovery stopped. Resume in WebChat.";
    const saved = "Unconfirmed draft must not enter model context.";
    const local = {
      ...assistant(
        [textBlock(text), textBlock(`\nSaved reply (delivery unconfirmed):\n${saved}`)],
        "stop",
      ),
      api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
      provider: "openclaw",
      model: "delivery-mirror",
    };
    const confirmed = {
      ...assistant([textBlock(text)], "stop"),
      api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
      provider: "openclaw",
      model: "automation-result",
      display: false,
      openclawAutomation: {
        kind: "recovery-notice",
        noticeId: "notice",
        localNotice: { entryId: "private-anchor" },
      },
    };
    const messages = [user("Continue"), local, confirmed, user("Explain")];
    const before = structuredClone(messages);
    const converted = JSON.stringify(convertReplay(completionsModel(), messages));
    expect(converted.split(text)).toHaveLength(2);
    expect(converted).not.toContain(saved);
    expect(converted).not.toContain("private-anchor");
    expect(messages).toEqual(before);
  });

  it.each([false, true])("preserves identical turns with tools=%s", (tools) => {
    const content = tools
      ? [textBlock("checking"), call("call_1", "read", { path: "file.txt" })]
      : [textBlock("intentional repeat")];
    const usage: Record<string, number> = tools ? {} : { output: 1, totalTokens: 1 };
    const messages = [
      user(tools ? "check" : "repeat"),
      assistant(content, "stop", usage),
      assistant(content, "stop", usage),
    ];
    expect(normalize(messages)).toBe(messages);
  });

  it.each(["stop", "toolUse"] as const)("preserves a real %s sentinel reply (#77287)", (stop) => {
    const content = [textBlock(FALLBACK_TEXT)];
    const usage: Record<string, number> =
      stop === "stop" ? { input: 1, output: 1, totalTokens: 2 } : {};
    const messages = [user("hi"), assistant(content, stop, usage)];
    const out = normalize(messages);
    expect(out).toBe(messages);
    expect(out).toHaveLength(2);
    if (stop === "stop") {
      expect(out[1]).toHaveProperty("content", content);
    }
  });

  it("still drops a trailing zero-usage stop turn whose content was already lifted to the sentinel block (post-rewrite shape)", () => {
    const sentinel = assistant([textBlock(FALLBACK_TEXT)], "stop");
    const kept = user("hi");
    expect(normalize([kept, sentinel])).toStrictEqual([kept]);
  });
});
