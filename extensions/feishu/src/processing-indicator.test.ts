import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { createFeishuProcessingIndicator } from "./processing-indicator.js";
import { FeishuBackoffError } from "./typing-backoff.js";

function harness() {
  const assertJsonValue = (value: unknown): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(assertJsonValue);
      return;
    }
    if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(assertJsonValue);
      return;
    }
    throw new Error("processing receipt must be JSON-serializable");
  };
  const rows = new Map<string, unknown>();
  const calls: Array<{
    operation: "add" | "delete";
    messageId: string;
    reactionId?: string;
    emoji?: string;
  }> = [];
  const active = new Set<string>();
  const store = {
    lookup: vi.fn(async (key: string) => structuredClone(rows.get(key))),
    entries: vi.fn(async () =>
      [...rows].map(([key, value]) => ({ key, value: structuredClone(value), createdAt: 0 })),
    ),
    register: vi.fn(async (key: string, value: unknown) => {
      assertJsonValue(value);
      rows.set(key, structuredClone(value));
    }),
    registerIfAbsent: vi.fn(async (key: string, value: unknown) => {
      assertJsonValue(value);
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, structuredClone(value));
      return true;
    }),
  };
  const add = vi.fn(async ({ messageId, emojiType }: { messageId: string; emojiType: string }) => {
    const reactionId = `${messageId}:${emojiType}`;
    calls.push({ operation: "add", messageId, emoji: emojiType });
    active.add(reactionId);
    return { reactionId };
  });
  const remove = vi.fn(
    async ({ messageId, reactionId }: { messageId: string; reactionId: string }) => {
      calls.push({ operation: "delete", messageId, reactionId });
      active.delete(reactionId);
    },
  );
  const errors = vi.fn();
  const state = { openKeyedStore: () => store } as unknown as Pick<
    PluginRuntime["state"],
    "openKeyedStore"
  >;
  const makeOwner = () =>
    createFeishuProcessingIndicator({
      cfg: {} as ClawdbotConfig,
      accountId: "account-a",
      appId: "app-a",
      state,
      addReaction: add,
      removeReaction: remove,
      onError: errors,
    });
  const owner = makeOwner();
  const receive = (messageId: string, topicId = "topic-a") =>
    owner.receive({
      messageId,
      chatId: "chat-a",
      topicId,
      routeKey: `chat-a:${topicId}`,
    });
  return { owner, makeOwner, receive, rows, calls, active, add, remove, errors, store };
}

describe("Feishu automatic source processing reactions", () => {
  it("persists a DM without topicId and creates Wait then Typing with exact cleanup", async () => {
    const h = harness();
    const completion = createDeferred<void>();
    // The ingress supplies an explicitly undefined optional topic for p2p messages.
    const target = {
      messageId: "dm-source",
      chatId: "dm-chat",
      topicId: undefined,
      routeKey: JSON.stringify(["account-a", "dm-chat", ""]),
    };
    const message = h.owner.receive(target);
    message.queued();
    message.queued();
    await h.owner.drain();
    expect(h.active).toEqual(new Set(["dm-source:OneSecond"]));
    const key = JSON.stringify(["account-a", "app-a", "dm-chat", "", "dm-source"]);
    expect(h.rows.get(key)).toMatchObject({
      messageId: "dm-source",
      chatId: "dm-chat",
      accountId: "account-a",
      appId: "app-a",
      routeKey: target.routeKey,
    });
    expect(h.rows.get(key)).not.toHaveProperty("topicId");
    message.included({ runId: "dm-run", completion: completion.promise });
    await h.owner.drain();
    expect(h.active).toEqual(new Set(["dm-source:Typing"]));
    completion.resolve();
    await completion.promise;
    await h.owner.drain();
    expect(h.calls).toEqual([
      { operation: "add", messageId: "dm-source", emoji: "OneSecond" },
      { operation: "delete", messageId: "dm-source", reactionId: "dm-source:OneSecond" },
      { operation: "add", messageId: "dm-source", emoji: "Typing" },
      { operation: "delete", messageId: "dm-source", reactionId: "dm-source:Typing" },
    ]);
    expect(h.active.size).toBe(0);
    expect(h.errors).not.toHaveBeenCalled();
    const restarted = h.makeOwner();
    restarted.receive(target).queued();
    await restarted.drain();
    expect(h.add).toHaveBeenCalledTimes(2);
    expect(h.remove).toHaveBeenCalledTimes(2);
  });

  it("moves the latest queued source and confirmed steer in safe provider order", async () => {
    const h = harness();
    const completion = createDeferred<void>();
    const first = h.receive("first");
    first.queued();
    await h.owner.drain();
    first.included({ runId: "run-a", completion: completion.promise });
    await h.owner.drain();
    const second = h.receive("second");
    second.queued();
    await h.owner.drain();
    expect(h.active).toEqual(new Set(["first:Typing", "second:OneSecond"]));
    second.included({ runId: "run-a", completion: completion.promise });
    await h.owner.drain();
    expect(h.calls.slice(-3)).toEqual([
      { operation: "delete", messageId: "second", reactionId: "second:OneSecond" },
      { operation: "add", messageId: "second", emoji: "Typing" },
      { operation: "delete", messageId: "first", reactionId: "first:Typing" },
    ]);
    expect(h.active).toEqual(new Set(["second:Typing"]));
    completion.resolve();
    await completion.promise;
    await h.owner.drain();
    expect(h.active.size).toBe(0);
  });

  it("keeps a rejected steer queued for its follow-up and clears after final delivery", async () => {
    const h = harness();
    const firstDone = createDeferred<void>();
    const followupDone = createDeferred<void>();
    const first = h.receive("first");
    first.included({ runId: "first-run", completion: firstDone.promise });
    await h.owner.drain();
    const followup = h.receive("followup");
    followup.queued();
    await h.owner.drain();
    firstDone.resolve();
    await firstDone.promise;
    await h.owner.drain();
    expect(h.active).toEqual(new Set(["followup:OneSecond"]));
    followup.included({ runId: "followup-run", completion: followupDone.promise });
    await h.owner.drain();
    expect(h.active).toEqual(new Set(["followup:Typing"]));
    followupDone.resolve();
    await followupDone.promise;
    await h.owner.drain();
    expect(h.active.size).toBe(0);
  });

  it("keeps routes independent and never lets an old owner completion erase a newer run", async () => {
    const h = harness();
    const oldDone = createDeferred<void>();
    const newDone = createDeferred<void>();
    const otherDone = createDeferred<void>();
    h.receive("old").included({ runId: "old-run", completion: oldDone.promise });
    h.receive("other", "topic-b").included({ runId: "other-run", completion: otherDone.promise });
    await h.owner.drain();
    h.receive("new").included({ runId: "new-run", completion: newDone.promise });
    await h.owner.drain();
    oldDone.resolve();
    await oldDone.promise;
    await h.owner.drain();
    expect(h.active).toEqual(new Set(["new:Typing", "other:Typing"]));
    newDone.resolve();
    otherDone.resolve();
    await Promise.all([newDone.promise, otherDone.promise]);
    await h.owner.drain();
    expect(h.active.size).toBe(0);
  });

  it("deduplicates repeated queued/included calls and restart replay", async () => {
    const h = harness();
    const done = createDeferred<void>();
    const message = h.receive("same");
    expect(h.receive("same")).toBe(message);
    message.queued();
    message.queued();
    await h.owner.drain();
    message.included({ runId: "run", completion: done.promise });
    message.included({ runId: "run", completion: done.promise });
    await h.owner.drain();
    done.resolve();
    await done.promise;
    await h.owner.drain();
    expect(h.add).toHaveBeenCalledTimes(2);
    const restarted = h.makeOwner();
    restarted
      .receive({
        messageId: "same",
        chatId: "chat-a",
        topicId: "topic-a",
        routeKey: "chat-a:topic-a",
      })
      .queued();
    await restarted.drain();
    expect(h.add).toHaveBeenCalledTimes(2);
  });

  it("retains old feedback after failed transfer and never promotes an uncertain Wait", async () => {
    const h = harness();
    const done = createDeferred<void>();
    h.receive("old").included({ runId: "run", completion: done.promise });
    await h.owner.drain();
    h.add.mockRejectedValueOnce(new Error("uncertain Wait add"));
    const next = h.receive("new");
    next.queued();
    await h.owner.drain();
    next.included({ runId: "run", completion: done.promise });
    await h.owner.drain();
    expect(h.add.mock.calls.filter(([call]) => call.messageId === "new")).toHaveLength(1);
    expect(h.active).toEqual(new Set(["old:Typing"]));
    expect(h.errors).toHaveBeenCalled();
    done.resolve();
    await done.promise;
    await h.owner.drain();
    expect(h.active.size).toBe(0);
  });

  it("blocks same-source Typing after an exact Wait deletion fails", async () => {
    const h = harness();
    const done = createDeferred<void>();
    const message = h.receive("source");
    message.queued();
    await h.owner.drain();
    h.remove.mockRejectedValue(new Error("delete denied"));
    message.included({ runId: "run", completion: done.promise });
    await h.owner.drain();
    message.settled();
    await h.owner.drain();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.remove.mock.calls.every(([call]) => call.reactionId === "source:OneSecond")).toBe(
      true,
    );
    done.resolve();
    await done.promise;
    await h.owner.drain();
  });

  it("retries exact stored deletion on restart after the previous owner failed", async () => {
    const h = harness();
    const message = h.receive("recoverable");
    message.queued();
    await h.owner.drain();
    h.remove.mockRejectedValueOnce(new Error("temporary delete failure"));
    message.settled();
    await h.owner.drain();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.active).toEqual(new Set(["recoverable:OneSecond"]));

    const restarted = h.makeOwner();
    await restarted.drain();
    expect(h.remove).toHaveBeenCalledTimes(2);
    expect(h.remove.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        accountId: "account-a",
        messageId: "recoverable",
        reactionId: "recoverable:OneSecond",
      }),
    );
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.active.size).toBe(0);
  });

  it("does not wait for slow reactions and cleans a late receipt while stopping", async () => {
    const h = harness();
    const entered = createDeferred<void>();
    const response = createDeferred<{ reactionId: string }>();
    h.add.mockImplementationOnce(async () => {
      entered.resolve();
      return response.promise;
    });
    const message = h.receive("slow");
    expect(message.queued()).toBeUndefined();
    await entered.promise;
    h.owner.stop();
    h.receive("after-stop").queued();
    response.resolve({ reactionId: "only-our-late-receipt" });
    await h.owner.drain();
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.remove.mock.calls[0]?.[0]).toMatchObject({
      messageId: "slow",
      reactionId: "only-our-late-receipt",
      accountId: "account-a",
    });
    expect(h.rows.values().next().value).toMatchObject({
      wait: { phase: "removed", reactionId: "only-our-late-receipt" },
      appId: "app-a",
    });
  });

  it("cleans exact returned receipts if persistence fails after creation", async () => {
    const h = harness();
    h.store.register.mockImplementation(async (key, value) => {
      if ((value as { wait: { phase: string } }).wait.phase === "active") {
        throw new Error("state write failed");
      }
      h.rows.set(key, structuredClone(value));
    });
    h.receive("source").queued();
    await h.owner.drain();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.remove.mock.calls[0]?.[0]).toMatchObject({ reactionId: "source:OneSecond" });
    expect(h.active.size).toBe(0);
    expect(h.errors).toHaveBeenCalled();
  });

  it("retains exact ownership after both persistence and delete fail without re-adding", async () => {
    const h = harness();
    h.store.register.mockImplementation(async (_key, value) => {
      if ((value as { wait: { reactionId?: string } }).wait.reactionId) {
        throw new Error("receipt storage unavailable");
      }
    });
    h.remove.mockRejectedValue(new Error("receipt delete unavailable"));
    const message = h.receive("source");
    message.queued();
    await h.owner.drain();
    message.settled();
    await h.owner.drain();
    expect(h.receive("source")).toBe(message);
    message.queued();
    await h.owner.drain();
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.remove.mock.calls.every(([call]) => call.reactionId === "source:OneSecond")).toBe(
      true,
    );
  });

  it("does not persist sources that never enter the processing queue", async () => {
    const h = harness();
    h.receive("rejected").abandoned();
    const accepted = h.receive("accepted");
    accepted.queued();
    await h.owner.drain();
    expect(h.rows.size).toBe(1);
    expect(h.active).toEqual(new Set(["accepted:OneSecond"]));
    accepted.settled();
    await h.owner.drain();
  });

  it("continues processing when startup recovery cannot read entries", async () => {
    const h = harness();
    h.store.entries.mockRejectedValueOnce(new Error("recovery unavailable"));
    const message = h.receive("live");
    message.queued();
    await h.owner.drain();
    expect(h.active).toEqual(new Set(["live:OneSecond"]));
    expect(h.errors).toHaveBeenCalledOnce();
    message.settled();
    await h.owner.drain();
  });

  it("closes feedback after storage admission failure without blocking the next source", async () => {
    const h = harness();
    const failedKey = JSON.stringify(["account-a", "app-a", "chat-a", "topic-a", "failed"]);
    h.store.registerIfAbsent.mockImplementation(async (key, value) => {
      if (key === failedKey) {
        throw new Error("source receipt admission failed");
      }
      h.rows.set(key, structuredClone(value));
      return true;
    });
    const failed = h.receive("failed");
    failed.queued();
    await h.owner.drain();
    failed.queued();
    const next = h.receive("next");
    next.queued();
    await h.owner.drain();
    expect(h.active).toEqual(new Set(["next:OneSecond"]));
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.errors).toHaveBeenCalledOnce();
    next.settled();
    await h.owner.drain();
  });

  it("pauses automatic reactions on quota errors and resumes with a later accepted source", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const h = harness();
      const message = h.receive("owned");
      message.queued();
      await h.owner.drain();
      h.remove.mockRejectedValueOnce(new FeishuBackoffError(99991403));
      message.settled();
      await h.owner.drain();
      const paused = h.receive("during-backoff");
      paused.queued();
      await h.owner.drain();
      paused.abandoned();
      await h.owner.drain();
      expect(h.add).toHaveBeenCalledOnce();
      expect(h.remove).toHaveBeenCalledOnce();
      expect(h.active).toEqual(new Set(["owned:OneSecond"]));
      expect(h.errors.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ message: expect.stringContaining("paused for 60 seconds") }),
      );
      clock.mockReturnValue(61_000);
      const next = h.receive("after-backoff");
      next.queued();
      await h.owner.drain();
      expect(h.active).toEqual(new Set(["owned:OneSecond", "after-backoff:OneSecond"]));
      next.settled();
      await h.owner.drain();
      const restarted = h.makeOwner();
      await restarted.drain();
      expect(h.remove).toHaveBeenCalledTimes(3);
      expect(h.active.size).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("settles a run included during cooldown and cleans its exact Wait on replay", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const h = harness();
      const completion = createDeferred<void>();
      const source = h.receive("included-during-cooldown");
      source.queued();
      await h.owner.drain();
      h.add.mockRejectedValueOnce(new FeishuBackoffError(429));
      const quotaSource = h.receive("rate-limited", "other-route");
      quotaSource.queued();
      await h.owner.drain();
      quotaSource.abandoned();
      source.included({ runId: "run-during-cooldown", completion: completion.promise });
      await h.owner.drain();
      completion.resolve();
      await completion.promise;
      await h.owner.drain();
      expect(h.active).toEqual(new Set(["included-during-cooldown:OneSecond"]));
      clock.mockReturnValue(61_000);
      h.receive("included-during-cooldown").queued();
      await h.owner.drain();
      expect(h.active.size).toBe(0);
      expect(h.remove).toHaveBeenCalledOnce();
      expect(h.remove.mock.calls[0]?.[0]).toMatchObject({
        messageId: "included-during-cooldown",
        reactionId: "included-during-cooldown:OneSecond",
      });
      expect(h.calls.filter((call) => call.operation === "add")).toEqual([
        { operation: "add", messageId: "included-during-cooldown", emoji: "OneSecond" },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("never deletes stored receipts belonging to another application or corrupt source key", async () => {
    const h = harness();
    h.rows.set("foreign-key", {
      accountId: "account-a",
      appId: "app-a",
      chatId: "foreign",
      routeKey: "foreign",
      messageId: "foreign",
      wait: { phase: "active", reactionId: "foreign-reaction", deleteAttempts: 0 },
      typing: { phase: "idle", deleteAttempts: 0 },
    });
    h.rows.set("different-app", {
      accountId: "account-a",
      appId: "app-b",
      chatId: "chat-a",
      routeKey: "chat-a",
      messageId: "foreign",
      wait: { phase: "active", reactionId: "different-app-reaction", deleteAttempts: 0 },
      typing: { phase: "idle", deleteAttempts: 0 },
    });
    await h.owner.drain();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.errors).toHaveBeenCalled();
  });

  it.each(["NO_REPLY", "failure", "cancel"])("cleans current run after %s", async (outcome) => {
    const h = harness();
    const done = createDeferred<void>();
    h.receive("source").included({ runId: "run", completion: done.promise });
    await h.owner.drain();
    if (outcome === "failure") {
      done.reject(new Error("failed run"));
    } else {
      done.resolve();
    }
    await done.promise.catch(() => undefined);
    await h.owner.drain();
    expect(h.active.size).toBe(0);
  });
});
