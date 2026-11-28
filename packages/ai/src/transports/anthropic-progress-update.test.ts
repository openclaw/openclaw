import type { AssistantMessage, Context } from "@openclaw/llm-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { getAiTransportHost } from "../host.js";
import { createZeroUsage } from "../usage.test-support.js";
import {
  anthropicContentBlockDelta,
  anthropicContentBlockStart,
  anthropicMessageDelta,
  anthropicMessageStart,
  createSseResponse,
  installAnthropicTransportTestHost,
  makeAnthropicTransportModel,
} from "./anthropic-transport-stream.test-support.js";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

// Mirrors the signature layout Opus 5.5 returns: field 2 > 1 > 8 holds the block kind.
function signedAs(kind: string): string {
  const field = (number: number, bytes: number[]) => [(number << 3) | 2, bytes.length, ...bytes];
  const label = [...new TextEncoder().encode(kind)];
  const metadata = field(1, [0x08, 0x14, 0x18, 0x02, 0x38, 0x01, ...field(8, label)]);
  const bytes = [0x08, 0x04, ...field(2, [...metadata, ...field(2, [1, 2, 3, 4])])];
  return btoa(String.fromCharCode(...bytes));
}

const update = "Os sete PRs já estão na main.";
const updateSignature = signedAs("narration");
const reasoningSignature = signedAs("thinking");
const shownUpdate = {
  type: "text" as const,
  text: update,
  textSignature: JSON.stringify({ v: 1, anthropicProgressUpdate: updateSignature }),
};

async function streamRequest(messages?: Context["messages"], thinkingEnabled = true) {
  const model = makeAnthropicTransportModel();
  const stream = await createAnthropicMessagesTransportStreamFn()(
    model,
    {
      messages: messages ?? [makeUserMessage("did you land the 7 PRs?", 0)],
      tools: [{ name: "wait", description: "wait", parameters: { type: "object" } }],
    },
    { apiKey: "sk-ant-api", ...(thinkingEnabled ? { reasoning: "high" } : {}) },
  );
  const events: Array<{ type: string; contentIndex?: number }> = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, result: await stream.result() };
}

function sentAssistantContent(): unknown[] {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const payload = JSON.parse(String(init?.body)) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  return payload.messages.filter((message) => message.role === "assistant").map((m) => m.content);
}

describe("Anthropic progress updates", () => {
  beforeAll(async () => {
    ({ createAnthropicMessagesTransportStreamFn } =
      await import("./anthropic-transport-stream.js"));
  });

  beforeEach(() => {
    installAnthropicTransportTestHost({
      coreTransportHost: getAiTransportHost(),
      buildModelFetch: buildGuardedModelFetchMock,
      guardedFetch: guardedFetchMock,
    });
  });

  it("shows a progress-update thinking block as text and keeps reasoning hidden", async () => {
    const thinkingDelta = (index: number, thinking: string) =>
      anthropicContentBlockDelta(index, { type: "thinking_delta", thinking });
    const signatureDelta = (index: number, signature: string) =>
      anthropicContentBlockDelta(index, { type: "signature_delta", signature });
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 5, output_tokens: 0 } }),
        anthropicContentBlockStart(0, { type: "thinking", thinking: "", signature: "" }),
        thinkingDelta(0, "Checking the PR states."),
        signatureDelta(0, reasoningSignature),
        { type: "content_block_stop", index: 0 },
        anthropicContentBlockStart(1, { type: "thinking", thinking: "", signature: "" }),
        thinkingDelta(1, update),
        signatureDelta(1, updateSignature),
        { type: "content_block_stop", index: 1 },
        anthropicContentBlockStart(2, { type: "tool_use", id: "toolu_1", name: "wait", input: {} }),
        { type: "content_block_stop", index: 2 },
        anthropicMessageDelta({ stop_reason: "tool_use" }, { input_tokens: 5, output_tokens: 9 }),
        { type: "message_stop" },
      ]),
    );

    const { events, result } = await streamRequest();

    expect(result.content.slice(0, 2)).toEqual([
      {
        type: "thinking",
        thinking: "Checking the PR states.",
        thinkingSignature: reasoningSignature,
      },
      shownUpdate,
    ]);
    const updateEvents = events.filter((event) => event.contentIndex === 1).map((e) => e.type);
    expect(updateEvents.slice(-3)).toEqual(["text_start", "text_delta", "text_end"]);
    expect(updateEvents).not.toContain("thinking_end");
  });

  it("returns a shown progress update to Anthropic as its signed thinking block", async () => {
    const model = makeAnthropicTransportModel();
    const assistant: AssistantMessage = {
      role: "assistant",
      provider: model.provider,
      api: "anthropic-messages",
      model: model.id,
      stopReason: "toolUse",
      timestamp: 1,
      usage: createZeroUsage(),
      content: [shownUpdate, { type: "toolCall", id: "toolu_1", name: "wait", arguments: {} }],
    };
    const question = makeUserMessage("did you land them?", 0);
    await streamRequest([
      question,
      assistant,
      {
        role: "toolResult",
        toolCallId: "toolu_1",
        toolName: "wait",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 2,
      },
    ]);
    expect(sentAssistantContent()).toEqual([
      [
        { type: "thinking", thinking: update, signature: updateSignature },
        { type: "tool_use", id: "toolu_1", name: "wait", input: {} },
      ],
    ]);

    // Without thinking replay, a completed turn's update stays ordinary text.
    const completed = {
      ...assistant,
      stopReason: "stop" as const,
      content: [shownUpdate],
    };
    await streamRequest([question, completed, makeUserMessage("thanks", 3)], false);
    expect(sentAssistantContent()).toEqual([[{ type: "text", text: update }]]);
  });
});
