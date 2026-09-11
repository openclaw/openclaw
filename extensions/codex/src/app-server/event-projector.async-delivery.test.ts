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

describe("CodexAppServerEventProjector async delivery", () => {
  it.each([
    { name: "disabled tools", disableTools: true },
    { name: "an empty tool allowlist", toolsAllow: [] },
    { name: "the ring-zero system tool", toolsAllow: ["openclaw"] },
    { name: "an allowlist without message delivery", toolsAllow: ["read"] },
  ])("does not expose native async messages through $name", async (restriction) => {
    const params = await createParams();
    const onAsyncDelivery = vi.fn().mockResolvedValue("settled");
    const projector = await createProjector({ ...params, ...restriction }, { onAsyncDelivery });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "unauthorized-async-update",
          phase: "final_answer",
          delivery: "async",
          text: "This restricted update must not reach a user.",
          questions: [{ title: "Should I continue?", options: ["Yes", "No"] }],
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "authorized-final",
          phase: "final_answer",
          text: "Ordinary final reply.",
        },
      ]),
    );

    expect(onAsyncDelivery).not.toHaveBeenCalled();
    expect(
      JSON.stringify(projector.buildResult(buildEmptyToolTelemetry()).messagesSnapshot),
    ).not.toContain("restricted update");
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
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "fallback-question",
          phase: "final_answer",
          delivery: "async",
          text: "Complete question and all choices.",
          questions,
        },
      }),
    );
    expect(onAsyncDelivery).toHaveBeenCalledOnce();
    const delivery = onAsyncDelivery.mock.calls[0]?.[0];
    expect(delivery.text).toBe("Complete question and all choices.");
    expect(delivery.message.openclawAsyncDelivery).toEqual({ itemId: "fallback-question" });
  });

  it.each([
    { name: "message", questions: undefined },
    {
      name: "questions",
      questions: [
        { title: "Which format should I use?", options: ["Markdown", "Plain text"] },
        { title: "Who is the audience?" },
      ],
    },
  ])(
    "persists async $name once without selecting it as the final answer",
    async ({ questions }) => {
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn();
      const params = await createParams();
      const sessionId = expectDefined(params.sessionId, "Codex async delivery test session");
      const storePath = `${params.workspaceDir}/openclaw-agent.sqlite`;
      params.sessionKey = "agent:main:session-1";
      const sessionTarget = {
        agentId: "main",
        sessionId,
        sessionKey: params.sessionKey,
        storePath,
      };
      params.sessionTarget = sessionTarget;
      await upsertSessionEntry({
        agentId: "main",
        sessionKey: params.sessionKey,
        storePath,
        entry: {
          sessionFile: params.sessionFile,
          sessionId,
          updatedAt: Date.now(),
        },
      });
      const projector = await createProjector(
        {
          ...params,
          onAgentEvent,
          onBlockReply,
        },
        {
          onAsyncDelivery: async (delivery) => {
            return await codexTranscriptMirrorRuntime.deliverAsyncMessageBestEffort({
              params: { ...params, onAgentEvent, onBlockReply },
              cwd: params.workspaceDir,
              threadId: "thread-1",
              turnId: TURN_ID,
              ...delivery,
            });
          },
        },
      );

      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "agentMessage",
            id: "terminal-answer",
            phase: "final_answer",
            text: "Finished.",
          },
        }),
      );
      const asyncCompletion = forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "async-update",
          phase: "final_answer",
          delivery: "async",
          text: "Background agent update.",
          ...(questions ? { questions } : {}),
        },
      });
      await projector.handleNotification(asyncCompletion);
      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(onBlockReply).toHaveBeenCalledWith(
        { text: "Background agent update." },
        {
          deliveryIntentId: `block-reply:v1:codex-app-server:thread-1:${TURN_ID}:async-update`,
        },
      );
      await projector.handleNotification(asyncCompletion);
      expect(onBlockReply).toHaveBeenCalledOnce();
      await projector.handleNotification(
        turnCompleted([
          {
            type: "agentMessage",
            id: "async-update",
            phase: "final_answer",
            delivery: "async",
            text: "Background agent update.",
            ...(questions ? { questions } : {}),
          },
          {
            type: "agentMessage",
            id: "terminal-answer",
            phase: "final_answer",
            text: "Finished.",
          },
        ]),
      );
      expect(onBlockReply).toHaveBeenCalledOnce();

      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.assistantTexts).toEqual(["Finished."]);
      expect(result.currentAttemptAssistant?.content).toEqual([
        { type: "text", text: "Finished." },
      ]);
      const asyncMessages = result.messagesSnapshot.filter(
        (message) =>
          (message as { openclawAsyncDelivery?: { itemId?: unknown } }).openclawAsyncDelivery
            ?.itemId === "async-update",
      );
      expect(asyncMessages).toHaveLength(1);
      expect(asyncMessages[0]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Background agent update." }],
        openclawAsyncDelivery: { itemId: "async-update", ...(questions ? { questions } : {}) },
        __openclaw: { mirrorIdentity: `${TURN_ID}:async:async-update` },
      });
      const transcriptMessages = (await readSessionTranscriptEvents(sessionTarget))
        .map((event) => (event as { message?: unknown }).message)
        .filter((message): message is Record<string, unknown> => Boolean(message));
      const persisted = transcriptMessages.filter(
        (message) =>
          (message.openclawAsyncDelivery as { itemId?: unknown } | undefined)?.itemId ===
          "async-update",
      );
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        openclawAsyncDelivery: { itemId: "async-update", ...(questions ? { questions } : {}) },
      });
      expect(
        onAgentEvent.mock.calls
          .map((call) => call[0])
          .filter(
            (event) =>
              event.stream === "item" &&
              event.data.itemId === "async-update" &&
              event.data.kind === "answer_candidate",
          ),
      ).toEqual([]);
    },
  );

  it("settles sessionless async delivery once across completion and terminal replay", async () => {
    const params = await createParams();
    const onBlockReply = vi.fn();
    const projector = await createProjector(
      { ...params, onBlockReply },
      {
        onAsyncDelivery: (delivery) =>
          codexTranscriptMirrorRuntime.deliverAsyncMessageBestEffort({
            params: { ...params, onBlockReply },
            cwd: params.workspaceDir,
            threadId: "thread-1",
            turnId: TURN_ID,
            ...delivery,
          }),
      },
    );
    const asyncItem = {
      type: "agentMessage" as const,
      id: "async-sessionless",
      phase: "final_answer",
      delivery: "async" as const,
      text: "Sessionless background update.",
    };
    const completion = forCurrentTurn("item/completed", { item: asyncItem });

    await projector.handleNotification(completion);
    await projector.handleNotification(completion);
    await projector.handleNotification(
      turnCompleted([
        asyncItem,
        {
          type: "agentMessage",
          id: "terminal-sessionless",
          phase: "final_answer",
          text: "Sessionless final.",
        },
      ]),
    );

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledWith(
      { text: "Sessionless background update." },
      {
        deliveryIntentId: `block-reply:v1:codex-app-server:thread-1:${TURN_ID}:async-sessionless`,
      },
    );
    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
      "Sessionless final.",
    ]);
  });

  it("retries unsettled sessionless async delivery when the real terminal summary contains only the final answer", async () => {
    const params = await createParams();
    const onBlockReply = vi
      .fn()
      .mockRejectedValueOnce(new Error("channel unavailable"))
      .mockResolvedValue(undefined);
    const projector = await createProjector(
      { ...params, onBlockReply },
      {
        onAsyncDelivery: (delivery) =>
          codexTranscriptMirrorRuntime.deliverAsyncMessageBestEffort({
            params: { ...params, onBlockReply },
            cwd: params.workspaceDir,
            threadId: "thread-1",
            turnId: TURN_ID,
            ...delivery,
          }),
      },
    );
    const asyncItem = {
      type: "agentMessage" as const,
      id: "async-retry",
      phase: "final_answer",
      delivery: "async" as const,
      text: "Retry this background update.",
    };
    const completed = turnCompleted([
      {
        type: "agentMessage",
        id: "terminal-retry",
        phase: "final_answer",
        text: "Retry final.",
      },
    ]);

    await projector.handleNotification(forCurrentTurn("item/completed", { item: asyncItem }));
    await projector.handleNotification(completed);
    await projector.handleNotification(completed);

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]).toEqual(onBlockReply.mock.calls[0]);
    expect(onBlockReply).toHaveBeenCalledWith(
      { text: "Retry this background update." },
      {
        deliveryIntentId: `block-reply:v1:codex-app-server:thread-1:${TURN_ID}:async-retry`,
      },
    );
    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
      "Retry final.",
    ]);
  });

  it("retains async delivery across reconstructed turn snapshots", async () => {
    const completed = turnCompleted([
      {
        type: "agentMessage",
        id: "async-reconnect",
        phase: "final_answer",
        delivery: "async",
        text: "Delivered while the client was reconnecting.",
        questions: [{ title: "What should I do next?", options: null }],
      },
      {
        type: "agentMessage",
        id: "terminal-reconnect",
        phase: "final_answer",
        text: "Reconnect complete.",
      },
    ]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const onAsyncDelivery = vi.fn().mockResolvedValue("settled");
      const projector = await createProjector(undefined, { onAsyncDelivery });
      await projector.handleNotification(completed);
      expect(onAsyncDelivery).toHaveBeenCalledOnce();
      expect(onAsyncDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: "async-reconnect",
          text: "Delivered while the client was reconnecting.",
        }),
      );
      const result = projector.buildResult(buildEmptyToolTelemetry());

      expect(result.assistantTexts).toEqual(["Reconnect complete."]);
      expect(
        result.messagesSnapshot.filter(
          (message) =>
            (message as { openclawAsyncDelivery?: { itemId?: unknown } }).openclawAsyncDelivery
              ?.itemId === "async-reconnect",
        ),
      ).toMatchObject([
        {
          role: "assistant",
          content: [{ type: "text", text: "Delivered while the client was reconnecting." }],
          __openclaw: { mirrorIdentity: `${TURN_ID}:async:async-reconnect` },
          openclawAsyncDelivery: {
            itemId: "async-reconnect",
            questions: [{ title: "What should I do next?" }],
          },
        },
      ]);
    }
  });
});
