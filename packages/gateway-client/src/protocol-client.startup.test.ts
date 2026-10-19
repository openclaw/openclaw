import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRequestHarness,
  latestFrame,
  respond,
} from "./protocol-client.request.test-support.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("GatewayProtocolClient startup requests", () => {
  it.each([false, true])(
    "retains a sent write result after owner abort, retry=%s",
    async (retry) => {
      vi.useFakeTimers();
      const { client, connection } = createRequestHarness();
      const controller = new AbortController();
      const onAccepted = vi.fn();
      const request = client
        .request(
          "sessions.create",
          {},
          {
            timeoutMs: 1_000,
            signal: controller.signal,
            retainSentResultOnAbort: true,
            expectFinal: retry,
            onAccepted,
          },
        )
        .catch((error: unknown) => error);
      const frame = latestFrame(connection);
      if (retry) {
        respond(
          connection,
          frame.id,
          {
            code: "UNAVAILABLE",
            message: "agent is preparing",
            retryable: true,
            retryAfterMs: 250,
            details: { reason: "startup-sidecars", method: "sessions.create" },
          },
          false,
        );
        await vi.advanceTimersByTimeAsync(250);
        expect(connection.frames).toHaveLength(2);
      }
      controller.abort();
      if (retry) {
        respond(connection, frame.id, { status: "accepted" });
        expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ status: "accepted" });
      }
      respond(connection, frame.id, { sessionKey: "agent:main:created" });
      await expect(request).resolves.toEqual({ sessionKey: "agent:main:created" });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["before refusal", "retry wait", "synchronous refusal"] as const)(
    "does not retry an owner-aborted write: %s",
    async (abortAt) => {
      vi.useFakeTimers();
      const refuse = (id: string) =>
        respond(
          connection,
          id,
          {
            code: "UNAVAILABLE",
            message: "agent is preparing",
            retryable: true,
            retryAfterMs: 250,
            details: { reason: "startup-sidecars", method: "sessions.create" },
          },
          false,
        );
      const { client, connection } = createRequestHarness({
        send: (frame) => {
          if (abortAt === "synchronous refusal") {
            refuse(frame.id);
          }
        },
      });
      const controller = new AbortController();
      const request = client
        .request(
          "sessions.create",
          {},
          {
            timeoutMs: 1_000,
            signal: controller.signal,
            retainSentResultOnAbort: true,
          },
        )
        .catch((error: unknown) => error);
      if (abortAt === "before refusal") {
        controller.abort();
        refuse(latestFrame(connection).id);
      } else {
        if (abortAt === "retry wait") {
          refuse(latestFrame(connection).id);
        }
        controller.abort();
      }
      expect(await request).toMatchObject({
        message: "gateway request aborted for sessions.create",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connection.frames).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps the original deadline while observing an owner-aborted write", async () => {
    vi.useFakeTimers();
    const { client, connection } = createRequestHarness();
    const controller = new AbortController();
    const request = client
      .request(
        "sessions.create",
        {},
        {
          timeoutMs: 1_000,
          signal: controller.signal,
          retainSentResultOnAbort: true,
        },
      )
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(250);
    controller.abort();
    await vi.advanceTimersByTimeAsync(750);
    expect(await request).toMatchObject({
      code: "CLIENT_TIMEOUT",
      timeoutMs: 1_000,
      requestSent: true,
    });
    expect(connection.frames).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout"] as const)(
    "retries startup writes independently and retires a slow request on %s",
    async (retirement) => {
      vi.useFakeTimers();
      const startedAt = Date.now();
      const writes: string[] = [];
      let slowId = "";
      let readyId = "";
      const refuse = (id: string) =>
        respond(
          connection,
          id,
          {
            code: "UNAVAILABLE",
            message: "agent is preparing",
            retryable: true,
            retryAfterMs: 250,
            details: { reason: "startup-sidecars", method: "chat.send" },
          },
          false,
        );
      const { client, connections } = createRequestHarness({
        send: (frame) => {
          if (frame.id === slowId) {
            refuse(frame.id);
          } else if (frame.id === readyId) {
            if (Date.now() - startedAt < 5_000) {
              refuse(frame.id);
            } else {
              writes.push(frame.id);
              respond(connection, frame.id, { written: "ready" });
            }
          }
        },
      });
      const firstConnection = connections[0];
      assert(firstConnection);
      const connection = firstConnection;
      const controller = new AbortController();
      try {
        const slow = client
          .request(
            "chat.send",
            { agentId: "slow" },
            { timeoutMs: 10_000, signal: controller.signal },
          )
          .catch((error: unknown) => error);
        slowId = latestFrame(connection).id;
        const ready = client
          .request("chat.send", { agentId: "ready" }, { timeoutMs: 30_000 })
          .catch((error: unknown) => error);
        readyId = latestFrame(connection).id;
        refuse(slowId);
        refuse(readyId);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(writes).toEqual([readyId]);
        await expect(ready).resolves.toEqual({ written: "ready" });
        if (retirement === "abort") {
          controller.abort();
          expect(await slow).toMatchObject({ message: "gateway request aborted for chat.send" });
        } else {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(await slow).toMatchObject({ code: "CLIENT_TIMEOUT" });
        }
        const sentAtRetirement = connection.frames.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(connection.frames).toHaveLength(sentAtRetirement);
        expect(writes).toEqual([readyId]);
      } finally {
        client.stop();
      }
    },
  );

  it.each([
    { details: { reason: "startup-sidecars" }, accepted: false },
    { details: { reason: "startup-sidecars", method: "sessions.create" }, accepted: false },
    { details: { reason: "busy", method: "chat.send" }, accepted: false },
    { details: { reason: "startup-sidecars", method: "chat.send" }, accepted: true },
  ])(
    "does not replay a write without its own pre-dispatch refusal: %j",
    async ({ details, accepted }) => {
      vi.useFakeTimers();
      const { client, connections } = createRequestHarness();
      const connection = connections[0];
      assert(connection);
      try {
        const request = client.request("chat.send", {}, { expectFinal: true });
        const frame = latestFrame(connection);
        if (accepted) {
          respond(connection, frame.id, { status: "accepted", runId: "admitted" });
        }
        respond(
          connection,
          frame.id,
          {
            code: "UNAVAILABLE",
            message: "not a safe retry",
            retryable: true,
            retryAfterMs: 250,
            details,
          },
          false,
        );
        await expect(request).rejects.toThrow("not a safe retry");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(connection.frames).toHaveLength(1);
      } finally {
        client.stop();
      }
    },
  );
});
