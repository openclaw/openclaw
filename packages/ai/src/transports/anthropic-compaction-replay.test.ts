import type { AssistantMessage, Context } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import {
  buildAnthropicReplayPlan,
  createCompactionCapture,
  isAnthropicReplayRejection,
  suppressAnthropicCompaction,
} from "./anthropic-compaction-replay.js";
import { makeAnthropicTransportModel } from "./anthropic-transport-stream.test-support.js";
import { createAssistantOutput } from "./assistant-output.js";

const model = makeAnthropicTransportModel({ baseUrl: "https://api.anthropic.com/v1" });
const replayOptions = {
  enabled: true,
  sessionId: "session-1",
  authProfileId: "anthropic:work",
};

function assistant(texts: string[]): AssistantMessage {
  return {
    ...createAssistantOutput(model),
    content: texts.map((text) => ({ type: "text" as const, text })),
    timestamp: 1,
  };
}

function captureCheckpoint(message: AssistantMessage, summary: string, replayIndex: number): void {
  const capture = createCompactionCapture(message, model, replayOptions);
  capture.begin(0, { type: "compaction", content: summary }, replayIndex);
  capture.complete(0);
}

function contextWithCheckpoint(summary = "summary"): Context {
  const checkpoint = assistant(["before checkpoint", "after checkpoint"]);
  captureCheckpoint(checkpoint, summary, 1);
  return {
    messages: [
      { role: "user", content: "old question", timestamp: 0 },
      checkpoint,
      { role: "user", content: "new question", timestamp: 2 },
    ],
  };
}

it("uses the newest matching checkpoint", () => {
  const context = contextWithCheckpoint("older summary");
  const newest = assistant(["latest answer"]);
  captureCheckpoint(newest, "newest summary", 0);
  context.messages.push({ role: "user", content: "middle", timestamp: 3 }, newest, {
    role: "user",
    content: "latest question",
    timestamp: 4,
  });

  const plan = buildAnthropicReplayPlan(context.messages, model, replayOptions);

  expect(plan).toMatchObject({
    compaction: { content: "newest summary" },
    messages: [{ role: "assistant", content: newest.content }, { role: "user" }],
  });
});

it.each([{ sessionId: "session-2" }, { authProfileId: "anthropic:personal" }])(
  "keeps full history for a different replay identity: %j",
  (identity) => {
    const context = contextWithCheckpoint();

    const plan = buildAnthropicReplayPlan(context.messages, model, {
      ...replayOptions,
      ...identity,
    });

    expect(plan).toEqual({ messages: context.messages });
  },
);

it("stops replaying a suppressed checkpoint", () => {
  const context = contextWithCheckpoint();
  const rejected = assistant([]);
  suppressAnthropicCompaction(rejected, model, replayOptions, {
    type: "compaction",
    content: "summary",
  });
  context.messages.push(rejected);

  expect(buildAnthropicReplayPlan(context.messages, model, replayOptions)).toEqual({
    messages: context.messages,
  });
  expect(rejected.providerReplay).toMatchObject({
    type: "anthropic-compaction-suppression",
    data: "rejected",
  });
});

it("recognizes only targeted 400 replay rejections", () => {
  const rejected = [
    { status: 400, message: "context_management compaction block is invalid" },
    new Error("HTTP 400: compaction content could not be replayed"),
    { status: 400, message: "invalid model" },
    { status: 500, message: "compaction failed" },
  ];
  expect(rejected.map(isAnthropicReplayRejection)).toEqual([true, true, false, false]);
});
