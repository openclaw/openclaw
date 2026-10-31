import { runAgentHarnessGatewayQuestion } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createNativeSessionBindingAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsyncGate as pause } from "../../../test-support/async-gate.test-support.js";
import { registerCodexSteeringConfirmationCases } from "./attempt-steering.confirmation.test-support.js";
import {
  CodexSteeringAcceptedUnconfirmedError,
  createCodexSteeringQueue,
  createCodexQuestionInputHandlers,
} from "./attempt-steering.js";
import { createClientHarness } from "./test-support.js";
import { buildCodexUserInput } from "./user-input.js";

type QueueParams = Parameters<typeof createCodexSteeringQueue>[0];
type Queue = ReturnType<typeof createCodexSteeringQueue>;
const turn = { turnId: "turn-1" };
const image = {
  type: "image" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0V8AAAAASUVORK5CYII=",
  mimeType: "image/png",
};
const noop = () => {};
const captureError = (error: unknown) => error;
const resolved = async () => {};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const unconfirmed = (pending: Promise<void>) =>
  expect(pending).rejects.toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
const settlement = (pending: Promise<void>) =>
  pending.then(
    () => "accepted",
    () => "rejected",
  );
function confirm(queue: Queue, line: string, text?: string) {
  const { params } = JSON.parse(line);
  if (text !== undefined) {
    expect(params.input).toEqual(textInput(text));
  }
  expect(queue.confirmConsumed(params.clientUserMessageId)).toBe(true);
}
function pendingRequest() {
  const accepted = createDeferred<void>();
  const request = vi.fn(async () => {
    await accepted.promise;
    return turn;
  });
  return { accepted, request, queue: createQueue({ request }) };
}
function tracked(queue: Queue, text: string, debounceMs = 0) {
  const accepted = vi.fn();
  return { accepted, pending: queue.queue(text, { debounceMs, onQueueAccepted: accepted }) };
}
const prepareMessage: QueueParams["prepareMessage"] = async (text, options) => ({
  input: buildCodexUserInput(text, options.images),
  message: {
    role: "user",
    content: [{ type: "text", text }, ...(options.images ?? [])],
    timestamp: 1,
  },
});

function createReplyHarness() {
  return createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line);
      send({ id: request.id, result: turn });
    },
  });
}
const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];

function createQueue(
  client: QueueParams["client"] | { request: ReturnType<typeof vi.fn> },
  options: Partial<Omit<QueueParams, "client" | "threadId" | "turnId" | "assertActive">> = {},
) {
  return createCodexSteeringQueue({
    client: client as QueueParams["client"],
    threadId: "thread-1",
    turnId: "turn-1",
    requestTimeoutMs: 60_000,
    signal: new AbortController().signal,
    assertActive: noop,
    prepareMessage,
    ...options,
  });
}

describe("Codex app-server steering queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const steerRequestOptions = {
    timeoutMs: 60_000,
    signal: expect.any(AbortSignal),
    assertCurrent: expect.any(Function),
    onIngressRejected: expect.any(Function),
  };

  it.each(["owner", "compat"] as const)(
    "handles %s refusal at the native wire boundary",
    async (kind) => {
      const harness = createReplyHarness();
      const authority = createNativeSessionBindingAuthority([], noop);
      const queue = createQueue(harness.client, {
        withCurrent: authority.withCurrent,
        withPreparedCurrent: authority.withPreparedCurrent,
      });
      const gate = pause();
      let callerCurrent = true;
      const assertCurrent = () => {
        if (!callerCurrent) {
          throw new Error("caller policy changed");
        }
      };
      const rejectedAcceptance = vi.fn();
      const survivorAcceptance = vi.fn();
      const revoked = queue
        .queue("revoked", { debounceMs: 5, onQueueAccepted: rejectedAcceptance }, noop, {
          assertCurrent: kind === "owner" ? assertCurrent : noop,
          prepareCurrent: gate.wait,
          compatAssertCurrent: kind === "compat" ? assertCurrent : noop,
        })
        .catch(captureError);
      const survivor = queue
        .queue("survivor", { debounceMs: 5, onQueueAccepted: survivorAcceptance }, noop, {
          assertCurrent: noop,
          prepareCurrent: resolved,
          compatAssertCurrent: noop,
        })
        .catch(captureError);
      try {
        await vi.advanceTimersByTimeAsync(5);
        await gate.entered;
        callerCurrent = false;
        expect(harness.writes).toEqual([]);
        gate.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(await revoked).toMatchObject({ message: "caller policy changed" });
        expect(rejectedAcceptance).toHaveBeenCalledExactlyOnceWith(false);
        if (kind === "compat") {
          expect(await survivor).toMatchObject({ message: "caller policy changed" });
          expect(survivorAcceptance).toHaveBeenCalledExactlyOnceWith(false);
          expect(harness.writes).toEqual([]);
          expect(queue.getAcceptedMessages()).toEqual([]);
          return;
        }
        expect(harness.writes).toHaveLength(1);
        const request = JSON.parse(harness.writes[0]!);
        expect(request.params).toMatchObject({ expectedTurnId: "turn-1" });
        confirm(queue, harness.writes[0]!, "survivor");
        await survivor;
        expect(survivorAcceptance).toHaveBeenCalledExactlyOnceWith(true);
        expect(queue.getAcceptedMessages()).toHaveLength(1);
      } finally {
        gate.release();
        queue.cancel();
        await Promise.allSettled([revoked, survivor]);
        harness.client.close();
      }
    },
  );

  it("does not accept a steering batch aborted while fresh authority is pending", async () => {
    const harness = createClientHarness();
    const gate = pause();
    const released = createDeferred<void>();
    const controller = new AbortController();
    const onQueueAccepted = vi.fn();
    const queue = createQueue(harness.client, {
      signal: controller.signal,
      withCurrent: async (write) => {
        try {
          await gate.wait();
          write();
        } finally {
          released.resolve();
        }
      },
    });
    const delivery = queue.queue("steer", { debounceMs: 0, onQueueAccepted });
    const rejected = expect(delivery).rejects.toThrow("aborted");
    try {
      await gate.entered;
      controller.abort();
      await rejected;
      expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(false);
      expect(queue.getAcceptedMessages()).toEqual([]);
      gate.release();
      await released.promise;
      expect(harness.writes).toEqual([]);
    } finally {
      gate.release();
      queue.cancel();
      harness.client.close();
    }
  });

  it.each(["committed", "failed", "revoked", "aborted", "sealed"] as const)(
    "guards physical steering submission after the source commit is %s",
    async (outcome) => {
      const harness = createReplyHarness();
      const gate = pause();
      const controller = new AbortController();
      let sourceCurrent = true;
      const beforeSubmit = vi.fn(async () => {
        await gate.wait();
        if (outcome === "failed") {
          throw new Error("source persistence unavailable");
        }
      });
      const queue = createQueue(harness.client, { signal: controller.signal, beforeSubmit });
      const onQueueAccepted = vi.fn();
      const onQueueSettled = vi.fn();
      const delivery = queue.queue(
        "durable steer",
        { debounceMs: 0, onQueueAccepted, onQueueSettled },
        () => {
          if (!sourceCurrent) {
            throw new Error("source claim replaced");
          }
        },
      );
      const settled = delivery.catch(captureError);
      try {
        await gate.entered;
        expect(harness.writes).toEqual([]);
        expect(onQueueAccepted).not.toHaveBeenCalled();
        expect(onQueueSettled).not.toHaveBeenCalled();
        if (outcome === "revoked") {
          sourceCurrent = false;
        } else if (outcome === "aborted") {
          controller.abort();
        } else if (outcome === "sealed") {
          queue.sealAdmission();
        }
        gate.release();
        await vi.advanceTimersByTimeAsync(0);
        if (outcome === "committed") {
          expect(harness.writes).toHaveLength(1);
          confirm(queue, harness.writes[0]!);
          expect(await settled).toBeUndefined();
          expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
        } else {
          expect(harness.writes).toEqual([]);
          expect(await settled).toBeInstanceOf(Error);
          expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(false);
        }
        expect(beforeSubmit).toHaveBeenCalledOnce();
        expect(onQueueSettled).toHaveBeenCalledOnce();
      } finally {
        gate.release();
        queue.cancel();
        harness.client.close();
        await settled;
      }
    },
  );

  it("rechecks each source after later batch preparation at actual I/O: revoked", async () => {
    const harness = createReplyHarness();
    const gate = pause();
    let sourceCurrent = true;
    const controller = new AbortController();
    const queue = createQueue(harness.client, {
      signal: controller.signal,
      prepareMessage: async (text, options, assertCurrent) => {
        if (text === "independent") {
          await gate.wait();
        }
        return prepareMessage(text, options, assertCurrent);
      },
    });
    const acceptance = vi.fn();
    const first = settlement(
      queue.queue("controlled", { debounceMs: 5, onQueueAccepted: acceptance }, () => {
        if (!sourceCurrent) {
          throw new Error("source claim replaced");
        }
      }),
    );
    const second = queue.queue("independent", { debounceMs: 5 }, () => {});
    try {
      await vi.advanceTimersByTimeAsync(5);
      await gate.entered;
      expect(harness.writes).toEqual([]);
      sourceCurrent = false;
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
      confirm(queue, harness.writes[0]!, "independent");
      await second;
      expect(await first).toBe("rejected");
      expect(acceptance).toHaveBeenCalledExactlyOnceWith(sourceCurrent);
      const later = queue.queue("later authorized", { debounceMs: 0 }, () => {});
      await vi.advanceTimersByTimeAsync(0);
      confirm(queue, harness.writes[1]!, "later authorized");
      await later;
      expect(controller.signal.aborted).toBe(false);
    } finally {
      gate.release();
      queue.cancel();
      harness.client.close();
    }
  });

  it.each([false, true])(
    "rechecks authority before physical overload retry: mixed=%s",
    async (mixed) => {
      let sourceCurrent = true;
      let count = 0;
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line);
          if (++count === 1) {
            sourceCurrent = false;
            send({ id: request.id, error: { code: -32001, message: "overloaded" } });
          } else {
            send({ id: request.id, result: { turnId: "turn-1" } });
          }
        },
      });
      const queue = createQueue(harness.client);
      const first = settlement(
        queue.queue("revoked before retry", { debounceMs: 5 }, () => {
          if (!sourceCurrent) {
            throw new Error("source closed");
          }
        }),
      );
      const sibling = mixed ? queue.queue("independent", { debounceMs: 5 }, () => {}) : undefined;
      let later: ReturnType<typeof queue.queue> | undefined;
      try {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await first).toBe("rejected");
        expect(harness.writes).toHaveLength(mixed ? 2 : 1);
        if (mixed) {
          confirm(queue, harness.writes[1]!, "independent");
          await sibling;
        }
        later = queue.queue("later authorized", { debounceMs: 0 }, () => {});
        await vi.advanceTimersByTimeAsync(0);
        confirm(queue, harness.writes.at(-1)!, "later authorized");
        await later;
      } finally {
        queue.cancel();
        harness.client.close();
        await Promise.allSettled([first, sibling, later]);
      }
    },
  );

  it("does not accept a rejected steering batch when cancelled before overload retry", async () => {
    const rejected = createDeferred<void>();
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line);
        send({ id: request.id, error: { code: -32001, message: "overloaded" } });
        rejected.resolve();
      },
    });
    const controller = new AbortController();
    const queue = createQueue(harness.client, {
      signal: controller.signal,
      withCurrent: async (write) => write(),
    });
    const result = queue
      .queue("not enqueued", { debounceMs: 0 })
      .then(() => "accepted", captureError);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await rejected.promise;
      queue.cancel();
      controller.abort(new Error("fixture cancelled during backoff"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toBeInstanceOf(Error);
      expect(await result).not.toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
      expect(queue.getAcceptedMessages()).toEqual([]);
      expect(harness.writes).toHaveLength(1);
    } finally {
      queue.cancel();
      harness.client.close();
      await result;
    }
  });

  it("fails the steer when the app-server never answers turn/steer", async () => {
    const harness = createClientHarness();
    const beforeSubmit = vi.fn(async () => {});
    const queue = createQueue(harness.client, { requestTimeoutMs: 1_000, beforeSubmit });

    const result = queue.queue("steer me", { debounceMs: 0 }).catch(captureError);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(harness.writes[0] ?? "{}").method).toBe("turn/steer");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await result).toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(await result).toMatchObject({ cause: { message: "turn/steer timed out" } });
    harness.client.close();
  });

  it("aborts the in-flight steer request and removes its client pending entry", async () => {
    const harness = createClientHarness();
    const controller = new AbortController();
    const queue = createQueue(harness.client, { signal: controller.signal });
    const pendingRequests = (
      harness.client as unknown as { pending: Map<number | string, unknown> }
    ).pending;

    const queued = queue.queue("steer me", { debounceMs: 0 });
    const rejected = unconfirmed(queued);
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingRequests.size).toBe(1);

    controller.abort();

    await rejected;
    expect(pendingRequests.size).toBe(0);
    harness.client.close();
  });

  registerCodexSteeringConfirmationCases({ createQueue, createReplyHarness });

  it("batches ordered text and images under one correlated user-message id", async () => {
    const request = vi.fn(async () => turn);
    const queue = createQueue({ request });

    const options = { debounceMs: 5, images: [image] };
    const first = queue.queue("first", options);
    const second = queue.queue("second", options);
    const settled = vi.fn();
    const delivery = Promise.all([first, second]).then(settled);
    await vi.advanceTimersByTimeAsync(5);

    expect(settled).not.toHaveBeenCalled();
    expect(queue.confirmConsumed("unrelated-user-message")).toBe(false);
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    await delivery;
    expect(request).toHaveBeenCalledWith(
      "turn/steer",
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [
          { type: "text", text: "first", text_elements: [] },
          { type: "image", url: `data:image/png;base64,${image.data}` },
          { type: "text", text: "second", text_elements: [] },
          { type: "image", url: `data:image/png;base64,${image.data}` },
        ],
        clientUserMessageId: "openclaw:turn-1:steer:1",
      },
      steerRequestOptions,
    );
  });

  it("rejects later steering behind a failed batch", async () => {
    const firstSteer = createDeferred<{ turnId: string }>();
    const request = vi.fn(() => firstSteer.promise);
    const queue = createQueue({ request });

    const settled: string[] = [];
    const first = queue.queue("first", { debounceMs: 0 }).catch(() => {
      settled.push("first");
    });
    await vi.advanceTimersByTimeAsync(0);
    const second = queue.queue("second", { debounceMs: 0 }).catch(() => {
      settled.push("second");
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledOnce();
    firstSteer.reject(new Error("cannot steer this turn"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, second]);

    expect(request).toHaveBeenCalledOnce();
    expect(settled).toEqual(["first", "second"]);
  });

  it.each([
    { closure: "terminal", reason: "steering queue admission sealed" },
    { closure: "abort", reason: "steering queue aborted" },
  ] as const)("fences preparation that finishes after $closure", async ({ closure, reason }) => {
    const started = createDeferred<void>();
    const finished = createDeferred<Awaited<ReturnType<QueueParams["prepareMessage"]>>>();
    const request = vi.fn(async () => turn);
    const controller = new AbortController();
    const queue = createQueue(
      { request },
      {
        signal: controller.signal,
        prepareMessage: () => {
          started.resolve();
          return finished.promise;
        },
      },
    );
    const images = [image];
    const prepared = await prepareMessage("delayed image", { images }, () => {});
    const onQueueAccepted = vi.fn();
    const queued = queue.queue("delayed image", { images, debounceMs: 0, onQueueAccepted });
    const rejected = expect(queued).rejects.toThrow(reason);

    try {
      await started.promise;
      expect(onQueueAccepted).not.toHaveBeenCalled();
      if (closure === "terminal") {
        queue.sealAdmission();
      } else {
        controller.abort();
      }
      await rejected;
      expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(false);

      finished.resolve(prepared);
      // The queue subscribed before this await, so its resumed dispatch path
      // runs before the assertion. Early cancellation alone is not this proof.
      await finished.promise;
      expect(request).not.toHaveBeenCalled();
      expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(false);
      expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(false);
    } finally {
      queue.cancel();
      finished.resolve(prepared);
      await Promise.allSettled([queued, rejected, finished.promise]);
    }
  });

  it("does not dispatch a chained batch after cancellation", async () => {
    const { accepted, request, queue } = pendingRequest();
    request
      .mockImplementationOnce(async () => {
        await accepted.promise;
        return turn;
      })
      .mockResolvedValue(turn);
    const first = tracked(queue, "on the wire");
    const firstRejected = unconfirmed(first.pending);
    await tick();
    const second = tracked(queue, "waiting");
    const secondRejected = expect(second.pending).rejects.toThrow("steering queue cancelled");
    await tick();

    queue.cancel();
    accepted.resolve();
    await tick();
    await Promise.all([firstRejected, secondRejected]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(first.accepted).toHaveBeenCalledWith(true);
    expect(second.accepted).toHaveBeenCalledWith(false);
  });

  it("seals unsent admission while preserving a dispatched consumption confirmation", async () => {
    const { accepted, request, queue } = pendingRequest();
    const dispatched = tracked(queue, "on the wire");
    await tick();
    const chained = tracked(queue, "waiting on send chain");
    const chainedRejected = expect(chained.pending).rejects.toThrow("queue admission sealed");
    const debounced = tracked(queue, "still debounced", 30_000);
    const debouncedRejected = expect(debounced.pending).rejects.toThrow("queue admission sealed");
    await tick();

    queue.sealAdmission();

    await Promise.all([chainedRejected, debouncedRejected]);
    const late = tracked(queue, "too late");
    await expect(late.pending).rejects.toThrow("queue admission sealed");
    expect(request).toHaveBeenCalledOnce();
    for (const delivery of [chained, debounced, late]) {
      expect(delivery.accepted).toHaveBeenCalledWith(false);
    }
    expect(dispatched.accepted).not.toHaveBeenCalled();

    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    await dispatched.pending;
    expect(dispatched.accepted).toHaveBeenCalledWith(true);

    queue.cancel();
    accepted.resolve();
    await tick();
    expect(request).toHaveBeenCalledOnce();
  });

  it("fully cancels a dispatched batch after admission was sealed", async () => {
    const { accepted, queue } = pendingRequest();
    const dispatched = tracked(queue, "on the wire");
    const rejected = unconfirmed(dispatched.pending);
    await tick();

    queue.sealAdmission();
    expect(dispatched.accepted).not.toHaveBeenCalled();
    queue.cancel();
    queue.cancel();

    await rejected;
    expect(dispatched.accepted).toHaveBeenCalledWith(true);
    expect(queue.getAcceptedMessages()).toEqual([
      { role: "user", content: [{ type: "text", text: "on the wire" }], timestamp: 1 },
    ]);
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(false);
    expect(queue.getAcceptedMessages()).toHaveLength(1);
    accepted.resolve();
    await tick();
  });

  it("rejects before dispatch when the run is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue({ request }, { signal: controller.signal });
    const onQueueAccepted = vi.fn();

    await expect(queue.queue("aborted", { debounceMs: 0, onQueueAccepted })).rejects.toThrow(
      "steering queue aborted",
    );
    expect(onQueueAccepted).toHaveBeenCalledWith(false);
    expect(request).not.toHaveBeenCalled();
  });
});

it("keeps a Codex question pending for a human who cannot answer that question", async () => {
  const sessionKey = "agent:main:codex-question-permission";
  const abort = new AbortController();
  const pending = runAgentHarnessGatewayQuestion({
    questions: [
      { id: "answer", header: "Answer", question: "Continue?", isSecret: true, options: [] },
    ],
    sessionKey,
    timeoutMs: 60_000,
    signal: abort.signal,
    delivery: { onBlockReply: vi.fn(async () => undefined) },
  });
  const input = createCodexQuestionInputHandlers(sessionKey, () => {});
  try {
    await expect(
      input.claimPendingUserInputAnswer("status control", {
        isInboundUserMessage: true,
        allowPendingUserInputAnswer: false,
      }),
    ).resolves.toBe(false);
    await expect(
      input.claimPendingUserInputAnswer("Continue", { isInboundUserMessage: true }),
    ).resolves.toBe(true);
    await expect(pending).resolves.toMatchObject({
      status: "answered",
      answers: { answers: { answer: ["Continue"] } },
    });
  } finally {
    abort.abort();
    await pending;
  }
});
