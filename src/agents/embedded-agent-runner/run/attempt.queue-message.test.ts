import { afterEach, expect, it, vi } from "vitest";
import {
  bindMessageInjectionAdmission,
  MessageInjectionAcceptedUnconfirmedError,
} from "../../../auto-reply/reply/message-injection-authority.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore as deferred } from "../../../shared/deferred.js";
import type { AgentHarnessQuestionGatewayCall } from "../../harness/gateway-question-dispatch.js";
import { runAgentHarnessGatewayQuestion } from "../../harness/gateway-question.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
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
const image = { type: "image" as const, data: "abc", mimeType: "image/png" };

afterEach(() => vi.useRealTimers());
registerAgentSessionLoopTestLifecycle();

function message(text: string, identity: string = text): Message {
  const entry = { role: "user", content: [{ type: "text", text }], timestamp: 1 } satisfies Message;
  setSteeringMessageIdentity(entry, identity);
  return entry;
}

function fixture(queue: Message[] = [], target = queue[0], prepare?: () => Promise<void>) {
  const listeners = new Set<(event: unknown) => void>();
  const retire = vi.fn(() => true);
  const accepted = vi.fn();
  const settled = vi.fn();
  const abort = new AbortController();
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
    accepted,
    settled,
    abort,
    emit(event: unknown) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    wait(text: string, options: Options = {}) {
      return steerActiveSessionWithOptionalDeliveryWait(
        session,
        text,
        {
          deliveryTimeoutMs: prepare ? undefined : 10_000,
          waitForTranscriptCommit: true,
          ...options,
        },
        undefined,
        undefined,
        undefined,
        prepare,
      );
    },
  };
}

function observe<T>(promise: Promise<T>) {
  const result: { value?: T; error?: unknown } = {};
  return {
    result,
    isSettled: () => Object.keys(result).length > 0,
    done: promise.then(
      (value) => Object.assign(result, { value }),
      (error: unknown) => Object.assign(result, { error }),
    ),
  };
}

async function admittedFixture(
  consume: Parameters<typeof bindMessageInjectionAdmission>[1],
  simulatedEvents = false,
) {
  const { session } = await createTestSession();
  vi.useFakeTimers();
  const prepare = async () => {};
  bindMessageInjectionAdmission(prepare, consume);
  const f = fixture([], undefined, prepare);
  f.session.agent = session.agent;
  f.session.steer = session.steer.bind(session);
  if (!simulatedEvents) {
    f.session.subscribe = session.subscribe.bind(session);
  }
  return { ...f, realSession: session };
}

it("retains real enqueued input when admission cleanup fails", async () => {
  const f = await admittedFixture(async (consume) => {
    consume();
    throw new Error("admission cleanup failed");
  });
  const waiting = observe(f.wait("already owned input"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.realSession.getSteeringMessages()).toEqual(["already owned input"]);
  expect(waiting.isSettled()).toBe(true);
  await waiting.done;
  expect(waiting.result.error).toBeInstanceOf(MessageInjectionAcceptedUnconfirmedError);
});

it.each([
  { cause: "abort", admission: "rejected" },
  { cause: "handoff", admission: "fulfilled" },
])("joins $admission cleanup after $cause loses queue custody", async ({ cause, admission }) => {
  const installed = deferred();
  const cleanup = deferred();
  const f = await admittedFixture(async (consume) => {
    const result = consume();
    installed.resolve();
    await cleanup.promise;
    if (admission === "rejected") {
      throw new Error("admission cleanup failed after installation");
    }
    return result;
  }, true);
  const waiting = observe(
    f.wait("input left the queue", {
      abortSignal: f.abort.signal,
      onQueueAccepted: f.accepted,
    }),
  );
  try {
    await installed.promise;
    expect(f.realSession.agent.cancelSteeringMessage(() => true)?.role).toBe("user");
    if (cause === "abort") {
      f.abort.abort();
    } else {
      f.emit({ type: "agent_handoff" });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting.isSettled()).toBe(false);
    expect(f.accepted).not.toHaveBeenCalled();
    cleanup.resolve();
    await waiting.done;
    expect(waiting.result.value).toMatchObject({ transcriptCommit: "unconfirmed" });
    expect(f.accepted).not.toHaveBeenCalledWith(false);
    expect(f.listeners).toHaveLength(0);
  } finally {
    cleanup.resolve();
    await waiting.done;
  }
});

it("closes admission on pre-enqueue persistence failure when the observer throws", async () => {
  const entered = deferred();
  const release = deferred();
  const f = await admittedFixture(async (consume) => {
    entered.resolve();
    await release.promise;
    return consume();
  });
  const steering = vi.spyOn(f.session, "steer");
  const queueIdentity = "pre-enqueue-persistence-failure";
  const persistenceError = new Error("input persistence failed before enqueue");
  f.settled.mockImplementation(() => {
    throw new Error("settlement observer failed");
  });
  const waiting = observe(
    f.wait("must not enqueue", {
      queueIdentity,
      onQueueAccepted: f.accepted,
      onQueueSettled: f.settled,
    }),
  );
  try {
    await entered.promise;
    reportSteeringMessagePersistenceFailure(
      message("must not enqueue", queueIdentity),
      persistenceError,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting.isSettled()).toBe(false);
    expect(f.accepted).not.toHaveBeenCalled();
    release.resolve();
    await waiting.done;
    expect(waiting.result.error).toMatchObject({
      cause: expect.objectContaining({ message: persistenceError.message }),
    });
    expect(f.realSession.agent.hasQueuedMessages()).toBe(false);
    expect(f.realSession.getSteeringMessages()).toEqual([]);
    expect(f.accepted).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.settled).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await Promise.allSettled([
      waiting.done,
      ...steering.mock.results.map((result) => result.value),
    ]);
  }
});

it.each(["message_end", "agent_handoff"])(
  "keeps admission-only steering owned until %s",
  async (terminal) => {
    vi.useFakeTimers();
    const target = message("admitted guidance");
    const unrelated = message("unrelated guidance");
    const f = fixture([target, unrelated], target);
    await f.wait("admitted guidance", {
      waitForTranscriptCommit: false,
      deliveryTimeoutMs: 1,
      abortSignal: f.abort.signal,
      onQueueAccepted: f.accepted,
      onQueueSettled: f.settled,
    });
    expect(f.accepted).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.settled).not.toHaveBeenCalled();
    expect(f.listeners).toHaveLength(1);
    f.abort.abort();
    await vi.advanceTimersByTimeAsync(2);
    expect(f.queue).toEqual([target, unrelated]);
    if (terminal === "message_end") {
      f.queue.shift();
      f.emit({ type: terminal, message: target });
    } else {
      f.emit({ type: terminal });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(f.queue).toEqual([unrelated]);
    expect(f.listeners).toHaveLength(0);
    expect(f.settled).toHaveBeenCalledOnce();
    expect(f.retire).toHaveBeenCalledTimes(terminal === "message_end" ? 0 : 1);
    expect(f.accepted).toHaveBeenCalledExactlyOnceWith(true);
  },
);
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
  const failedWait = f.wait("same text", {
    queueIdentity: "failed",
    abortSignal: f.abort.signal,
  });
  const survivingWait = f.wait("same text", {
    queueIdentity: "surviving",
    abortSignal: f.abort.signal,
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
    f.abort.abort();
    await Promise.allSettled([failedWait, survivingWait, rejection]);
  }
});

it("removes only the timed-out steer and preserves unrelated rich payloads", async () => {
  vi.useFakeTimers();
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
    const wait = f.wait("delayed steer", {
      abortSignal: f.abort.signal,
      onQueueAccepted: f.accepted,
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
      f.abort.abort();
    }
    preparation.resolve();
    await rejection;
    await returned.promise;
    expect(enqueued).toBe(false);
    expect(f.accepted).toHaveBeenCalledExactlyOnceWith(false);
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
  const wait = f.wait("queued before settlement", { onQueueAccepted: f.accepted });
  const rejection = expect(wait).rejects.toThrow(terminalError);
  await enqueued.promise;
  f.emit({ type: "agent_settled" });
  await rejection;
  expect(f.queue).toEqual([]);
  expect(f.retire).toHaveBeenCalledOnce();
  expect(f.listeners).toHaveLength(0);
  expect(f.accepted).toHaveBeenCalledExactlyOnceWith(false);
  acceptance.resolve();
  await returned.promise;
  await Promise.resolve();
  expect(f.queue).toEqual([]);
  expect(f.accepted).toHaveBeenCalledOnce();
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
  const wait = f.wait("/expand same text", {
    queueIdentity: "cancel-second",
    abortSignal: f.abort.signal,
  });
  await Promise.resolve();
  f.abort.abort();
  await expect(wait).rejects.toThrow("queued steering message was cancelled before delivery");
  expect(f.queue).toEqual([first]);
  expect(f.retire).toHaveBeenCalledOnce();
});

it("keeps an image steer pending across nonterminal retry and compaction events", async () => {
  vi.useFakeTimers();
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
