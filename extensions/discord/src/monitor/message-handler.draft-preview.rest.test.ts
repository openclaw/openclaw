import { Routes } from "discord-api-types/v10";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import {
  createReplyDispatcher,
  type ReplyDispatchRuntimeInfo,
} from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { RequestClient } from "../internal/discord.js";
import { withDiscordRequestAuthority } from "../internal/request-authority.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";
import { createDiscordBeforePayloadDelivery } from "./message-handler.process-reply-runtime.js";

type Preview = ReturnType<typeof createDiscordDraftPreviewController>;
type PreviewOptions = Parameters<typeof createDiscordDraftPreviewController>[0];
type Harness = ReturnType<typeof createContinuationHarness>;
type RetainedDraft = Parameters<NonNullable<ReplyDispatchRuntimeInfo["adoptProgressDraft"]>>[0];

function createContinuationHarness(options?: {
  realTimers?: boolean;
  missingId?: boolean;
  queueRequests?: boolean;
  mode?: "partial" | "block" | "progress";
  isRoomEvent?: boolean;
  discordConfig?: PreviewOptions["discordConfig"];
}) {
  if (!options?.realTimers) {
    vi.useFakeTimers();
  }
  const visible = new Map<string, string>();
  let nextId = 0;
  const failures = { edit: false, rateLimitOnce: false, deletes: 0 };
  const rateLimited = createDeferred<void>();
  const admission: {
    beforeRequest?: (method: string) => Promise<void>;
    afterCreate?: () => Promise<void>;
    beforeCleanup?: () => Promise<void>;
  } = {};
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
        if (failures.deletes > 0) {
          failures.deletes--;
          return Response.json({ message: "temporarily unavailable" }, { status: 503 });
        }
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
      if (init.method === "POST") {
        await admission.afterCreate?.();
      }
      return Response.json(options?.missingId ? {} : { id: messageId });
    },
  });
  const controller = createDiscordDraftPreviewController({
    cfg: {},
    discordConfig: options?.discordConfig ?? {
      streaming: {
        mode: options?.mode ?? "progress",
        progress: { label: false, toolProgress: true },
      },
    },
    accountId: "default",
    sourceRepliesAreToolOnly: false,
    isRoomEvent: options?.isRoomEvent,
    textLimit: 2_000,
    deliveryRest: rest,
    deliverChannelId: "c1",
    replyReference: { peek: () => undefined },
    log: () => {},
  });
  let draft: RetainedDraft;
  const stream = controller.draftStream!;
  onTestFinished(async () => {
    try {
      await admission.beforeCleanup?.();
      if (draft) {
        draft.retire();
        await vi.advanceTimersByTimeAsync(0);
      }
      await controller.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
  return {
    controller,
    visible,
    failures,
    rest,
    requests,
    admission,
    rateLimited,
    stream,
    get draft() {
      return draft;
    },
    adopt(this: void, candidate: RetainedDraft) {
      draft = candidate;
      return true;
    },
  };
}

async function advancePreview(preview: Pick<Preview, "flush">, ms = 1_500) {
  await vi.advanceTimersByTimeAsync(ms);
  await preview.flush();
}

function childProgress(status: "running" | "completed") {
  return {
    itemId: "child",
    kind: "subagent" as const,
    title: "Review",
    status,
    ...(status === "completed" ? { phase: "end" as const } : {}),
  };
}

function expectCard(visible: Map<string, string>, contains: string[], excludes: string[] = []) {
  expect(visible.size).toBe(1);
  const [card] = visible.values();
  for (const text of contains) {
    expect(card).toContain(text);
  }
  for (const text of excludes) {
    expect(card).not.toContain(text);
  }
}

function assertAuthority(message: string, isOpen = () => false) {
  return () => {
    if (!isOpen()) {
      throw new Error(message);
    }
  };
}

async function deliverWaitingReply(
  harness: Harness,
  adopt: NonNullable<ReplyDispatchRuntimeInfo["adoptProgressDraft"]>,
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
    setReplyPayloadMetadata(
      { text: "Waiting for delegated work." },
      {
        continuationStatus: true,
        progressContinuation: { adopt, close: () => {} },
      },
    ),
  );
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  expect(onError).not.toHaveBeenCalled();
}

async function stageDelegation(controller: Preview) {
  await controller.pushItemEvent({
    kind: "preamble",
    itemId: "delegation",
    phase: "end",
    progressText: "Checking the implementation with delegated reviewers.",
  });
  await pushTool(controller, "sessions_spawn", "spawn");
}

function pushTool(
  controller: Preview,
  name: string,
  toolCallId: string,
  extra: Partial<Parameters<typeof projectAgentToolActivity>[0]> = {},
) {
  return controller.pushItemEvent(
    projectAgentToolActivity({ name, toolCallId, phase: "start", ...extra }),
  );
}

describe("Discord draft preview REST lifecycle", () => {
  it("keeps ambient room events private even with default progress", async () => {
    const { controller, visible } = createContinuationHarness({
      discordConfig: {},
      isRoomEvent: true,
    });
    await stageDelegation(controller);
    await controller.pushPlanProgress([{ step: "Private ambient work", status: "in_progress" }]);
    await advancePreview(controller);
    expect(controller.draftStream).toBeUndefined();
    expect(visible.size).toBe(0);
  });

  it.each([undefined, false, true])(
    "shows tool activity only when opted in (%s)",
    async (toolProgress) => {
      const { controller, visible } = createContinuationHarness({
        discordConfig:
          toolProgress === undefined ? {} : { streaming: { progress: { toolProgress } } },
      });
      await pushTool(controller, "sessions_search", "search", {
        args: { query: "PRIVATE_SEARCH_QUERY" },
      });
      await advancePreview(controller);
      expectCard(
        visible,
        [toolProgress ? "Session Search" : "Working"],
        toolProgress ? [] : ["PRIVATE_SEARCH_QUERY"],
      );
      if (!toolProgress) {
        expect([...visible.values()][0]).not.toContain("Session Search");
      }
      await controller.pushItemEvent({
        kind: "preamble",
        itemId: "status",
        progressText: "Checking the invitation history.",
      });
      await advancePreview(controller, 1_200);
      expectCard(visible, ["Checking the invitation history."]);
      await pushTool(controller, "sessions_search", "search", {
        phase: "result",
        status: "completed",
      });
      await controller.pushNarrationProgress("Comparing the results with the pending invitations.");
      await advancePreview(controller, 20_000);
      expectCard(visible, ["Comparing the results with the pending invitations."]);
      if (!toolProgress) {
        expect([...visible.values()][0]).not.toMatch(/Session Search|Last activity/);
      }
    },
  );

  it("keeps one confirmed card after yield and isolates a queued turn's cleanup", async () => {
    const harness = createContinuationHarness({ discordConfig: {} });
    const { controller, visible, requests } = harness;
    await stageDelegation(controller);
    await deliverWaitingReply(harness, harness.adopt);
    const { draft, stream } = harness;
    expect(draft).toBeDefined();
    expect(requests).toEqual(["POST"]);
    expect(controller.draftStream).toBeUndefined();
    await controller.cleanup();
    draft.push(childProgress("running"));
    await advancePreview(stream, 1_200);
    expect(visible.get("1")).toBe("Checking the implementation with delegated reviewers.");
    expect(visible.size).toBe(1);
    await controller.pushItemEvent({ kind: "preamble", progressText: "Late parent text" });
    expect(controller.handleQueuedFollowupAdmitted()).toBe(true);
    expect(controller.draftStream).not.toBe(stream);
    await pushTool(controller, "read", "queued-read");
    await advancePreview(controller);
    expect(visible.size).toBe(2);
    expect(visible.get("2")).toBe("Working");
    await controller.lifecycle.observeDelivery({ visibleReplySent: true });
    await controller.cleanup();
    expect([...visible.keys()]).toEqual(["1"]);
    draft.push(childProgress("completed"));
    await advancePreview(stream, 1_200);
    expect(visible.get("1")).toBe("Checking the implementation with delegated reviewers.");
    expect(visible.get("1")).not.toContain("Late parent text");
    draft.retire();
    draft.retire();
    await vi.advanceTimersByTimeAsync(0);
    expect(visible.size).toBe(0);
    expect(requests.filter((method) => method === "DELETE")).toHaveLength(2);
  });

  it("does not flush a progress final when delivery admission refuses custody", async () => {
    const { controller, requests } = createContinuationHarness();
    const adopt = vi.fn(() => true);
    await stageDelegation(controller);
    await advancePreview(controller);
    const priorRequests = [...requests];
    await expect(
      controller.adoptProgressDraft(
        { text: "Waiting for delegated work." },
        {
          kind: "final",
          adoptProgressDraft: adopt,
          onPlatformSendDispatch: async () => {
            throw new Error("Delivery custody belongs to an earlier attempt");
          },
        },
      ),
    ).rejects.toThrow("Delivery custody belongs to an earlier attempt");
    expect(requests).toEqual(priorRequests);
    expect(adopt).not.toHaveBeenCalled();
  });

  it.each(["missing-id", "stopped", "declined", "label-only"] as const)(
    "delivers the required waiting reply instead of adopting a %s card",
    async (scenario) => {
      const harness = createContinuationHarness({
        missingId: scenario === "missing-id",
        discordConfig: {},
      });
      const { controller, visible, failures } = harness;
      const adopt = vi.fn(() => scenario !== "declined");
      if (scenario === "label-only") {
        await controller.pushItemEvent({
          itemId: "read",
          kind: "tool",
          name: "read",
          phase: "update",
        });
        await advancePreview(controller);
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
    },
  );

  it("keeps initial and later child updates in the channel scope after requester authority closes", async () => {
    let serviceOpen = true;
    let requesterOpen = true;
    const serviceAssertion = vi.fn(assertAuthority("channel stopped", () => serviceOpen));
    const harness = withDiscordRequestAuthority(serviceAssertion, () =>
      createContinuationHarness({
        discordConfig: { streaming: { progress: { toolProgress: true } } },
      }),
    );
    const { controller, visible } = harness;
    harness.admission.beforeCleanup = async () => {
      serviceOpen = true;
    };
    await stageDelegation(controller);
    await withDiscordRequestAuthority(
      assertAuthority("requester settled", () => requesterOpen),
      () =>
        deliverWaitingReply(harness, (candidate) => {
          harness.adopt(candidate);
          candidate.push(childProgress("running"));
          requesterOpen = false;
          return true;
        }),
    );
    const { draft, stream } = harness;
    await advancePreview(stream, 1_200);
    expect(visible.get("1")).toContain("Review: running");
    withDiscordRequestAuthority(assertAuthority("unrelated child scope"), () => {
      draft.push(childProgress("completed"));
    });
    await advancePreview(stream, 1_200);
    expect(visible.get("1")).toContain("• Review");
    expect(visible.get("1")).not.toContain("Review: running");
    expect(serviceAssertion).toHaveBeenCalled();
    const accepted = visible.get("1");
    serviceOpen = false;
    draft.push({ itemId: "another", kind: "subagent", title: "Forbidden", status: "running" });
    await advancePreview(stream, 1_200);
    expect(visible.get("1")).toBe(accepted);
  });

  it.each(["admission", "rate-limit retry"] as const)(
    "fences a retained edit waiting for %s when the draft retires",
    async (boundary) => {
      const harness = createContinuationHarness({
        discordConfig: { streaming: { progress: { toolProgress: true } } },
        queueRequests: boundary === "rate-limit retry",
      });
      const { controller, visible, requests, admission, failures, rateLimited } = harness;
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      admission.beforeCleanup = async () => {
        release.resolve();
      };
      await stageDelegation(controller);
      await deliverWaitingReply(harness, harness.adopt);
      const { draft } = harness;
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
      draft.push(childProgress("running"));
      const advancing = vi.advanceTimersByTimeAsync(1_200);
      await (boundary === "admission" ? entered.promise : rateLimited.promise);
      draft.retire();
      release.resolve();
      await advancing;
      await vi.advanceTimersByTimeAsync(boundary === "rate-limit retry" ? 1_000 : 0);
      expect(requests).toEqual(
        boundary === "admission" ? ["POST", "DELETE"] : ["POST", "PATCH", "DELETE"],
      );
      expect(visible.size).toBe(0);
    },
  );

  it("preserves split code fences when block previews edit one message", async () => {
    const text = `\`\`\`text\n${"const value = 1;\n".repeat(60)}\`\`\``;
    const { controller, visible } = createContinuationHarness({ mode: "block", realTimers: true });
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

  it("retains the progress draft after an error final is delivered", async () => {
    const { controller, rest, visible, requests } = createContinuationHarness({ realTimers: true });
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

    expect(requests).toEqual(["POST", "POST"]);
    expect([...visible.values()]).toEqual(["Exec: failed", "Something failed"]);
  });

  it("removes the preview after two transient delete failures in one cleanup", async () => {
    const firstCreateStarted = createDeferred<void>();
    const finishFirstCreate = createDeferred<void>();
    const { controller, visible, failures, admission, requests } = createContinuationHarness({
      queueRequests: true,
    });
    failures.deletes = 2;
    admission.afterCreate = async () => {
      firstCreateStarted.resolve();
      await finishFirstCreate.promise;
    };
    controller.draftStream?.update("prior turn progress");
    await firstCreateStarted.promise;
    const cleanup = controller.cleanup();
    finishFirstCreate.resolve();
    await vi.runAllTimersAsync();
    await cleanup;

    expect([...visible]).toEqual([]);
    expect(requests).toEqual(["POST", "DELETE", "DELETE", "DELETE"]);
  });
});
