import { beforeEach, describe, expect, it, vi } from "vitest";

const storeRef = vi.hoisted(() => ({
  value: {
    version: 1,
    pendingFinalReplies: {} as Record<string, unknown>,
  },
}));

const readJsonFileWithFallbackMock = vi.hoisted(() => vi.fn());
const writeJsonFileAtomicallyMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

vi.mock("openclaw/plugin-sdk/feishu", () => ({
  readJsonFileWithFallback: readJsonFileWithFallbackMock,
  writeJsonFileAtomically: writeJsonFileAtomicallyMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
}));

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

import {
  ackPendingFeishuFinalReply,
  beginFeishuActiveRun,
  endFeishuActiveRun,
  enqueuePendingFeishuFinalReply,
  replayPendingFeishuFinalReplies,
  sendFeishuShutdownInterruptionNotices,
} from "./restart-recovery.js";

describe("restart-recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    storeRef.value = {
      version: 1,
      pendingFinalReplies: {},
    };

    readJsonFileWithFallbackMock.mockImplementation(async (_path: string, fallback: unknown) => {
      const value = storeRef.value ?? fallback;
      return {
        value: clone(value),
        exists: true,
      };
    });

    writeJsonFileAtomicallyMock.mockImplementation(async (_path: string, value: unknown) => {
      storeRef.value = clone(value);
    });

    sendMessageFeishuMock.mockResolvedValue({ messageId: "om_sent" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "om_media" });
  });

  it("persists a final reply via enqueue and removes it on ack", async () => {
    const pendingId = await enqueuePendingFeishuFinalReply({
      accountId: "acc-enqueue",
      runMessageId: "om_run_1",
      chatId: "oc_chat_1",
      text: "done",
    });

    expect(pendingId).toBeTruthy();
    const key = "acc-enqueue:om_run_1";
    const persisted = (storeRef.value.pendingFinalReplies as Record<string, { text?: string }>)[
      key
    ];
    expect(persisted?.text).toBe("done");

    await ackPendingFeishuFinalReply({
      accountId: "acc-enqueue",
      runMessageId: "om_run_1",
      pendingId,
    });

    expect((storeRef.value.pendingFinalReplies as Record<string, unknown>)[key]).toBeUndefined();
  });

  it("replays pending final replies and clears them after successful delivery", async () => {
    (storeRef.value.pendingFinalReplies as Record<string, unknown>)["acc-replay-ok:om_run_2"] = {
      pendingId: "pending-ok-1",
      accountId: "acc-replay-ok",
      runMessageId: "om_run_2",
      chatId: "oc_chat_2",
      replyToMessageId: "om_parent_2",
      replyInThread: true,
      text: "final text",
      mediaUrls: ["https://example.com/a.png"],
      createdAtMs: Date.now(),
      attempts: 0,
    };

    await replayPendingFeishuFinalReplies({
      cfg: {} as never,
      accountId: "acc-replay-ok",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-replay-ok",
        to: "oc_chat_2",
        replyToMessageId: "om_parent_2",
        replyInThread: true,
        text: "final text",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-replay-ok",
        to: "oc_chat_2",
        mediaUrl: "https://example.com/a.png",
      }),
    );
    expect(
      (storeRef.value.pendingFinalReplies as Record<string, unknown>)["acc-replay-ok:om_run_2"],
    ).toBeUndefined();
  });

  it("keeps failed pending final replies and bumps attempts/lastError", async () => {
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("network down"));

    (storeRef.value.pendingFinalReplies as Record<string, unknown>)["acc-replay-fail:om_run_3"] = {
      pendingId: "pending-fail-1",
      accountId: "acc-replay-fail",
      runMessageId: "om_run_3",
      chatId: "oc_chat_3",
      text: "will retry",
      createdAtMs: Date.now(),
      attempts: 0,
    };

    await replayPendingFeishuFinalReplies({
      cfg: {} as never,
      accountId: "acc-replay-fail",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });

    const entry = (storeRef.value.pendingFinalReplies as Record<string, any>)[
      "acc-replay-fail:om_run_3"
    ];
    expect(entry).toBeTruthy();
    expect(entry.attempts).toBe(1);
    expect(String(entry.lastError)).toContain("network down");
  });

  it("drops stale pending final replies older than TTL", async () => {
    (storeRef.value.pendingFinalReplies as Record<string, unknown>)["acc-stale:om_run_4"] = {
      pendingId: "pending-stale-1",
      accountId: "acc-stale",
      runMessageId: "om_run_4",
      chatId: "oc_chat_4",
      text: "too old",
      createdAtMs: Date.now() - 25 * 60 * 60 * 1000,
      attempts: 0,
    };

    await replayPendingFeishuFinalReplies({
      cfg: {} as never,
      accountId: "acc-stale",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(
      (storeRef.value.pendingFinalReplies as Record<string, unknown>)["acc-stale:om_run_4"],
    ).toBeUndefined();
  });

  it("sends shutdown interruption notices for active runs and clears them", async () => {
    beginFeishuActiveRun({
      accountId: "acc-shutdown",
      chatId: "oc_chat_5",
      messageId: "om_run_5",
      replyToMessageId: "om_parent_5",
      replyInThread: true,
    });

    const first = await sendFeishuShutdownInterruptionNotices({
      cfg: {} as never,
      accountId: "acc-shutdown",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });
    const second = await sendFeishuShutdownInterruptionNotices({
      cfg: {} as never,
      accountId: "acc-shutdown",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-shutdown",
        to: "oc_chat_5",
        replyToMessageId: "om_parent_5",
        replyInThread: true,
      }),
    );
  });

  it("does not notify runs that were ended before shutdown", async () => {
    beginFeishuActiveRun({
      accountId: "acc-shutdown-end",
      chatId: "oc_chat_6",
      messageId: "om_run_6",
    });
    endFeishuActiveRun({
      accountId: "acc-shutdown-end",
      messageId: "om_run_6",
    });

    const sent = await sendFeishuShutdownInterruptionNotices({
      cfg: {} as never,
      accountId: "acc-shutdown-end",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });

    expect(sent).toBe(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});
