import { Routes } from "discord-api-types/v10";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import {
  createReplyDispatcher,
  type ReplyDispatchRuntimeInfo,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { RequestClient } from "../internal/discord.js";
import { withDiscordRequestAuthority } from "../internal/request-authority.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";
import { createDiscordBeforePayloadDelivery } from "./message-handler.process-reply-runtime.js";

function createPreviewController(
  rest: RequestClient,
  mode: "partial" | "block" | "progress" = "progress",
  overrides: Partial<Parameters<typeof createDiscordDraftPreviewController>[0]> = {},
) {
  return createDiscordDraftPreviewController({
    cfg: {},
    discordConfig: { streaming: { mode, progress: { label: false, toolProgress: true } } },
    accountId: "default",
    sourceRepliesAreToolOnly: false,
    textLimit: 2_000,
    deliveryRest: rest,
    deliverChannelId: "c1",
    replyReference: { peek: () => undefined },
    log: () => {},
    ...overrides,
  });
}

function createContinuationHarness(options?: {
  missingId?: boolean;
  queueRequests?: boolean;
  textLimit?: number;
  mode?: "partial" | "block" | "progress";
  discordConfig?: Parameters<typeof createDiscordDraftPreviewController>[0]["discordConfig"];
}) {
  const visible = new Map<string, string>();
  let nextId = 0;
  const failures = { edit: false, rateLimitOnce: false };
  const rateLimited = createDeferred<void>();
  const admission: { beforeRequest?: (method: string) => Promise<void> } = {};
  const requests: string[] = [];
  const rest = new RequestClient("test-token", {
    queueRequests: options?.queueRequests ?? false,
    fetch: async (input, init, assertCurrent?: () => void) => {
      await admission.beforeRequest?.(init?.method ?? "GET");
      assertCurrent?.();
      requests.push(init?.method ?? "GET");
      const url = new URL(input instanceof Request ? input.url : input);
      const id = url.pathname.split("/").at(-1)!;
      if (init?.method === "DELETE") {
        visible.delete(id);
        return new Response(null, { status: 204 });
      }
      if (init?.method === "PATCH" && failures.rateLimitOnce) {
        failures.rateLimitOnce = false;
        rateLimited.resolve();
        return Response.json({ message: "Rate limited", retry_after: 1 }, { status: 429 });
      }
      if (init?.method === "PATCH" && failures.edit) {
        return Response.json({ message: "edit unavailable" }, { status: 503 });
      }
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized Discord message");
      }
      const body = JSON.parse(init.body) as { content: string };
      const messageId = init.method === "POST" ? String(++nextId) : id;
      visible.set(messageId, body.content);
      return Response.json(options?.missingId ? {} : { id: messageId });
    },
  });
  const controller = createPreviewController(rest, options?.mode ?? "progress", {
    textLimit: options?.textLimit ?? 2_000,
    ...(options?.discordConfig !== undefined ? { discordConfig: options.discordConfig } : {}),
  });
  return { controller, visible, failures, rest, requests, admission, rateLimited };
}

type RetainedDraft = Parameters<NonNullable<ReplyDispatchRuntimeInfo["adoptProgressDraft"]>>[0];

async function deliverWaitingReply(
  harness: ReturnType<typeof createContinuationHarness>,
  adopt: NonNullable<ReplyDispatchRuntimeInfo["adoptProgressDraft"]>,
  payload: ReplyPayload = { text: "Waiting for delegated work." },
) {
  const { controller, rest } = harness;
  const onError = vi.fn();
  const dispatcher = createReplyDispatcher({
    beforeDeliver: createDiscordBeforePayloadDelivery({
      getDeliverTarget: () => "channel:c1",
      draftPreview: controller,
      isFallbackOnlyToolWarningFinal: () => false,
    }),
    deliver: async (reply, info) => {
      if (await controller.adoptProgressDraft(reply, info)) {
        return { visibleReplySent: true };
      }
      let visibleReplySent = false;
      await controller.lifecycle.deliver({
        kind: info.kind,
        payload: reply,
        deliverNormally: async () => {
          const sent = await rest.post(Routes.channelMessages("c1"), {
            body: { content: reply.text },
          });
          visibleReplySent = Boolean(sent && typeof sent === "object" && "id" in sent);
          return { visibleReplySent };
        },
      });
      return { visibleReplySent };
    },
    onError,
  });
  dispatcher.sendFinalReply(
    setReplyPayloadMetadata(payload, {
      continuationStatus: true,
      progressContinuation: { adopt, close: () => {} },
    }),
  );
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  expect(onError).not.toHaveBeenCalled();
}

async function stageDelegation(controller: ReturnType<typeof createDiscordDraftPreviewController>) {
  await controller.pushItemEvent({
    kind: "preamble",
    itemId: "delegation",
    phase: "end",
    progressText: "Checking the implementation with delegated reviewers.",
  });
  await controller.pushItemEvent(
    projectAgentToolActivity({
      name: "sessions_spawn",
      toolCallId: "spawn",
      phase: "start",
    }),
  );
}

describe("Discord draft preview REST lifecycle", () => {
  it("shows useful work status by default without streaming answer text", async () => {
    vi.useFakeTimers();
    const { controller, visible } = createContinuationHarness({ discordConfig: {} });
    try {
      await controller.pushItemEvent({
        itemId: "preamble-1",
        kind: "preamble",
        phase: "end",
        progressText: "Checking the channel delivery and running tests.",
      });
      await controller.pushItemEvent(
        projectAgentToolActivity({ toolCallId: "exec-1", name: "exec", phase: "start" }),
      );
      controller.updateFromPartial("Unfinished answer should stay private.");
      await vi.advanceTimersByTimeAsync(1_500);
      await controller.flush();
      expect([...visible.values()]).toEqual([
        "Checking the channel delivery and running tests.\n\nExec: running",
      ]);
    } finally {
      await controller.cleanup();
      vi.useRealTimers();
    }
    expect(visible.size).toBe(0);
  });

  it("keeps ambient room events private even with default progress", async () => {
    vi.useFakeTimers();
    const { rest, visible } = createContinuationHarness({ discordConfig: {} });
    const controller = createPreviewController(rest, "progress", {
      discordConfig: {},
      isRoomEvent: true,
    });
    try {
      await stageDelegation(controller);
      await controller.pushPlanProgress([{ step: "Private ambient work", status: "in_progress" }]);
      await vi.advanceTimersByTimeAsync(1_500);
      await controller.flush();
      expect(controller.draftStream).toBeUndefined();
      expect(visible.size).toBe(0);
    } finally {
      await controller.cleanup();
      vi.useRealTimers();
    }
  });

  it("shows running work without a preamble or utility narration", async () => {
    vi.useFakeTimers();
    const { controller, visible } = createContinuationHarness({ discordConfig: {} });
    try {
      await controller.pushItemEvent(
        projectAgentToolActivity({
          name: "exec",
          toolCallId: "long-exec",
          phase: "start",
          args: { command: "PRIVATE_COMMAND_ARGUMENT" },
        }),
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await controller.flush();
      expect(visible.size).toBe(1);
      expect([...visible.values()][0]).toContain("Exec: running");
      expect([...visible.values()][0]).not.toContain("PRIVATE_COMMAND_ARGUMENT");
    } finally {
      await controller.cleanup();
      vi.useRealTimers();
    }
  });

  it("prefixes tool rows with tool glyphs and keeps the reasoning and commentary lanes", async () => {
    vi.useFakeTimers();
    const { controller, visible } = createContinuationHarness({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: { label: false, toolProgress: true, commentary: true },
        },
      },
    });
    try {
      await controller.pushReasoningProgress("Planning the check");
      await controller.pushItemEvent({
        itemId: "preamble-1",
        kind: "preamble",
        phase: "end",
        progressText: "Looking at the workspace",
      });
      await controller.pushItemEvent(
        projectAgentToolActivity({ toolCallId: "exec-1", name: "exec", phase: "start" }),
      );
      await controller.pushItemEvent(
        projectAgentToolActivity({ toolCallId: "read-1", name: "read", phase: "start" }),
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await controller.flush();
      expect([...visible.values()]).toEqual([
        "🧠 _Planning the check_\n💬 Looking at the workspace\n🛠️ Exec: running\n📖 Read: running",
      ]);
    } finally {
      await controller.cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps one confirmed card after yield and isolates a queued turn's cleanup", async () => {
    vi.useFakeTimers();
    const harness = createContinuationHarness({ discordConfig: {} });
    const { controller, visible, requests } = harness;
    let draft: RetainedDraft | undefined;
    try {
      await stageDelegation(controller);
      const retainedStream = controller.draftStream!;
      await deliverWaitingReply(harness, (candidate) => {
        draft = candidate;
        return true;
      });
      expect(draft).toBeDefined();
      expect(requests).toEqual(["POST"]);
      expect(controller.draftStream).toBeUndefined();
      await controller.cleanup();
      draft!.push({ itemId: "child", kind: "subagent", title: "Review", status: "running" });
      await vi.advanceTimersByTimeAsync(1_200);
      await retainedStream.flush();
      expect(visible.get("1")).toContain("Review: running");
      expect(visible.size).toBe(1);
      await controller.pushItemEvent({ kind: "preamble", progressText: "Late parent text" });
      expect(controller.handleQueuedFollowupAdmitted()).toBe(true);
      expect(controller.draftStream).not.toBe(retainedStream);
      await controller.pushItemEvent(
        projectAgentToolActivity({
          name: "read",
          toolCallId: "queued-read",
          phase: "start",
        }),
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await controller.flush();
      expect(visible.size).toBe(2);
      expect(visible.get("2")).toContain("Read: running");
      await controller.lifecycle.observeDelivery({ visibleReplySent: true });
      await controller.cleanup();
      expect([...visible.keys()]).toEqual(["1"]);
      draft!.push({
        itemId: "child",
        kind: "subagent",
        title: "Review",
        status: "completed",
        phase: "end",
      });
      await vi.advanceTimersByTimeAsync(1_200);
      await retainedStream.flush();
      expect(visible.get("1")).toContain("Review: completed");
      expect(visible.get("1")).not.toContain("Late parent text");
      draft!.retire();
      draft!.retire();
      await vi.advanceTimersByTimeAsync(0);
      expect(visible.size).toBe(0);
      expect(requests.filter((method) => method === "DELETE")).toHaveLength(2);
    } finally {
      draft?.retire();
      await vi.advanceTimersByTimeAsync(0);
      await controller.cleanup();
      vi.useRealTimers();
    }
  });

  it.each(["missing-id", "stopped", "declined", "label-only", "off"] as const)(
    "delivers the required waiting reply instead of adopting a %s card",
    async (scenario) => {
      vi.useFakeTimers();
      const harness = createContinuationHarness({
        missingId: scenario === "missing-id",
        discordConfig: scenario === "off" ? { streaming: { mode: "off" } } : {},
      });
      const { controller, visible, failures } = harness;
      const adopt = vi.fn(() => scenario !== "declined");
      try {
        if (scenario === "label-only") {
          await controller.pushItemEvent({
            itemId: "read",
            kind: "tool",
            name: "read",
            phase: "update",
          });
          await vi.advanceTimersByTimeAsync(1_500);
          await controller.flush();
          expect(visible.size).toBe(1);
          expect([...visible.values()][0]).not.toContain("Read");
        } else {
          await stageDelegation(controller);
        }
        if (scenario === "stopped") {
          await vi.advanceTimersByTimeAsync(1_500);
          failures.edit = true;
          controller.draftStream?.update("This edit is rejected", { complete: true });
          await controller.flush();
          expect(controller.draftStream?.isStopped()).toBe(true);
        }
        await deliverWaitingReply(harness, adopt);
        expect(adopt).toHaveBeenCalledTimes(scenario === "declined" ? 1 : 0);
        expect([...visible.values()]).toContain("Waiting for delegated work.");
      } finally {
        await controller.cleanup();
        vi.useRealTimers();
      }
    },
  );

  it("keeps initial and later child updates in the channel scope after requester authority closes", async () => {
    vi.useFakeTimers();
    let serviceOpen = true;
    let requesterOpen = true;
    const serviceAssertion = vi.fn(() => {
      if (!serviceOpen) {
        throw new Error("channel stopped");
      }
    });
    const harness = withDiscordRequestAuthority(serviceAssertion, () =>
      createContinuationHarness({ discordConfig: {} }),
    );
    const { controller, visible } = harness;
    let draft: RetainedDraft | undefined;
    try {
      await stageDelegation(controller);
      const stream = controller.draftStream!;
      await withDiscordRequestAuthority(
        () => {
          if (!requesterOpen) {
            throw new Error("requester settled");
          }
        },
        () =>
          deliverWaitingReply(harness, (candidate) => {
            draft = candidate;
            candidate.push({
              itemId: "child",
              kind: "subagent",
              title: "Review",
              status: "running",
            });
            requesterOpen = false;
            return true;
          }),
      );
      await vi.advanceTimersByTimeAsync(1_200);
      await stream.flush();
      expect(visible.get("1")).toContain("Review: running");
      withDiscordRequestAuthority(
        () => {
          throw new Error("unrelated child scope");
        },
        () => {
          draft!.push({
            itemId: "child",
            kind: "subagent",
            title: "Review",
            status: "completed",
            phase: "end",
          });
        },
      );
      await vi.advanceTimersByTimeAsync(1_200);
      await stream.flush();
      expect(visible.get("1")).toContain("Review: completed");
      expect(serviceAssertion).toHaveBeenCalled();
      const accepted = visible.get("1");
      serviceOpen = false;
      draft!.push({ itemId: "another", kind: "subagent", title: "Forbidden", status: "running" });
      await vi.advanceTimersByTimeAsync(1_200);
      await stream.flush();
      expect(visible.get("1")).toBe(accepted);
    } finally {
      serviceOpen = true;
      draft?.retire();
      await vi.advanceTimersByTimeAsync(0);
      await controller.cleanup();
      vi.useRealTimers();
    }
  });

  it.each(["admission", "rate-limit retry"] as const)(
    "fences a retained edit waiting for %s when the draft retires",
    async (boundary) => {
      vi.useFakeTimers();
      const harness = createContinuationHarness({
        discordConfig: {},
        queueRequests: boundary === "rate-limit retry",
      });
      const { controller, visible, requests, admission, failures, rateLimited } = harness;
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let draft: RetainedDraft | undefined;
      try {
        await stageDelegation(controller);
        await deliverWaitingReply(harness, (candidate) => {
          draft = candidate;
          return true;
        });
        if (boundary === "admission") {
          admission.beforeRequest = async (method) => {
            if (method === "PATCH") {
              entered.resolve();
              await release.promise;
            }
          };
        } else {
          failures.rateLimitOnce = true;
        }
        draft!.push({ itemId: "child", kind: "subagent", title: "Review", status: "running" });
        const advancing = vi.advanceTimersByTimeAsync(1_200);
        await (boundary === "admission" ? entered.promise : rateLimited.promise);
        draft!.retire();
        release.resolve();
        await advancing;
        await vi.advanceTimersByTimeAsync(boundary === "rate-limit retry" ? 1_000 : 0);
        expect(requests).toEqual(
          boundary === "admission" ? ["POST", "DELETE"] : ["POST", "PATCH", "DELETE"],
        );
        expect(visible.size).toBe(0);
      } finally {
        release.resolve();
        draft?.retire();
        await vi.advanceTimersByTimeAsync(0);
        await controller.cleanup();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { name: "paragraph separators", text: `${"A".repeat(500)}\n\n${"B".repeat(500)}` },
    { name: "split code fences", text: `\`\`\`text\n${"const value = 1;\n".repeat(60)}\`\`\`` },
  ])("preserves $name when block previews edit one message", async ({ text }) => {
    const { controller, visible } = createContinuationHarness({ mode: "block" });
    try {
      controller.updateFromPartial(text);
      await controller.flush();
      expect([...visible.values()]).toEqual([text]);
      await controller.lifecycle.observeDelivery({ visibleReplySent: true });
    } finally {
      await controller.cleanup();
    }
    expect([...visible.values()]).toEqual([]);
  });

  it.each(["block"] as const)(
    "publishes and retracts a short complete plan, then resumes in %s mode",
    async (mode) => {
      const { controller, visible } = createContinuationHarness({ mode });

      await controller.pushPlanProgress([]);
      expect(visible.size).toBe(0);
      await controller.pushPlanProgress([{ step: "Check", status: "in_progress" }]);
      await controller.flush();
      expect([...visible.values()]).toEqual(["▸ Check"]);
      await controller.pushPlanProgress([], { explanation: "Progress updated" });
      await controller.flush();
      expect([...visible.values()]).toEqual(["Progress updated"]);
      await controller.pushPlanProgress([]);
      expect(visible.size).toBe(0);
      await controller.pushPlanProgress([{ step: "Retry", status: "pending" }]);
      await controller.flush();
      expect([...visible.values()]).toEqual(["▢ Retry"]);
      controller.handleAssistantMessageBoundary();
      await controller.pushItemEvent({
        itemId: "card-rejected",
        kind: "tool",
        name: "progress_card",
        phase: "end",
        status: "blocked",
        meta: '<progress aria-label="private detail"></progress>',
      });
      controller.handleAssistantMessageBoundary();
      await controller.pushItemEvent(
        projectAgentToolActivity({ toolCallId: "exec-1", name: "exec", phase: "start" }),
      );
      await controller.pushToolEvent({ toolCallId: "exec-1", name: "exec", phase: "start" });
      await controller.flush();
      expect(visible.size).toBe(1);
      const withActivity = [...visible.values()][0];
      expect(withActivity).toContain("▢ Retry");
      expect(withActivity).toContain("blocked");
      expect(withActivity).toContain("Exec");
      expect(withActivity).not.toContain("private detail");
      controller.handleAssistantMessageBoundary();
      await controller.pushPlanProgress([]);
      await controller.flush();
      expect(visible.size).toBe(1);
      const afterClear = [...visible.values()][0];
      expect(afterClear).not.toContain("Retry");
      expect(afterClear).toContain("blocked");
      expect(afterClear).toContain("Exec");
      await controller.cleanup();
    },
  );

  it("retains the progress draft after an error final is delivered", async () => {
    const requests: string[] = [];
    const rest = new RequestClient("test-token", {
      queueRequests: false,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        requests.push(`${init?.method ?? "GET"} ${url.pathname.replace("/api/v10", "")}`);
        if (init?.method === "POST") {
          return Response.json({ id: "999" });
        }
        return new Response(null, { status: 204 });
      },
    });
    const controller = createPreviewController(rest);

    controller.draftStream?.update("Exec: failed");
    await controller.flush();
    await controller.lifecycle.deliver({
      kind: "final",
      payload: { text: "Something failed", isError: true },
      isError: true,
      deliverNormally: async (payload) => {
        const sent = (await rest.post(Routes.channelMessages("c1"), {
          body: { content: payload.text },
        })) as { id: string };
        return { messageIds: [sent.id], visibleReplySent: true };
      },
    });
    controller.draftStream?.update("stale pending update");
    await controller.cleanup();
    await controller.flush();

    expect(requests).toEqual(["POST /channels/c1/messages", "POST /channels/c1/messages"]);
  });

  it("retries teardown cleanup after two failed preview deletions", async () => {
    const firstCreateStarted = createDeferred<void>();
    const finishFirstCreate = createDeferred<void>();
    const visibleMessages = new Map<string, string>();
    const deletedIds: string[] = [];
    let createdCount = 0;
    const rest = new RequestClient("test-token", {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (init?.method === "POST") {
          const id = String(++createdCount);
          if (typeof init.body !== "string") {
            throw new Error("Expected a serialized Discord JSON request body");
          }
          const body = JSON.parse(init.body) as { content: string };
          visibleMessages.set(id, body.content);
          if (createdCount === 1) {
            firstCreateStarted.resolve();
            await finishFirstCreate.promise;
          }
          return Response.json({ id });
        }
        if (init?.method === "DELETE") {
          const id = url.pathname.split("/").at(-1)!;
          deletedIds.push(id);
          if (deletedIds.length <= 2) {
            return Response.json({ message: "temporarily unavailable" }, { status: 503 });
          }
          visibleMessages.delete(id);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected Discord request: ${init?.method} ${url.pathname}`);
      },
    });
    const controller = createPreviewController(rest);

    controller.draftStream?.update("prior turn progress");
    await firstCreateStarted.promise;
    const cleanup = controller.cleanup();
    finishFirstCreate.resolve();
    await cleanup;

    expect(deletedIds).toEqual(["1", "1"]);
    expect([...visibleMessages]).toEqual([["1", "prior turn progress"]]);
    await controller.cleanup();
    expect([...visibleMessages]).toEqual([]);
    expect(deletedIds.filter((id) => id === "1")).toHaveLength(3);
  });
});
