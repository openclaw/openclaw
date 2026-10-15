/**
 * Tests Anthropic server-compaction capture, replay, and rejection through the
 * Messages transport.
 */
import type { AssistantMessage, Context, SimpleStreamOptions } from "@openclaw/llm-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAiTransportHost, configureAiTransportHost } from "../host.js";
import { createZeroUsage } from "../usage.test-support.js";
import { createCompactionCapture } from "./anthropic-compaction-replay.js";
import type { AnthropicTransportOptions } from "./anthropic-transport-options.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import {
  anthropicContentBlockDelta,
  anthropicContentBlockStart,
  anthropicMessageDelta,
  anthropicMessageStart,
  createSseResponse,
  installAnthropicTransportTestHost,
  makeAnthropicTransportModel,
  type AnthropicMessagesModel,
} from "./anthropic-transport-stream.test-support.js";
import { resolveCompactionReplayPressure } from "./provider-compaction-replay.js";

const buildGuardedModelFetchMock = vi.fn();
const guardedFetchMock = vi.fn();
const coreTransportHost = getAiTransportHost();

type AnthropicStreamContext = Context;
type AnthropicStreamOptions = SimpleStreamOptions & AnthropicTransportOptions;

function latestAnthropicRequest() {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const body = init?.body;
  return {
    payload: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {},
  };
}

async function runTransportStream(
  model: AnthropicMessagesModel,
  context: AnthropicStreamContext,
  options: AnthropicStreamOptions,
) {
  return (await createAnthropicMessagesTransportStreamFn()(model, context, options)).result();
}

describe("anthropic transport stream compaction", () => {
  beforeEach(() => {
    installAnthropicTransportTestHost({
      coreTransportHost,
      buildModelFetch: buildGuardedModelFetchMock,
      guardedFetch: guardedFetchMock,
    });
  });

  afterAll(() => {
    configureAiTransportHost(coreTransportHost);
  });

  it("replays captured compaction after restart without trusting usage from disabled replay", async () => {
    guardedFetchMock
      .mockResolvedValueOnce(
        createSseResponse([
          anthropicMessageStart({
            id: "msg_compaction",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 50_001, output_tokens: 0 },
          }),
          anthropicContentBlockStart(0, {
            type: "compaction",
            content: null,
            encrypted_content: "opaque-initial-compaction",
          }),
          anthropicContentBlockDelta(0, {
            type: "compaction_delta",
            content: "summary ",
            encrypted_content: "opaque-partial-compaction",
          }),
          anthropicContentBlockDelta(0, {
            type: "compaction_delta",
            content: "checkpoint",
            encrypted_content: "opaque-final-compaction",
          }),
          { type: "content_block_stop", index: 0 },
          anthropicContentBlockStart(1, { type: "text", text: "Done." }),
          { type: "content_block_stop", index: 1 },
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
          { type: "message_stop" },
        ]),
      )
      .mockResolvedValueOnce(
        createSseResponse([
          anthropicMessageStart({
            id: "msg_disabled",
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
          anthropicContentBlockStart(0, { type: "text", text: "Replay was disabled." }),
          { type: "content_block_stop", index: 0 },
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
          { type: "message_stop" },
        ]),
      )
      .mockResolvedValueOnce(
        createSseResponse([
          anthropicMessageStart({ id: "msg_replay", usage: { input_tokens: 1, output_tokens: 0 } }),
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
          { type: "message_stop" },
        ]),
      );
    const model = makeAnthropicTransportModel();
    const replayOptions = {
      apiKey: "sk-ant-api",
      anthropicServerCompaction: true,
      authProfileId: "anthropic:work",
      sessionId: "session-1",
    } as unknown as AnthropicStreamOptions;
    const firstUser = { role: "user" as const, content: "old question", timestamp: 1 };
    const first = await runTransportStream(
      model,
      { messages: [firstUser] } as AnthropicStreamContext,
      replayOptions,
    );

    expect(first.providerReplay).toMatchObject({
      type: "anthropic-compaction",
      data: "summary checkpoint",
      replayIndex: 0,
    });

    const offContext = {
      messages: [
        firstUser,
        first,
        { role: "user" as const, content: "while disabled", timestamp: 2 },
      ],
    };
    const offOptions = { ...replayOptions, anthropicServerCompaction: false };
    const offResult = await runTransportStream(model, offContext, offOptions);
    expect(JSON.stringify(latestAnthropicRequest().payload.messages)).not.toContain(
      '"type":"compaction"',
    );
    expect(offResult.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 1,
      totalTokens: 2,
    });
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise persisted JSON reload, not an in-memory clone.
    const resumed: AnthropicStreamContext["messages"] = JSON.parse(
      JSON.stringify([
        ...offContext.messages,
        offResult,
        { role: "user", content: "new question", timestamp: 3 },
      ]),
    );

    await runTransportStream(model, { messages: resumed }, replayOptions);

    const replayMessages = latestAnthropicRequest().payload.messages as Array<
      Record<string, unknown>
    >;
    expect(replayMessages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(replayMessages[0]?.content).toEqual([
      {
        type: "compaction",
        content: "summary checkpoint",
        encrypted_content: "opaque-final-compaction",
      },
      { type: "text", text: "Done." },
    ]);
    const pressure = resolveCompactionReplayPressure(
      resumed,
      model,
      { ...replayOptions, enabled: true },
      {
        text: (text) => text.length,
        image: () => 100,
        json: (value) => JSON.stringify(value).length,
      },
    );
    expect(pressure?.prefixTokens).toBe("summary checkpoint".length);
    expect(pressure?.messages[2]).not.toHaveProperty("usage.contextUsage");
    expect(pressure?.messages[2]).toMatchObject({
      usage: { totalTokens: offResult.usage.totalTokens, cost: offResult.usage.cost },
    });
    expect(offResult.usage.contextUsage?.state).toBe("available");
  });

  it("keeps full history for client recovery when the compaction summary is null", async () => {
    guardedFetchMock
      .mockResolvedValueOnce(
        createSseResponse([
          anthropicMessageStart({
            id: "msg_null_compaction",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 50_001, output_tokens: 0 },
          }),
          anthropicContentBlockStart(0, {
            type: "compaction",
            content: null,
            encrypted_content: null,
          }),
          anthropicContentBlockDelta(0, { type: "compaction_delta", content: null }),
          { type: "content_block_stop", index: 0 },
          anthropicContentBlockStart(1, { type: "text", text: "Done." }),
          { type: "content_block_stop", index: 1 },
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
          { type: "message_stop" },
        ]),
      )
      .mockResolvedValueOnce(
        createSseResponse([
          anthropicMessageStart({ id: "msg_next", usage: { input_tokens: 1, output_tokens: 0 } }),
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
          { type: "message_stop" },
        ]),
      );
    const model = makeAnthropicTransportModel();
    const options = {
      apiKey: "sk-ant-api",
      anthropicServerCompaction: true,
      sessionId: "session-1",
    } as unknown as AnthropicStreamOptions;
    const firstUser = { role: "user" as const, content: "old question", timestamp: 1 };

    const first = await runTransportStream(
      model,
      { messages: [firstUser] } as AnthropicStreamContext,
      options,
    );
    expect(first.providerReplay).toBeUndefined();
    expect(first.content.map((block) => block.type)).toEqual(["text"]);

    await runTransportStream(
      model,
      {
        messages: [firstUser, first, { role: "user", content: "new question", timestamp: 2 }],
      } as AnthropicStreamContext,
      options,
    );
    const nextMessages = latestAnthropicRequest().payload.messages as Array<
      Record<string, unknown>
    >;
    expect(nextMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(nextMessages)).not.toContain('"type":"compaction"');
  });

  it("records suppression and notifies the owner when Anthropic rejects a replayed compaction block", async () => {
    const model = makeAnthropicTransportModel();
    const replayIdentity = {
      authProfileId: "anthropic:work",
      sessionId: "session-1",
    };
    const checkpoint: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "answer after compaction" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: model.id,
      usage: createZeroUsage(),
      stopReason: "stop",
      timestamp: 1,
    };
    const capture = createCompactionCapture(checkpoint, model, replayIdentity);
    capture.begin(0, { type: "compaction", content: "summary checkpoint" }, 0);
    capture.complete(0);
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "context_management compaction block is invalid" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const onCompactionRejected = vi.fn();

    const result = await runTransportStream(
      model,
      {
        messages: [
          { role: "user", content: "old question" },
          checkpoint,
          { role: "user", content: "new question" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        anthropicServerCompaction: true,
        ...replayIdentity,
        onCompactionRejected,
      } as unknown as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("error");
    expect(result.providerReplay).toMatchObject({
      type: "anthropic-compaction-suppression",
      data: "rejected",
    });
    expect(onCompactionRejected).toHaveBeenCalledExactlyOnceWith({ data: "summary checkpoint" });
    expect(guardedFetchMock).toHaveBeenCalledTimes(1);
  });
});
