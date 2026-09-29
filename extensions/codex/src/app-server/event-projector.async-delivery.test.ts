import { expectDefined } from "@openclaw/normalization-core";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  forCurrentTurn,
  registerCodexEventProjectorTestLifecycle,
  TURN_ID,
  turnCompleted,
} from "./event-projector.test-harness.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";

registerCodexEventProjectorTestLifecycle();
const finalAnswer = {
  type: "agentMessage" as const,
  id: "final",
  phase: "final_answer",
  text: "Finished.",
};
function asyncItem(id: string, questions?: { title: string; options?: string[] | null }[]) {
  return {
    type: "agentMessage" as const,
    id,
    phase: "final_answer",
    delivery: "async" as const,
    text: "Background agent update.",
    ...(questions ? { questions } : {}),
  };
}
function complete(item: ReturnType<typeof asyncItem>) {
  return forCurrentTurn("item/completed", { item });
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

describe("CodexAppServerEventProjector async delivery", () => {
  it.each([
    { name: "disabled tools", disableTools: true },
    { name: "a non-message tool allowlist", toolsAllow: ["read"] },
    { name: "the ring-zero system tool", toolsAllow: ["openclaw"] },
  ])("does not expose native async messages through $name", async (restriction) => {
    const onAsyncDelivery = vi.fn().mockResolvedValue("settled");
    const projector = await createProjector(
      { ...(await createParams()), ...restriction },
      { onAsyncDelivery },
    );
    await projector.handleNotification(
      complete(
        asyncItem("unauthorized", [{ title: "Should I continue?", options: ["Yes", "No"] }]),
      ),
    );
    await projector.handleNotification(turnCompleted([finalAnswer]));
    expect(onAsyncDelivery).not.toHaveBeenCalled();
    expect(
      JSON.stringify(projector.buildResult(buildEmptyToolTelemetry()).messagesSnapshot),
    ).not.toContain("Background agent update.");
  });

  it.each([
    {
      name: "too many options",
      questions: [{ title: "Pick a format", options: ["A", "B", "C", "D", "E"] }],
    },
    { name: "a blank title", questions: [{ title: " " }] },
    { name: "an oversized title", questions: [{ title: "Q".repeat(4_097) }] },
  ])("keeps the text fallback for $name", async ({ questions }) => {
    const onAsyncDelivery = vi.fn().mockResolvedValue("settled");
    const projector = await createProjector(undefined, { onAsyncDelivery });
    await projector.handleNotification(complete(asyncItem("fallback", questions)));
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
    await projector.handleNotification(forCurrentTurn("item/completed", { item: finalAnswer }));
    await projector.handleNotification(complete(item));
    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledWith(
      { text: item.text },
      { deliveryIntentId: `block-reply:v1:codex-app-server:thread-1:${TURN_ID}:async-update` },
    );
    await projector.handleNotification(complete(item));
    await projector.handleNotification(turnCompleted([item, finalAnswer]));
    expect(onBlockReply).toHaveBeenCalledOnce();
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Finished."]);
    expect(result.currentAttemptAssistant?.content).toEqual([{ type: "text", text: "Finished." }]);
    const asyncMessages = result.messagesSnapshot.filter(
      (message) =>
        (message as { openclawAsyncDelivery?: { itemId?: unknown } }).openclawAsyncDelivery
          ?.itemId === item.id,
    );
    expect(asyncMessages).toHaveLength(1);
    expect(asyncMessages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: item.text }],
      openclawAsyncDelivery: { itemId: item.id, questions },
      __openclaw: { mirrorIdentity: `${TURN_ID}:async:${item.id}` },
    });
    const persisted = (await readSessionTranscriptEvents(sessionTarget))
      .map((event) => (event as { message?: unknown }).message)
      .filter((message): message is Record<string, unknown> => Boolean(message))
      .filter(
        (message) =>
          (message.openclawAsyncDelivery as { itemId?: unknown } | undefined)?.itemId === item.id,
      );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ openclawAsyncDelivery: { itemId: item.id, questions } });
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) =>
            event.stream === "item" &&
            event.data.itemId === item.id &&
            event.data.kind === "answer_candidate",
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
    await projector.handleNotification(complete(item));
    await projector.handleNotification(completed);
    await projector.handleNotification(completed);
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]).toEqual(onBlockReply.mock.calls[0]);
    expect(onBlockReply).toHaveBeenCalledWith(
      { text: item.text },
      { deliveryIntentId: `block-reply:v1:codex-app-server:thread-1:${TURN_ID}:${item.id}` },
    );
    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual(["Finished."]);
  });

  it("retains async delivery across reconstructed turn snapshots", async () => {
    const item = asyncItem("async-reconnect", [{ title: "What should I do next?", options: null }]);
    const onAsyncDelivery = vi.fn().mockResolvedValue("settled");
    const projector = await createProjector(undefined, { onAsyncDelivery });
    await projector.handleNotification(turnCompleted([item, finalAnswer]));
    expect(onAsyncDelivery).toHaveBeenCalledOnce();
    expect(onAsyncDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: item.id, text: item.text }),
    );
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Finished."]);
    expect(
      result.messagesSnapshot.filter(
        (message) =>
          (message as { openclawAsyncDelivery?: { itemId?: unknown } }).openclawAsyncDelivery
            ?.itemId === item.id,
      ),
    ).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "text", text: item.text }],
        __openclaw: { mirrorIdentity: `${TURN_ID}:async:${item.id}` },
        openclawAsyncDelivery: {
          itemId: item.id,
          questions: [{ title: "What should I do next?" }],
        },
      },
    ]);
  });
});
