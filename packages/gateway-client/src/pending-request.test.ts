import assert from "node:assert/strict";
import type { RequestFrame } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "./pending-request.js";

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

describe("GatewayPendingRequests", () => {
  it.each([false, true])(
    "releases a ready agent after a recovery probe reaches startup refusal, newer pause=%s",
    async (newerPause) => {
      let sequence = 0;
      const requests = new GatewayPendingRequests({
        createRequestId: () => `${sequence++}`,
        nowMs: () => Date.now(),
      });
      const frames: string[] = [];
      const sender = { send: (raw: string) => frames.push(raw) };
      const controller = new AbortController();
      const slow = requests
        .request(
          sender,
          "chat.send",
          { agentId: "slow" },
          {
            timeoutMs: 10_000,
            signal: controller.signal,
          },
        )
        .catch((error: unknown) => error);
      const ready = requests.request(
        sender,
        "chat.send",
        { agentId: "ready" },
        {
          timeoutMs: 10_000,
        },
      );
      const slowRaw = frames[0];
      const readyRaw = frames[1];
      assert(slowRaw && readyRaw);
      const slowFrame = JSON.parse(slowRaw) as RequestFrame;
      const readyFrame = JSON.parse(readyRaw) as RequestFrame;
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
      requests.handleResponse({
        type: "res",
        id: readyFrame.id,
        ok: true,
        payload: { runId: "ready" },
      });
      await expect(ready).resolves.toEqual({ runId: "ready" });
      controller.abort();
      await expect(slow).resolves.toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(frames).toHaveLength(5);
      expect(requests.hasPending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["announced", "gateway-suspending", "gateway-restarting"])(
    "resumes a startup-refused write after %s without changing its frame",
    async (pause) => {
      const requests = new GatewayPendingRequests({
        createRequestId: () => "write",
        nowMs: () => Date.now(),
      });
      const frames: string[] = [];
      const result = requests
        .request(
          { send: (raw) => frames.push(raw) },
          "chat.send",
          { idempotencyKey: "original", message: "synthetic" },
          { timeoutMs: 1_000, retainSentResultOnAbort: true },
        )
        .catch((error: unknown) => error);
      const raw = frames[0];
      assert(raw);
      const frame = JSON.parse(raw) as RequestFrame;
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
      requests.handleResponse({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { runId: "original" },
      });
      await expect(result).resolves.toEqual({ runId: "original" });
      expect(requests.hasPending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["waiting", "synchronous refusal", "redispatched", "overdue retry"])(
    "reports delivery uncertainty at the original deadline: %s",
    async (phase) => {
      let clockOffset = 0;
      const requests = new GatewayPendingRequests({
        createRequestId: () => "write",
        nowMs: () => Date.now() + clockOffset,
      });
      const frames: RequestFrame[] = [];
      const result = requests
        .request(
          {
            send: (raw) => {
              const frame = JSON.parse(raw) as RequestFrame;
              frames.push(frame);
              if (phase === "synchronous refusal") {
                refuse(requests, frame, "startup-sidecars", 2_000);
              }
            },
          },
          "chat.send",
          { idempotencyKey: "original" },
          { timeoutMs: 1_000, retainSentResultOnAbort: true },
        )
        .catch((error: unknown) => error);
      const frame = frames[0];
      assert(frame);
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
      expect(requests.hasPending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not retain settled IDs for the socket generation", async () => {
    let requestId = 0;
    const requests = new GatewayPendingRequests({
      createRequestId: () => `request-${requestId++}`,
      nowMs: () => 0,
    });
    const sender = {
      send: () => {
        throw new Error("synthetic send failure");
      },
    };

    for (let index = 0; index < 100; index += 1) {
      await requests.request(sender, "bounded", {}, { timeoutMs: null }).catch(() => undefined);
    }

    const retained = (requests as unknown as { retiredIds?: ReadonlySet<string> }).retiredIds;
    expect(retained?.size ?? 0).toBe(0);
  });

  it("settles each retired request once when its timing observer shuts down again", async () => {
    const timings: string[] = [];
    const requests = new GatewayPendingRequests({
      createRequestId: () => "stable",
      nowMs: () => 0,
      onTiming: ({ method }) => {
        timings.push(method);
        if (timings.length === 1) {
          requests.flush(new Error("nested shutdown"));
        }
      },
    });
    const retired = requests.request(
      { send: () => {} },
      "session.observe",
      {},
      {
        timeoutMs: null,
      },
    );
    void retired.catch(() => undefined);

    requests.flush(new Error("transport closed"));

    expect(timings).toEqual(["session.observe"]);
    await expect(retired).rejects.toThrow("transport closed");
    expect(requests.hasPending).toBe(false);
  });
});
