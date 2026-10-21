import assert from "node:assert/strict";
import type { RequestFrame } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "./pending-request.js";
import type { GatewayProtocolRequestOptions } from "./protocol-request.js";

function fixture(
  dependencies: Partial<ConstructorParameters<typeof GatewayPendingRequests>[0]> = {},
  onSend?: (frame: RequestFrame) => void,
) {
  let sequence = 0;
  const requests = new GatewayPendingRequests({
    createRequestId: () => `${sequence++}`,
    nowMs: () => Date.now(),
    ...dependencies,
  });
  const frames: string[] = [];
  const sender = {
    send: (raw: string) => {
      frames.push(raw);
      onSend?.(JSON.parse(raw) as RequestFrame);
    },
  };
  const frame = (index = 0) => {
    const raw = frames[index];
    assert(raw);
    return JSON.parse(raw) as RequestFrame;
  };
  const write = (
    params: unknown,
    options: GatewayProtocolRequestOptions = { timeoutMs: 1_000, retainSentResultOnAbort: true },
  ) => requests.request(sender, "chat.send", params, options).catch((error: unknown) => error);
  const accept = (responseTo: RequestFrame, runId: string) =>
    requests.handleResponse({ type: "res", id: responseTo.id, ok: true, payload: { runId } });
  return { requests, sender, frames, frame, write, accept };
}

function expectSettled(requests: GatewayPendingRequests) {
  expect(requests.hasPending).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
}

function refuse(
  requests: GatewayPendingRequests,
  frame: RequestFrame,
  reason: string,
  delay = 250,
) {
  requests.handleResponse({
    type: "res",
    id: frame.id,
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: "not admitted",
      retryable: true,
      retryAfterMs: delay,
      details: { reason, method: frame.method },
    },
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "unblocks a ready agent after probing startup, newer pause=%s",
  async (newerPause) => {
    const { requests, frames, frame, write, accept } = fixture();
    const controller = new AbortController();
    const slow = write({ agentId: "slow" }, { timeoutMs: 10_000, signal: controller.signal });
    const ready = write({ agentId: "ready" }, { timeoutMs: 10_000 });
    const slowRaw = frames[0];
    const readyRaw = frames[1];
    const slowFrame = frame();
    const readyFrame = frame(1);
    refuse(requests, slowFrame, "startup-sidecars", 100);
    refuse(requests, readyFrame, "startup-sidecars", 200);
    await vi.advanceTimersByTimeAsync(100);
    refuse(requests, slowFrame, "gateway-suspending", 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(frames).toEqual([slowRaw, readyRaw, slowRaw, slowRaw]);
    if (newerPause) {
      requests.setSuspensionPhase("draining");
    }
    refuse(requests, slowFrame, "startup-sidecars");
    if (newerPause) {
      expect(frames).toEqual([slowRaw, readyRaw, slowRaw, slowRaw]);
      requests.setSuspensionPhase("accepting");
    }
    expect(frames).toEqual([slowRaw, readyRaw, slowRaw, slowRaw, readyRaw]);
    accept(readyFrame, "ready");
    await expect(ready).resolves.toEqual({ runId: "ready" });
    controller.abort();
    await expect(slow).resolves.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frames).toHaveLength(5);
    expectSettled(requests);
  },
);

it.each(["announced", "gateway-suspending", "gateway-restarting"])(
  "replays the original write after %s",
  async (pause) => {
    const { requests, frames, frame: readFrame, write, accept } = fixture();
    const result = write({ idempotencyKey: "original", message: "synthetic" });
    const raw = frames[0];
    const frame = readFrame();
    refuse(requests, frame, "startup-sidecars");
    if (pause === "announced") {
      requests.setSuspensionPhase("draining");
    }
    await vi.advanceTimersByTimeAsync(250);
    if (pause !== "announced") {
      expect(frames).toEqual([raw, raw]);
      refuse(requests, frame, pause);
    } else {
      expect(frames).toEqual([raw]);
    }
    expect(requests.hasPending).toBe(true);
    requests.setSuspensionPhase("accepting");
    expect(frames).toEqual(pause === "announced" ? [raw, raw] : [raw, raw, raw]);
    accept(frame, "original");
    await expect(result).resolves.toEqual({ runId: "original" });
    expectSettled(requests);
  },
);

it.each(["waiting", "synchronous refusal", "redispatched", "overdue retry"])(
  "preserves the original deadline through %s",
  async (phase) => {
    let clockOffset = 0;
    const {
      requests,
      frames,
      frame: readFrame,
      write,
    } = fixture({ nowMs: () => Date.now() + clockOffset }, (frame) => {
      if (phase === "synchronous refusal") {
        refuse(requests, frame, "startup-sidecars", 2_000);
      }
    });
    const result = write({ idempotencyKey: "original" });
    const frame = readFrame();
    if (phase !== "synchronous refusal") {
      refuse(requests, frame, "startup-sidecars", phase === "waiting" ? 2_000 : 250);
    }
    if (phase === "overdue retry") {
      clockOffset = 1_000;
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({
      code: "CLIENT_TIMEOUT",
      timeoutMs: 1_000,
      requestSent: phase === "redispatched",
    });
    expect(frames).toHaveLength(phase === "redispatched" ? 2 : 1);
    expectSettled(requests);
  },
);

it("does not retain settled IDs for the socket generation", async () => {
  const { requests, sender } = fixture({ nowMs: () => 0 }, () => {
    throw new Error("synthetic send failure");
  });

  for (let index = 0; index < 100; index += 1) {
    await requests.request(sender, "bounded", {}, { timeoutMs: null }).catch(() => undefined);
  }

  const retained = (requests as unknown as { retiredIds?: ReadonlySet<string> }).retiredIds;
  expect(retained?.size ?? 0).toBe(0);
});

it("settles each retired request once when its timing observer shuts down again", async () => {
  const timings: string[] = [];
  const { requests } = fixture({
    nowMs: () => 0,
    onTiming: ({ method }) => {
      timings.push(method);
      if (timings.length === 1) {
        requests.flush(new Error("nested shutdown"));
      }
    },
  });
  const retired = requests.request({ send: () => {} }, "session.observe", {}, { timeoutMs: null });
  void retired.catch(() => undefined);

  requests.flush(new Error("transport closed"));

  expect(timings).toEqual(["session.observe"]);
  await expect(retired).rejects.toThrow("transport closed");
  expect(requests.hasPending).toBe(false);
});
