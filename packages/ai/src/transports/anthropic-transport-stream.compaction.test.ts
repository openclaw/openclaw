import type { AssistantMessage, Context, SimpleStreamOptions } from "@openclaw/llm-core";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
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

type AnthropicStreamOptions = SimpleStreamOptions & AnthropicTransportOptions;

function latestMessages() {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const body = init?.body;
  return (JSON.parse(body) as { messages: Record<string, unknown>[] }).messages;
}

async function runTransportStream(
  model: AnthropicMessagesModel,
  messages: Context["messages"],
  options: AnthropicStreamOptions = replayOptions,
) {
  return (await createAnthropicMessagesTransportStreamFn()(model, { messages }, options)).result();
}

function queueReply(id: string, blocks: Record<string, unknown>[] = [], compacting = false) {
  guardedFetchMock.mockResolvedValueOnce(
    createSseResponse([
      anthropicMessageStart({
        id,
        ...(compacting ? { model: "claude-sonnet-4-6" } : {}),
        usage: { input_tokens: compacting ? 50_001 : 1, output_tokens: 0 },
      }),
      ...blocks,
      anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
      { type: "message_stop" },
    ]),
  );
}
const blockStop = (index: number) => ({ type: "content_block_stop", index });
const replayIdentity = { authProfileId: "anthropic:work", sessionId: "session-1" };
const replayOptions = {
  apiKey: "sk-ant-api",
  anthropicServerCompaction: true,
  ...replayIdentity,
};
function queueCompaction(
  id: string,
  encrypted: string | null,
  deltas: Array<{ content: string | null; encrypted_content?: string }>,
) {
  queueReply(
    id,
    [
      anthropicContentBlockStart(0, {
        type: "compaction",
        content: null,
        encrypted_content: encrypted,
      }),
      ...deltas.map((delta) =>
        anthropicContentBlockDelta(0, { type: "compaction_delta", ...delta }),
      ),
      blockStop(0),
      anthropicContentBlockStart(1, { type: "text", text: "Done." }),
      blockStop(1),
    ],
    true,
  );
}

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
  queueCompaction("msg_compaction", "opaque-initial-compaction", [
    { content: "summary ", encrypted_content: "opaque-partial-compaction" },
    { content: "checkpoint", encrypted_content: "opaque-final-compaction" },
  ]);
  queueReply("msg_disabled", [
    anthropicContentBlockStart(0, { type: "text", text: "Replay was disabled." }),
    blockStop(0),
  ]);
  queueReply("msg_replay");
  const model = makeAnthropicTransportModel();
  const firstUser = makeUserMessage("old question", 1);
  const first = await runTransportStream(model, [firstUser]);

  expect(first.providerReplay).toMatchObject({
    type: "anthropic-compaction",
    data: "summary checkpoint",
    replayIndex: 0,
  });

  const offHistory = [firstUser, first, makeUserMessage("while disabled", 2)];
  const offOptions = { ...replayOptions, anthropicServerCompaction: false };
  const offResult = await runTransportStream(model, offHistory, offOptions);
  expect(JSON.stringify(latestMessages())).not.toContain('"type":"compaction"');
  expect(offResult.usage.contextUsage).toEqual({
    state: "available",
    promptTokens: 1,
    totalTokens: 2,
  });
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise persisted JSON reload, not an in-memory clone.
  const resumed: Context["messages"] = JSON.parse(
    JSON.stringify([...offHistory, offResult, makeUserMessage("new question", 3)]),
  );

  await runTransportStream(model, resumed);

  const replayMessages = latestMessages();
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
  queueCompaction("msg_null_compaction", null, [{ content: null }]);
  queueReply("msg_next");
  const model = makeAnthropicTransportModel();
  const options = {
    apiKey: "sk-ant-api",
    anthropicServerCompaction: true,
    sessionId: "session-1",
  } as unknown as AnthropicStreamOptions;
  const firstUser = makeUserMessage("old question", 1);

  const first = await runTransportStream(model, [firstUser], options);
  expect(first.providerReplay).toBeUndefined();
  expect(first.content.map((block) => block.type)).toEqual(["text"]);

  await runTransportStream(model, [firstUser, first, makeUserMessage("new question", 2)], options);
  const nextMessages = latestMessages();
  expect(nextMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  expect(JSON.stringify(nextMessages)).not.toContain('"type":"compaction"');
});

it("records suppression and notifies the owner when Anthropic rejects a replayed compaction block", async () => {
  const model = makeAnthropicTransportModel();
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
    [
      { role: "user", content: "old question" },
      checkpoint,
      { role: "user", content: "new question" },
    ] as Context["messages"],
    { ...replayOptions, onCompactionRejected },
  );

  expect(result.stopReason).toBe("error");
  expect(result.providerReplay).toMatchObject({
    type: "anthropic-compaction-suppression",
    data: "rejected",
  });
  expect(onCompactionRejected).toHaveBeenCalledExactlyOnceWith({ data: "summary checkpoint" });
  expect(guardedFetchMock).toHaveBeenCalledTimes(1);
});
