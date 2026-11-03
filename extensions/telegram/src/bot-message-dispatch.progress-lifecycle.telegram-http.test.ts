import path from "node:path";
import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import type { ReplyDispatchRuntimeInfo } from "openclaw/plugin-sdk/reply-runtime";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import * as webMedia from "openclaw/plugin-sdk/web-media";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import type { ReplyResolverOptions } from "./bot-message-dispatch.telegram-http.test-support.js";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";
import { apiThrottler } from "./bot.runtime.js";
import { deliverReplies, deliverStructuredReplies } from "./bot/delivery.replies.js";
import { resolveTelegramTestUpload } from "./send.telegram-http.test-support.js";

const DELIVERY_WARNING = "I couldn't deliver my reply. Please ask again.";
type ProgressDraft = Parameters<NonNullable<ReplyDispatchRuntimeInfo["adoptProgressDraft"]>>[0];
function continuation(payload: ReplyPayload, adopt: (draft: ProgressDraft) => boolean) {
  return setReplyPayloadMetadata(payload, {
    progressContinuation: { adopt, close: () => undefined },
  });
}

const waitingText = "Waiting for delegated work.";
const heldCall = () => ({
  arrived: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
});
const childEvent = (title: string, itemId = "late-child") => ({
  itemId,
  kind: "subagent" as const,
  title,
  phase: "update" as const,
  status: "running" as const,
});

async function preamble(
  options: ReplyResolverOptions,
  itemId: string,
  progressText: string,
  phase: "start" | "update" | "end" = "end",
) {
  await options?.onItemEvent?.({ kind: "preamble", itemId, phase, progressText });
}

describe("Telegram progress custody and delivery outcomes through HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const {
    calls,
    visibleMessages,
    visibleMarkup,
    acceptedCalls,
    emitToolStart,
    dispatchProgressTurn,
    waitForBotApiCall: waitForCall,
  } = http;
  afterEach(() => vi.restoreAllMocks());

  const callsFor = (method: string) => calls.filter((call) => call.method === method);
  const texts = () => [...visibleMessages.values()];
  const dispatch = (
    events: Parameters<typeof dispatchProgressTurn>[0],
    scenario: Partial<NonNullable<Parameters<typeof dispatchProgressTurn>[1]>>,
  ) => dispatchProgressTurn(events, { mode: "progress", toolProgress: true, ...scenario });
  const reject = (description: string, error_code = 400) => ({ error_code, description });
  const tool = (options: ReplyResolverOptions, toolCallId: string, name = "exec") =>
    emitToolStart(options, { name, phase: "start", toolCallId });
  const deletedIds = () => callsFor("deleteMessage").map((call) => Number(call.fields.message_id));
  const eventually = <T>(read: () => T) => expect.poll(read, { timeout: 5_000 });
  async function startTool(options: ReplyResolverOptions, toolCallId: string) {
    await tool(options, toolCallId);
    await waitForCall((call) => call.method === "sendMessage");
  }
  async function retainProgress({
    accept = true,
    toolProgress = true,
    prepare = async (_options: ReplyResolverOptions) => {},
  } = {}) {
    let draft: ProgressDraft | undefined;
    let progressMessageId: number | undefined;
    let parentCallbacks: ReplyResolverOptions;
    await dispatch(
      async (options) => {
        parentCallbacks = options;
        await prepare(options);
        await startTool(options, "delegate");
        progressMessageId = [...visibleMessages.keys()][0];
      },
      {
        toolProgress,
        finalReply: continuation({ text: waitingText }, (candidate) => {
          draft = candidate;
          return accept;
        }),
      },
    );
    assert(draft);
    return {
      draft,
      parentCallbacks: parentCallbacks!,
      progressMessageId,
    };
  }

  it("reports an owner rejection silently without claiming a network failure", async () => {
    await dispatch(async () => {}, {
      mode: "off",
      toolProgress: false,
      cfg: { agents: { ownership: "explicit", entries: { main: {}, other: {} } } },
      telegramCfg: { silentErrorReplies: true },
      finalReply: { text: "The requested answer." },
      allowErrors: true,
    });
    const db = openNodeSqliteDatabase(path.join(http.state.stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        db
          .prepare(
            "SELECT id FROM delivery_queue_entries WHERE json_extract(entry_json, '$.recoveryState') IN ('send_attempt_started', 'unknown_after_send')",
          )
          .all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
    expect(texts()).toEqual([DELIVERY_WARNING]);
    const notice = calls.find((call) => call.fields.text === DELIVERY_WARNING);
    expect([notice?.fields.reply_markup, notice?.fields.disable_notification]).toEqual([
      undefined,
      true,
    ]);
    expect(JSON.stringify(calls)).not.toContain("network problem");
  });

  it.each(["rejected", "no-message-id", "stopped", "media", "buttons"] as const)(
    "delivers the continuation instead of adopting a %s progress card",
    async (outcome) => {
      const missingReceipt = outcome === "rejected" || outcome === "no-message-id";
      const reply: ReplyPayload = { text: waitingText };
      let adopted = false;
      if (missingReceipt) {
        http.respondToCall = (call) =>
          call.method === "sendMessage" && String(call.fields.text).includes("Pending delegation")
            ? outcome === "no-message-id"
              ? outcome
              : reject("Bad Request: progress rejected")
            : undefined;
      } else if (outcome === "media") {
        reply.mediaUrl = "https://example.test/report.pdf";
        vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
          buffer: Buffer.from("delegated report bytes"),
          contentType: "application/pdf",
          kind: undefined,
          fileName: "report.pdf",
        });
      } else if (outcome === "stopped") {
        // The user deleted the card, so its preview stops editing before the parent yields.
        http.respondToCall = (call) =>
          call.method === "editMessageText"
            ? reject("Bad Request: message to edit not found")
            : undefined;
      } else {
        reply.interactive = {
          blocks: [{ type: "buttons", buttons: [{ label: "Continue", value: "go" }] }],
        };
      }
      await dispatch(
        async (options) => {
          if (missingReceipt) {
            await preamble(options, "pending-parent", "Pending delegation");
          } else {
            await startTool(options, "delegate");
            if (outcome === "stopped") {
              await tool(options, "inspect", "read");
              await waitForCall((call) => call.method === "editMessageText");
            }
          }
        },
        {
          finalReply: continuation(reply, () => {
            adopted = true;
            return true;
          }),
        },
      );
      expect(adopted).toBe(false);
      if (missingReceipt) {
        expect(texts()).toEqual([waitingText]);
        expect(calls.some((call) => String(call.fields.text).includes("Pending delegation"))).toBe(
          true,
        );
      } else if (outcome === "stopped") {
        expect(texts()).toContain(waitingText);
      } else if (outcome === "media") {
        const document = acceptedCalls.find((call) => call.method === "sendDocument");
        const upload = resolveTelegramTestUpload(document!.fields, "document");
        expect(await upload.text()).toBe("delegated report bytes");
        expect(document?.fields.caption).toContain(waitingText);
      } else {
        expect([...visibleMarkup.values()]).toEqual([
          { inline_keyboard: [[{ text: "Continue", callback_data: "go" }]] },
        ]);
      }
    },
  );

  it.each(["empty-hook", "rejected-final"] as const)(
    "settles a %s without claiming visible delivery",
    async (outcome) => {
      const text = outcome === "empty-hook" ? outcome : "fail";
      if (outcome === "empty-hook") {
        const registry = createEmptyPluginRegistry();
        addTestHook({
          registry,
          pluginId: "http-outcome-policy",
          hookName: "reply_payload_sending",
          handler: (event: PluginHookReplyPayloadSendingEvent) =>
            event.payload.text === text ? { payload: { ...event.payload, text: "" } } : undefined,
        });
        initializeGlobalHookRunner(registry);
      } else {
        http.respondToCall = (call) =>
          call.method === "sendMessage" &&
          (call.fields.text === text || DELIVERY_WARNING.includes(String(call.fields.text)))
            ? reject("Bad Request: fixture delivery rejected")
            : undefined;
      }
      await dispatch(async () => undefined, {
        mode: "off",
        textLimit: 80,
        producer: async ({ dispatcher }) => {
          dispatcher.sendFinalReply({ text });
          const counts = dispatcher.getQueuedCounts();
          return { queuedFinal: counts.final > 0, counts };
        },
        allowErrors: true,
      });
      expect(
        calls.filter(
          (call) =>
            call.method === "sendMessage" && String(call.fields.text).startsWith(DELIVERY_WARNING),
        ),
      ).toHaveLength(outcome === "empty-hook" ? 0 : 1);
      if (outcome === "empty-hook") {
        expect(JSON.stringify(acceptedCalls)).not.toContain("cancel");
      } else {
        expect(
          calls.some((call) => call.method === "sendMessage" && call.fields.text === text),
        ).toBe(true);
      }
      expect(texts()).toEqual([]);
    },
  );

  it("delivers the final answer through repeated Telegram flood waits", async () => {
    const floodedAt: number[] = [];
    let flooded = Promise.withResolvers<void>();
    http.respondToCall = (call) => {
      if (
        call.method !== "sendMessage" ||
        call.fields.text !== "The command failed." ||
        floodedAt.length >= 3
      ) {
        return undefined;
      }
      floodedAt.push(Date.now());
      flooded.resolve();
      return {
        error_code: 429,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      };
    };
    const turn = dispatch((options) => startTool(options, "flood"), { allowErrors: true });
    for (let flood = 0; flood < 3; flood += 1) {
      await flooded.promise;
      flooded = Promise.withResolvers<void>();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await turn;

    expect(floodedAt).toHaveLength(3);
    expect(floodedAt[2]! - floodedAt[0]!).toBeGreaterThanOrEqual(10_000);
    expect(texts()).toEqual(["The command failed."]);
    expect(calls.some((call) => String(call.fields.text).startsWith(DELIVERY_WARNING))).toBe(false);
  });

  it("preserves a post-progress error final when Telegram rejects cleanup", async () => {
    http.respondToCall = (call) =>
      call.method === "deleteMessage"
        ? reject("Bad Request: progress cleanup rejected")
        : undefined;
    await dispatch((options) => startTool(options, "cleanup"), {
      textLimit: 80,
      finalReply: { text: "A".repeat(80) + "B".repeat(40), isError: true },
    });
    await vi.advanceTimersByTimeAsync(4_100);
    await waitForCall((call) => call.method === "deleteMessage");
    expect(texts().slice(1)).toEqual(["A".repeat(80), "B".repeat(40)]);
    expect(
      calls.filter((call) => call.fields.text === "No response generated. Please try again."),
    ).toEqual([]);
  });

  it.each([
    { accept: true, toolProgress: true },
    { accept: false, toolProgress: true },
    { accept: true, toolProgress: false },
  ])(
    "keeps the same card after accepted custody ($accept, tool log $toolProgress)",
    async ({ accept, toolProgress }) => {
      const commentary = "Parent commentary remains visible.";
      const { draft, parentCallbacks, progressMessageId } = await retainProgress({
        accept,
        toolProgress,
        prepare: async (options) => {
          await options?.onPlanUpdate?.({
            phase: "update",
            explanation: "Delegating the remaining work",
            steps: [
              { step: "Inspect the request", status: "completed" },
              { step: "Finish delegated work", status: "in_progress" },
            ],
          });
          await preamble(options, "parent-commentary", commentary);
        },
      });
      if (accept) {
        await preamble(
          parentCallbacks,
          "parent-commentary",
          "A retired parent must not replace the retained card.",
        );
        await parentCallbacks?.onPlanUpdate?.({ phase: "update", steps: [] });
        await parentCallbacks?.onQueuedFollowupSettled?.();
      }
      await vi.advanceTimersByTimeAsync(4_100);
      if (!accept) {
        await eventually(texts).toEqual([waitingText]);
        expect(deletedIds()).toEqual([progressMessageId]);
        return;
      }
      expect([...visibleMessages.entries()]).toEqual([
        [progressMessageId, expect.stringContaining(commentary)],
      ]);
      expect(texts()[0]).toContain("Finish delegated work");
      expect(callsFor("deleteMessage")).toEqual([]);
      expect(calls.some((call) => call.fields.text === waitingText)).toBe(false);

      draft?.push(childEvent("Delegated verification", "child"));
      await eventually(() => texts()[0]).toContain("Delegated verification");
      draft?.retire();
      await eventually(() => [...visibleMessages.keys()]).toEqual([]);
      expect(deletedIds()).toEqual([progressMessageId]);
      expect(callsFor("sendMessage")).toHaveLength(1);
    },
  );

  it("gives a queued turn its own progress card while the adopted card stays retained", async () => {
    const { draft, parentCallbacks } = await retainProgress();
    const [retained] = [...visibleMessages.entries()];
    assert(retained && draft);
    const [retainedId, retainedText] = retained;

    await parentCallbacks?.onQueuedFollowupAdmitted?.();
    await tool(parentCallbacks, "queued", "web_search");
    await eventually(() =>
      [...visibleMessages.entries()].filter(([id]) => id !== retainedId),
    ).toEqual([[expect.any(Number), expect.stringContaining("Web Search")]]);
    expect(visibleMessages.get(retainedId)).toBe(retainedText);

    draft.retire();
    await eventually(() => visibleMessages.has(retainedId)).toBe(false);
    expect(deletedIds()).toEqual([retainedId]);
  });

  it.each([false, true])(
    "rejects a retained edit still awaiting Telegram admission once the draft retires (retried: %s)",
    async (retried) => {
      // The account scheduler is where an edit waits before network admission.
      http.bot.api.config.use(
        getOrCreateAccountThrottler(http.token, () =>
          apiThrottler({ global: {}, group: { maxConcurrent: 1 }, out: { maxConcurrent: 1 } }),
        ).transformer,
      );
      const { draft, parentCallbacks } = await retainProgress();
      const [retainedId] = [...visibleMessages.keys()];
      assert(retainedId !== undefined && draft);
      const isEditWith =
        (title: string) => (call: { method: string; fields: Record<string, unknown> }) =>
          call.method === "editMessageText" && String(call.fields.text).includes(title);
      const pushChild = (title: string) => draft.push(childEvent(title));
      const entered: string[] = [];
      http.bot.api.config.use((previous, method, payload, signal) => {
        entered.push(`${method}:${JSON.stringify(payload)}`);
        return previous(method, payload, signal);
      });
      // A queued turn's card holds this chat's request lane, so the retained edit
      // under test waits in the account scheduler, not on the network.
      const held = {
        predicate: (call: { method: string }) => call.method === "sendMessage",
        ...heldCall(),
      };
      http.holdNextCall = held;
      const startQueuedTurn = async () => {
        await parentCallbacks?.onQueuedFollowupAdmitted?.();
        return tool(parentCallbacks, "queued", "web_search");
      };
      let queuedTool: Promise<unknown>;
      if (retried) {
        // The second update arrives while the first edit is in flight, so a
        // scheduled flush retries it after its first attempt fails, with no new
        // update to carry authority.
        const first = heldCall();
        const second = heldCall();
        let secondFailed = false;
        http.respondToCall = async (call) => {
          if (isEditWith("Late child first")(call)) {
            first.arrived.resolve();
            await first.release.promise;
            return undefined;
          }
          if (secondFailed || !isEditWith("Late child second")(call)) {
            return undefined;
          }
          secondFailed = true;
          second.arrived.resolve();
          await second.release.promise;
          return reject("Internal Server Error: fixture", 500);
        };
        pushChild("Late child first");
        await first.arrived.promise;
        pushChild("Late child second");
        await vi.advanceTimersByTimeAsync(2_000);
        first.release.resolve();
        await second.arrived.promise;
        queuedTool = startQueuedTurn();
        await eventually(() => entered.some((entry) => entry.includes("Web Search"))).toBe(true);
        second.release.resolve();
        await held.arrived.promise;
      } else {
        queuedTool = startQueuedTurn();
        await held.arrived.promise;
        pushChild("Late child second");
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        entered.filter(
          (entry) => entry.startsWith("editMessageText:") && entry.includes("Late child second"),
        ),
      ).toHaveLength(retried ? 2 : 1);
      draft.retire();
      held.release.resolve();
      await queuedTool;
      await eventually(() => visibleMessages.has(retainedId)).toBe(false);
      // Only a failed attempt made before retirement ever reached Telegram.
      expect(calls.filter(isEditWith("Late child second"))).toHaveLength(retried ? 1 : 0);
    },
  );

  it("shows compaction transitions and retires progress only after the final is accepted", async () => {
    const snapshots: string[] = [];
    let progressId: number | undefined;
    await dispatch(
      async (options) => {
        await preamble(options, "compaction", "Incomplete preamble", "update");
        await vi.advanceTimersByTimeAsync(1_500);
        expect(texts()).toEqual([]);
        await preamble(options, "compaction", "Checking the retained context.");
        await options?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Retain the current goal", status: "in_progress" }],
        });
        await options?.onCompactionStart?.();
        await waitForCall((call) => String(call.fields.text).includes("Compacting context"));
        progressId = [...visibleMessages.keys()][0];
        snapshots.push(visibleMessages.get(progressId!)!);
        expect(visibleMessages.get(progressId!)).toContain("Checking the retained context.");
        expect(visibleMessages.get(progressId!)).toContain("Retain the current goal");
        await preamble(options, "compaction", "", "start");
        await options?.onCompactionEnd?.({ completed: false });
        await waitForCall((call) => String(call.fields.text).includes("Compaction incomplete"));
        snapshots.push(visibleMessages.get(progressId!)!);
        expect(visibleMessages.get(progressId!)).not.toContain("Checking the retained context.");
        expect(visibleMessages.get(progressId!)).toContain("Retain the current goal");
        await options?.onCompactionStart?.();
        await options?.onCompactionEnd?.({ completed: true });
        await waitForCall((call) => String(call.fields.text).includes("Compaction complete"));
        snapshots.push(visibleMessages.get(progressId!)!);
      },
      { finalReply: { text: "Compaction finished." } },
    );
    expect(snapshots).toEqual([
      expect.stringContaining("Compacting context"),
      expect.stringContaining("Compaction incomplete"),
      expect.stringContaining("Compaction complete"),
    ]);
    expect(texts()).toEqual(["Compaction finished."]);
    expect(JSON.stringify(acceptedCalls)).not.toContain("Incomplete preamble");
    const finalAt = acceptedCalls.findIndex(
      (call) => call.method === "sendMessage" && call.fields.text === "Compaction finished.",
    );
    const retiredAt = acceptedCalls.findIndex(
      (call) => call.method === "deleteMessage" && Number(call.fields.message_id) === progressId,
    );
    expect(finalAt).toBeGreaterThanOrEqual(0);
    expect(retiredAt).toBeGreaterThan(finalAt);
  });

  it("suppresses typed reasoning while preserving literal answer text when reasoning is off", async () => {
    await dispatch(
      async (options) => {
        await options?.onBlockReply?.({ text: "< / internal", isReasoning: true });
        await vi.advanceTimersByTimeAsync(1_500);
        expect(texts()).toEqual([]);
        await options?.onReasoningStream?.({
          text: "<think>Checking independent evidence before answering.</think>",
          isReasoningSnapshot: true,
        });
      },
      {
        mode: "partial",
        cfg: { agents: { defaults: { reasoningDefault: "off" } } },
        finalReply: [
          { text: "A durable conclusion from the evidence.", isReasoning: true },
          { text: "Before <think>literal tag text after" },
        ],
      },
    );
    expect(texts()).toEqual(["Before &lt;think&gt;literal tag text after"]);
    expect(JSON.stringify(acceptedCalls)).not.toContain("internal");
    expect(JSON.stringify(acceptedCalls)).not.toContain("A durable conclusion");
  });

  it.each(["raw", "prepared"] as const)(
    "preserves the %s directive contract through the physical audio sender",
    async (source) => {
      const sender = source === "raw" ? deliverReplies : deliverStructuredReplies;
      const delivered = await sender({
        replies: [
          {
            text: "[[reply_to:999]] [[audio_as_voice]] Example",
            mediaUrl: "https://example.test/note.ogg",
          },
        ],
        bot: http.bot,
        chatId: "123",
        token: http.token,
        runtime: createNonExitingRuntime(),
        replyToMode: "off",
        textLimit: 4096,
        thread: { id: 777, scope: "dm" },
        mediaLoader: async () => ({
          buffer: Buffer.from("independent audio bytes"),
          contentType: "audio/ogg",
          kind: "audio",
          fileName: "note.ogg",
        }),
      });
      expect(delivered.delivered).toBe(true);
      const media = acceptedCalls.filter(
        (call) => call.method === "sendAudio" || call.method === "sendVoice",
      );
      expect(media).toHaveLength(1);
      const [call] = media;
      assert(call, "Expected an accepted Telegram audio upload");
      const caption = source === "raw" ? "Example" : "[[reply_to:999]] [[audio_as_voice]] Example";
      expect(call).toMatchObject({
        method: source === "raw" ? "sendVoice" : "sendAudio",
        fields: { message_thread_id: "777", caption },
      });
      expect([call.fields.reply_to_message_id, call.fields.reply_parameters]).toEqual([
        source === "raw" ? "999" : undefined,
        undefined,
      ]);
      expect(
        await resolveTelegramTestUpload(call.fields, source === "raw" ? "voice" : "audio").text(),
      ).toBe("independent audio bytes");
      expect(texts()).toEqual([caption]);
    },
  );
});
