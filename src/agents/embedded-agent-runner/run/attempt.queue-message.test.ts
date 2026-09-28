import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore as deferred } from "../../../shared/deferred.js";
import type { AgentHarnessQuestionGatewayCall } from "../../harness/gateway-question-dispatch.js";
import { runAgentHarnessGatewayQuestion } from "../../harness/gateway-question.js";
import { registerQueuedUserMessageRetirement } from "../../sessions/queued-user-message-retirement.js";
import {
  reportSteeringMessagePersistenceFailure,
  setSteeringMessageIdentity,
} from "../../sessions/steering-message-identity.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "./attempt-queue-message.js";

type Session = Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[0];
type Options = NonNullable<Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[2]>;
type Message = Parameters<typeof setSteeringMessageIdentity>[0];
const terminalError =
  "active session ended before queued steering message was committed to the transcript";
const timeoutError = "queued steering message was not committed to the transcript before timeout";

afterEach(() => vi.useRealTimers());

function message(text: string, identity: string = text): Message {
  const entry = { role: "user", content: [{ type: "text", text }], timestamp: 1 } satisfies Message;
  setSteeringMessageIdentity(entry, identity);
  return entry;
}

function fixture(queue: Message[] = [], target = queue[0]) {
  const listeners = new Set<(event: unknown) => void>();
  const retire = vi.fn(() => true);
  if (target) {
    registerQueuedUserMessageRetirement(target, retire);
  }
  const session: Session = {
    agent: {
      cancelSteeringMessage: (predicate) => {
        const index = queue.findIndex(predicate);
        return index < 0 ? undefined : queue.splice(index, 1)[0];
      },
    },
    steer: async (_text, _images, _recorder, _media, _imageOrder, identity) => {
      if (target) {
        setSteeringMessageIdentity(target, identity);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    session,
    queue,
    listeners,
    retire,
    emit(event: unknown) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    wait(text: string, options: Options = {}) {
      return steerActiveSessionWithOptionalDeliveryWait(session, text, {
        deliveryTimeoutMs: 10_000,
        waitForTranscriptCommit: true,
        ...options,
      });
    },
  };
}

describe("embedded OpenClaw queued steering cancellation", () => {
  it.each(["text", "offloaded", "recorded"] as const)(
    "keeps %s replies distinct from harness secrets",
    async (kind) => {
      const secretValue = "test-secret-value-123";
      const sessionKey = "agent:main:secret-transcript";
      const media = [{ path: "/tmp/image.png", contentType: "image/png" }];
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: secretValue, ...(kind === "recorded" ? { media } : {}) },
        target: createTestUserTurnTranscriptTarget({ sessionKey }),
      });
      const persistApproved = vi.spyOn(recorder, "persistApproved").mockResolvedValue(undefined);
      const pendingSecret = runAgentHarnessGatewayQuestion({
        questions: [
          {
            id: "credential",
            header: "API key",
            question: "Enter the requested credential",
            isSecret: true,
            options: [],
          },
        ],
        sessionKey,
        timeoutMs: 60_000,
        gatewayCall: vi.fn<AgentHarnessQuestionGatewayCall>(),
        delivery: { onBlockReply: vi.fn(async () => undefined) },
      });
      const steer = vi.fn(async () => undefined);
      await steerActiveSessionWithOptionalDeliveryWait(
        { steer, subscribe: () => () => {} },
        secretValue,
        {
          isInboundUserMessage: true,
          currentInboundContext: {
            text: "Replied message (untrusted, for context): Enter the requested credential",
          },
          userTurnTranscriptRecorder: recorder,
          ...(kind === "offloaded" ? { media } : {}),
        },
        sessionKey,
      );
      await expect(pendingSecret).resolves.toEqual(
        kind === "text"
          ? { status: "answered", answers: { answers: { credential: [secretValue] } } }
          : { status: "cancelled" },
      );
      expect(persistApproved).not.toHaveBeenCalled();
      expect(recorder.hasPersisted()).toBe(false);
      expect(steer).toHaveBeenCalledTimes(kind === "text" ? 0 : 1);
    },
  );

  it("rejects only the exact drained steer when its transcript append fails", async () => {
    const failed = message("same text", "failed");
    const surviving = message("same text", "surviving");
    const f = fixture();
    const controller = new AbortController();
    const failedWait = f.wait("same text", {
      queueIdentity: "failed",
      abortSignal: controller.signal,
    });
    const survivingWait = f.wait("same text", {
      queueIdentity: "surviving",
      abortSignal: controller.signal,
    });
    const rejection = expect(failedWait).rejects.toThrow("SQLite transcript append failed");
    try {
      expect(f.listeners).toHaveLength(2);
      reportSteeringMessagePersistenceFailure(failed, new Error("SQLite transcript append failed"));
      await rejection;
      expect(f.listeners).toHaveLength(1);
      f.emit({ type: "message_end", message: surviving });
      await expect(survivingWait).resolves.toBeUndefined();
      expect(f.listeners).toHaveLength(0);
    } finally {
      controller.abort();
      await Promise.allSettled([failedWait, survivingWait, rejection]);
    }
  });

  it("removes only the timed-out steer and preserves unrelated rich payloads", async () => {
    vi.useFakeTimers();
    const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
    const unrelated = { role: "user", content: [image], timestamp: 1 } satisfies Message;
    const target = message("timed-out completion announce");
    const trailing = {
      role: "custom",
      customType: "notice",
      content: "keep",
      display: false,
      timestamp: 3,
    } satisfies Message;
    const f = fixture([unrelated, target, trailing], target);
    const wait = f.wait("timed-out completion announce", { deliveryTimeoutMs: 1 });
    const rejection = expect(wait).rejects.toThrow(timeoutError);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(f.queue).toEqual([unrelated, trailing]);
    expect(f.queue[0]).toBe(unrelated);
    expect(unrelated.content[0]).toBe(image);
    expect(f.queue[1]).toBe(trailing);
    expect(f.retire).toHaveBeenCalledOnce();
  });

  it.each(["terminal", "abort"] as const)(
    "fences %s cancellation before delayed preparation can enqueue",
    async (cause) => {
      const preparation = deferred();
      const started = deferred();
      const returned = deferred();
      const f = fixture();
      let enqueued = false;
      f.session.steer = async (_text, _images, _recorder, _media, _order, _identity, canInject) => {
        started.resolve();
        await preparation.promise;
        try {
          if (canInject && !canInject()) {
            throw new Error("active session is finalizing");
          }
          enqueued = true;
        } finally {
          returned.resolve();
        }
      };
      const controller = new AbortController();
      const onQueueAccepted = vi.fn();
      const wait = f.wait("delayed steer", {
        abortSignal: controller.signal,
        onQueueAccepted,
      });
      const rejection = expect(wait).rejects.toThrow(
        cause === "terminal"
          ? terminalError
          : "queued steering message was cancelled before acceptance",
      );
      await started.promise;
      if (cause === "terminal") {
        f.emit({ type: "agent_settled" });
      } else {
        controller.abort();
      }
      preparation.resolve();
      await rejection;
      await returned.promise;
      expect(enqueued).toBe(false);
      expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("cancels an enqueued steer before its acceptance promise settles", async () => {
    const acceptance = deferred();
    const enqueued = deferred();
    const returned = deferred();
    const target = message("queued before settlement");
    const f = fixture([target]);
    f.session.steer = async (_text, _images, _recorder, _media, _order, identity) => {
      setSteeringMessageIdentity(target, identity);
      enqueued.resolve();
      await acceptance.promise;
      returned.resolve();
    };
    const onQueueAccepted = vi.fn();
    const wait = f.wait("queued before settlement", { onQueueAccepted });
    const rejection = expect(wait).rejects.toThrow(terminalError);
    await enqueued.promise;
    f.emit({ type: "agent_settled" });
    await rejection;
    expect(f.queue).toEqual([]);
    expect(f.retire).toHaveBeenCalledOnce();
    expect(f.listeners).toHaveLength(0);
    expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(false);
    acceptance.resolve();
    await returned.promise;
    await Promise.resolve();
    expect(f.queue).toEqual([]);
    expect(onQueueAccepted).toHaveBeenCalledOnce();
  });

  it("removes the runtime steer even when display retirement fails", async () => {
    const target = message("runtime ownership wins");
    const f = fixture([target]);
    registerQueuedUserMessageRetirement(target, () => {
      throw new Error("display cleanup failed");
    });
    const wait = f.wait("runtime ownership wins");
    await Promise.resolve();
    f.emit({ type: "agent_settled" });
    await expect(wait).rejects.toThrow(terminalError);
    expect(f.queue).toEqual([]);
  });

  it("commits identical steering text only at the matching identity's message_end", async () => {
    const first = message("same text", "steer-a");
    const second = message("same text", "steer-b");
    const f = fixture([first, second]);
    const wait = f.wait("same text", { queueIdentity: "steer-a" });
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    f.emit({ type: "message_start", message: first });
    f.emit({ type: "message_end", message: second });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.emit({ type: "message_end", message: first });
    await expect(wait).resolves.toBeUndefined();
    expect(f.listeners).toHaveLength(0);
  });

  it("cancels the exact expanded steer without leaving a duplicate UI entry", async () => {
    const first = message("expanded steering text", "keep-first");
    const second = message("expanded steering text", "cancel-second");
    const f = fixture([first, second], second);
    const controller = new AbortController();
    const wait = f.wait("/expand same text", {
      queueIdentity: "cancel-second",
      abortSignal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(wait).rejects.toThrow("queued steering message was cancelled before delivery");
    expect(f.queue).toEqual([first]);
    expect(f.retire).toHaveBeenCalledOnce();
  });

  it("marks a missing queued message as accepted without transcript confirmation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const wait = f.wait("possibly consumed", { deliveryTimeoutMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toEqual({
      transcriptCommit: "unconfirmed",
      errorMessage: timeoutError,
    });
  });

  it("keeps an image steer pending across nonterminal retry and compaction events", async () => {
    vi.useFakeTimers();
    const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
    const target = {
      role: "user",
      content: [{ type: "text", text: "" }, image],
      timestamp: 2,
    } satisfies Message;
    const f = fixture([target]);
    const wait = f.wait("", { images: [image] });
    f.emit({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(0);
    f.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_000 });
    f.emit({ type: "compaction_start", reason: "threshold" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.queue).toEqual([target]);
    f.emit({ type: "message_end", message: target });
    await expect(wait).resolves.toBeUndefined();
  });
});
