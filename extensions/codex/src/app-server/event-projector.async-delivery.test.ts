import { expectDefined } from "@openclaw/normalization-core";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";
import {
  complete,
  events,
  finish,
  message as agentMessage,
  result,
  text,
} from "./event-projector.compact.test-support.js";
import {
  createParams,
  createProjector,
  registerCodexEventProjectorTestLifecycle,
  TURN_ID,
  turnCompleted,
} from "./event-projector.test-harness.js";
import { isJsonObject } from "./protocol.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";

registerCodexEventProjectorTestLifecycle();
const finalAnswer = agentMessage("final", "Finished.", "final_answer");
function asyncItem(id: string, questions?: { title: string; options?: string[] | null }[]) {
  return {
    ...agentMessage(id, "Background agent update.", "final_answer"),
    delivery: "async" as const,
    ...(questions ? { questions } : {}),
  };
}
async function observeAsync(params?: Parameters<typeof createProjector>[0]) {
  const onAsyncDelivery = vi.fn().mockResolvedValue("settled");
  return { onAsyncDelivery, projector: await createProjector(params, { onAsyncDelivery }) };
}
function expectReply(callback: ReturnType<typeof vi.fn>, item: ReturnType<typeof asyncItem>) {
  expect(callback).toHaveBeenCalledWith(
    { text: item.text },
    { deliveryIntentId: `block-reply:v1:codex-app-server:thread-1:${TURN_ID}:${item.id}` },
  );
}
async function createDeliveringProjector(
  params: Awaited<ReturnType<typeof createParams>>,
  onBlockReply = vi.fn(),
  onAgentEvent = vi.fn(),
) {
  const runParams = { ...params, onBlockReply, onAgentEvent };
  return createProjector(runParams, {
    onAsyncDelivery: (delivery) =>
      codexTranscriptMirrorRuntime.deliverAsyncMessageBestEffort({
        params: runParams,
        cwd: params.workspaceDir,
        threadId: "thread-1",
        turnId: TURN_ID,
        ...delivery,
      }),
  });
}

it.each([
  { name: "disabled tools", disableTools: true },
  { name: "the ring-zero system tool", toolsAllow: ["openclaw"] },
])("does not expose native async messages through $name", async (restriction) => {
  const { projector, onAsyncDelivery } = await observeAsync({
    ...(await createParams()),
    ...restriction,
  });
  await complete(
    projector,
    asyncItem("unauthorized", [{ title: "Continue?", options: ["Yes", "No"] }]),
  );
  await finish(projector, [finalAnswer]);
  expect(onAsyncDelivery).not.toHaveBeenCalled();
  expect(JSON.stringify(result(projector).messagesSnapshot)).not.toContain(
    "Background agent update.",
  );
});

it.each([
  {
    name: "too many options",
    questions: [{ title: "Pick a format", options: ["A", "B", "C", "D", "E"] }],
  },
  { name: "a blank title", questions: [{ title: " " }] },
])("keeps the text fallback for $name", async ({ questions }) => {
  const { projector, onAsyncDelivery } = await observeAsync();
  await complete(projector, asyncItem("fallback", questions));
  expect(onAsyncDelivery).toHaveBeenCalledOnce();
  const delivery = onAsyncDelivery.mock.calls[0]?.[0];
  expect(delivery.text).toBe("Background agent update.");
  expect(delivery.message.openclawAsyncDelivery).toEqual({ itemId: "fallback" });
});

it("persists async questions once without selecting them as the final answer", async () => {
  const onAgentEvent = vi.fn();
  const onBlockReply = vi.fn();
  const params = await createParams();
  const sessionId = expectDefined(params.sessionId, "Codex async delivery test session");
  const sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:session-1",
    storePath: `${params.workspaceDir}/openclaw-agent.sqlite`,
  };
  params.sessionKey = sessionTarget.sessionKey;
  params.sessionTarget = sessionTarget;
  await upsertSessionEntry({
    ...sessionTarget,
    entry: { sessionFile: params.sessionFile, sessionId, updatedAt: Date.now() },
  });
  const projector = await createDeliveringProjector(params, onBlockReply, onAgentEvent);
  const questions = [
    { title: "Which format should I use?", options: ["Markdown", "Plain text"] },
    { title: "Who is the audience?" },
  ];
  const item = asyncItem("async-update", questions);
  await complete(projector, finalAnswer);
  await complete(projector, item);
  expect(onBlockReply).toHaveBeenCalledOnce();
  expectReply(onBlockReply, item);
  await complete(projector, item);
  await finish(projector, [item, finalAnswer]);
  expect(onBlockReply).toHaveBeenCalledOnce();
  const projected = result(projector);
  expect(projected.assistantTexts).toEqual(["Finished."]);
  expect(projected.currentAttemptAssistant?.content).toEqual(text("Finished."));
  const hasId = (message: unknown) =>
    isJsonObject(message) &&
    isJsonObject(message.openclawAsyncDelivery) &&
    message.openclawAsyncDelivery.itemId === item.id;
  const asyncMessages = projected.messagesSnapshot.filter(hasId);
  expect(asyncMessages).toHaveLength(1);
  expect(asyncMessages[0]).toMatchObject({
    role: "assistant",
    content: text(item.text),
    openclawAsyncDelivery: { itemId: item.id, questions },
    __openclaw: { mirrorIdentity: `${TURN_ID}:async:${item.id}` },
  });
  const persisted = (await readSessionTranscriptEvents(sessionTarget))
    .map((event) => (event as { message?: unknown }).message)
    .filter(hasId);
  expect(persisted).toHaveLength(1);
  expect(persisted[0]).toMatchObject({ openclawAsyncDelivery: { itemId: item.id, questions } });
  expect(
    events(onAgentEvent, "item", "answer_candidate").filter(
      (event) => event.data.itemId === item.id,
    ),
  ).toEqual([]);
});

it("retries unsettled sessionless delivery when the terminal summary contains only the final answer", async () => {
  const onBlockReply = vi
    .fn()
    .mockRejectedValueOnce(new Error("channel unavailable"))
    .mockResolvedValue(undefined);
  const projector = await createDeliveringProjector(await createParams(), onBlockReply);
  const item = asyncItem("async-retry");
  const completed = turnCompleted([finalAnswer]);
  await complete(projector, item);
  await projector.handleNotification(completed);
  await projector.handleNotification(completed);
  expect(onBlockReply).toHaveBeenCalledTimes(2);
  expect(onBlockReply.mock.calls[1]).toEqual(onBlockReply.mock.calls[0]);
  expectReply(onBlockReply, item);
  expect(result(projector).assistantTexts).toEqual(["Finished."]);
});
