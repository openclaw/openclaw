import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayProtocolClientOptions } from "./protocol-client-contract.js";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestTiming,
} from "./protocol-client.js";
import {
  createProtocolHarness,
  receive,
  stopProtocolClients,
} from "./protocol-client.test-support.js";
import { isGatewayProtocolResponseError } from "./protocol-request.js";

type RequestConnection = ReturnType<typeof createProtocolHarness>["connections"][number];
type RequestFrame = RequestConnection["frames"][number];

function createRequestHarness(
  options?: Partial<GatewayProtocolClientOptions<Record<string, never>>> & {
    send?: (frame: RequestFrame) => void;
  },
) {
  const { client, connections } = createProtocolHarness(
    { ...options, resolveClose: () => ({ retry: false, notify: false }) },
    { send: options?.send },
  );
  client.start();
  const connection = connections[0];
  assert(connection);
  return { client, connections, connection };
}

function latestFrame(connection: RequestConnection): RequestFrame {
  const frame = connection.frames.at(-1);
  assert(frame);
  return frame;
}

function respond(connection: RequestConnection, id: string, payload: unknown, ok = true): void {
  receive(connection, {
    type: "res",
    id,
    ok,
    ...(ok ? { payload } : { error: payload }),
  });
}

function refuseBootstrapRead(
  connection: RequestConnection,
  id = latestFrame(connection).id,
  retryAfterMs = 60_000,
  reason = "gateway-suspending",
): void {
  respond(
    connection,
    id,
    {
      code: "UNAVAILABLE",
      message: "suspended",
      retryable: true,
      retryAfterMs,
      details: { reason },
    },
    false,
  );
}

function notify(connection: RequestConnection, phase: string): void {
  receive(connection, { type: "event", event: "gateway.suspension", payload: { phase } });
}

function expectMethods(connection: RequestConnection, ...methods: string[]) {
  expect(connection.frames.map((frame) => frame.method)).toEqual(methods);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopProtocolClients();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GatewayProtocolClient requests", () => {
  it.each([false, true])(
    "retains a sent write result after owner abort, retry=%s",
    async (retry) => {
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

  it.each(["gateway-suspending", "gateway-restarting"])(
    "parks 40 bootstrap clients during 30 seconds of %s after refusal",
    async (reason) => {
      let suspended = true;
      let refused = 0;
      let recovered = 0;
      const clients = Array.from({ length: 40 }, () => {
        const harness = createRequestHarness({
          requestTimeoutMs: 60_000,
          send: (frame) => {
            const connection = harness.connections[0];
            assert(connection);
            if (suspended) {
              refused += 1;
            }
            if (suspended) {
              refuseBootstrapRead(connection, frame.id, 60_000, reason);
            } else {
              respond(connection, frame.id, { agentId: "main" });
            }
          },
        });
        const announce = (phase: string) => notify(harness.connection, phase);
        let pending = false;
        const poll = () => {
          if (pending) {
            return;
          }
          pending = true;
          void Promise.all(
            [
              "agent.identity.get",
              "sessions.subscribe",
              "sessions.groups.list",
              "question.list",
              "sessions.list",
            ].map((method) => harness.client.request(method, { agentId: "main" })),
          ).then(
            () => {
              pending = false;
              recovered += 1;
            },
            () => {
              pending = false;
            },
          );
        };
        poll();
        return { ...harness, announce, timer: setInterval(poll, 1_000) };
      });
      try {
        await vi.advanceTimersByTimeAsync(29_999);
        for (const { timer } of clients) {
          clearInterval(timer);
        }
        await vi.advanceTimersByTimeAsync(1);
        suspended = false;
        for (const { announce } of clients) {
          announce("accepting");
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(refused).toBeLessThanOrEqual(40);
        expect(recovered).toBe(40);
      } finally {
        for (const { client, timer } of clients) {
          clearInterval(timer);
          client.stop();
        }
      }
    },
  );

  it("probes one parked bootstrap read with jitter and releases the rest after restart rollback", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { client, connection } = createRequestHarness();
    const first = client.request("sessions.subscribe", {});
    refuseBootstrapRead(connection, latestFrame(connection).id, 10_000, "gateway-restarting");
    const second = client.request("sessions.groups.list", {});
    await vi.advanceTimersByTimeAsync(65_999);
    expect(connection.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.frames).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connection.frames).toHaveLength(2);
    respond(connection, latestFrame(connection).id, { subscribed: true });
    expect(latestFrame(connection).method).toBe("sessions.groups.list");
    respond(connection, latestFrame(connection).id, { groups: [] });
    await expect(first).resolves.toEqual({ subscribed: true });
    await expect(second).resolves.toEqual({ groups: [] });
  });

  it("holds bootstrap reads after shutdown and retires them before reconnect", async () => {
    const { client, connection, connections } = createRequestHarness();
    receive(connection, {
      type: "event",
      event: "shutdown",
      payload: { restartExpectedMs: 1_500 },
    });
    const outcome = client.request("question.list", {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(connection.frames).toHaveLength(0);
    connection.close(1012, "restart");
    expect(await outcome).toMatchObject({ message: "gateway closed (1012): restart" });
    client.start();
    const replacement = connections.at(-1);
    assert(replacement);
    const fresh = client.request("question.list", {});
    respond(replacement, latestFrame(replacement).id, { questions: [] });
    await expect(fresh).resolves.toEqual({ questions: [] });
  });

  it.each(["preparing", "draining", "prepared"])(
    "replaces refusal probes with an announced %s pause despite late refusals",
    async (phase) => {
      vi.useFakeTimers();
      const { client, connection } = createRequestHarness();
      const identity = client.request("agent.identity.get", {});
      const identityFrame = latestFrame(connection);
      const groups = client.request("sessions.groups.list", {});
      refuseBootstrapRead(connection, identityFrame.id);
      await vi.advanceTimersByTimeAsync(500);
      notify(connection, phase);
      refuseBootstrapRead(connection);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(connection.frames.map((frame) => frame.method)).toEqual([
        "agent.identity.get",
        "sessions.groups.list",
      ]);
      notify(connection, "accepting");
      expect(connection.frames.map((frame) => frame.method)).toEqual([
        "agent.identity.get",
        "sessions.groups.list",
        "agent.identity.get",
        "sessions.groups.list",
      ]);
      respond(connection, identityFrame.id, { agentId: "main" });
      respond(connection, latestFrame(connection).id, { groups: [] });
      await expect(identity).resolves.toEqual({ agentId: "main" });
      await expect(groups).resolves.toEqual({ groups: [] });
      client.stop();
    },
  );

  it("does not renew an expired empty pause before the next bootstrap probe", async () => {
    const { client, connection } = createRequestHarness({ requestTimeoutMs: 30_000 });
    const expired = client.request("agent.identity.get", {}).catch((error: unknown) => error);
    refuseBootstrapRead(connection);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await expired).toMatchObject({ code: "CLIENT_TIMEOUT", requestSent: false });
    const first = client.request("sessions.list", {});
    const second = client.request("question.list", {});
    expectMethods(connection, "agent.identity.get", "sessions.list");
    respond(connection, latestFrame(connection).id, { sessions: [] });
    expect(latestFrame(connection).method).toBe("question.list");
    respond(connection, latestFrame(connection).id, { questions: [] });
    await expect(first).resolves.toEqual({ sessions: [] });
    await expect(second).resolves.toEqual({ questions: [] });
  });

  it.each(["gateway-suspending", "gateway-restarting"])(
    "retains the longest outstanding retry deadline for %s",
    async (reason) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const { client, connection } = createRequestHarness();
      const identity = client.request("agent.identity.get", {});
      const groups = client.request("sessions.groups.list", {});
      const [identityFrame, groupsFrame] = connection.frames;
      assert(identityFrame && groupsFrame);
      const reject = (id: string, retryAfterMs: number) =>
        respond(
          connection,
          id,
          {
            code: "UNAVAILABLE",
            message: "draining",
            retryable: true,
            retryAfterMs,
            details: { reason },
          },
          false,
        );
      reject(identityFrame.id, 120_000);
      await vi.advanceTimersByTimeAsync(500);
      reject(groupsFrame.id, 1_000);
      await vi.advanceTimersByTimeAsync(119_499);
      expect(connection.frames).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(connection.frames).toHaveLength(3);
      respond(connection, identityFrame.id, { agentId: "main" });
      respond(connection, groupsFrame.id, { groups: [] });
      await Promise.all([identity, groups]);
      client.stop();
    },
  );

  it("keeps the pause when a probe fails authorization before admission", async () => {
    const { client, connection } = createRequestHarness();
    const question = client.request("question.list", {}).catch((error: unknown) => error);
    refuseBootstrapRead(connection);
    const groups = client.request("sessions.groups.list", {});
    const list = client.request("sessions.list", {});
    await vi.advanceTimersByTimeAsync(60_000);
    respond(
      connection,
      latestFrame(connection).id,
      { code: "FORBIDDEN", message: "missing question scope" },
      false,
    );
    expect(await question).toMatchObject({ gatewayCode: "FORBIDDEN" });
    expectMethods(connection, "question.list", "question.list", "sessions.groups.list");
    respond(connection, latestFrame(connection).id, { groups: [] });
    expect(latestFrame(connection).method).toBe("sessions.list");
    respond(connection, latestFrame(connection).id, { sessions: [] });
    await Promise.all([groups, list]);
  });

  it("does not send queued probes while their shared signal is aborting", async () => {
    const { client, connection } = createRequestHarness();
    const controller = new AbortController();
    const question = client
      .request("question.list", {}, { signal: controller.signal })
      .catch((error: unknown) => error);
    refuseBootstrapRead(connection);
    const outcomes = [
      question,
      ...["sessions.groups.list", "sessions.list"].map((method) =>
        client.request(method, {}, { signal: controller.signal }).catch((error: unknown) => error),
      ),
    ];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connection.frames).toHaveLength(2);
    controller.abort();
    for (const outcome of await Promise.all(outcomes)) {
      expect(outcome).toBeInstanceOf(Error);
    }
    expect(connection.frames).toHaveLength(2);
    expect(client.hasPendingRequests).toBe(false);
  });

  it("does not send queued probes whose deadlines are already due", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { client, connection } = createRequestHarness({ requestTimeoutMs: 70_000 });
    const identity = client.request("agent.identity.get", {}).catch((error: unknown) => error);
    refuseBootstrapRead(connection, latestFrame(connection).id, 1_000, "gateway-restarting");
    const queued = ["sessions.groups.list", "sessions.list"].map((method) =>
      client.request(method, {}).catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await identity).toMatchObject({ code: "CLIENT_TIMEOUT", requestSent: true });
    for (const outcome of await Promise.all(queued)) {
      expect(outcome).toMatchObject({ code: "CLIENT_TIMEOUT", requestSent: false });
    }
    expect(connection.frames).toHaveLength(2);
    expect(client.hasPendingRequests).toBe(false);
  });

  it("does not let an older probe release a newer admission pause", async () => {
    const { client, connection } = createRequestHarness();
    const identity = client.request("agent.identity.get", {});
    refuseBootstrapRead(connection);
    const groups = client.request("sessions.groups.list", {});
    const list = client.request("sessions.list", {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connection.frames).toHaveLength(2);
    notify(connection, "draining");
    respond(connection, latestFrame(connection).id, { agentId: "main" });
    await identity;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(connection.frames).toHaveLength(2);
    notify(connection, "accepting");
    expectMethods(
      connection,
      "agent.identity.get",
      "agent.identity.get",
      "sessions.groups.list",
      "sessions.list",
    );
    const groupsFrame = connection.frames.at(-2);
    assert(groupsFrame);
    respond(connection, groupsFrame.id, { groups: [] });
    respond(connection, latestFrame(connection).id, { sessions: [] });
    await Promise.all([groups, list]);
  });

  it("seeds the identity wait from hello and keeps writes synchronous", async () => {
    const { client, connection } = createRequestHarness();
    receive(connection, { type: "event", event: "connect.challenge", payload: { nonce: "test" } });
    respond(connection, latestFrame(connection).id, {
      snapshot: { suspension: { phase: "prepared" } },
    });
    await vi.advanceTimersByTimeAsync(0);
    const identity = client.request("agent.identity.get", { agentId: "main" });
    const write = client.request("users.prefs.set", { theme: "dark" });
    const control = client.request("gateway.suspend.resume", { suspensionId: "owned" });
    expectMethods(connection, "connect", "users.prefs.set", "gateway.suspend.resume");
    const writeFrame = connection.frames[1];
    assert(writeFrame);
    refuseBootstrapRead(connection, writeFrame.id);
    await expect(write).rejects.toThrow("suspended");
    respond(connection, latestFrame(connection).id, { resumed: true });
    await control;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(connection.frames).toHaveLength(3);
    notify(connection, "accepting");
    expect(latestFrame(connection).method).toBe("agent.identity.get");
    respond(connection, latestFrame(connection).id, { agentId: "main" });
    await expect(identity).resolves.toEqual({ agentId: "main" });
  });

  it.each(["timeout", "abort", "disconnect"])(
    "retires a parked identity on %s without sending it after resume",
    async (retirement) => {
      vi.useFakeTimers();
      const { client, connection, connections } = createRequestHarness();
      notify(connection, "draining");
      const controller = new AbortController();
      const request = client.request(
        "agent.identity.get",
        {},
        { timeoutMs: 500, signal: controller.signal },
      );
      const outcome = request.catch((error: unknown) => error);
      expect(connection.frames).toHaveLength(0);
      if (retirement === "timeout") {
        await vi.advanceTimersByTimeAsync(500);
        expect(await outcome).toMatchObject({ code: "CLIENT_TIMEOUT", requestSent: false });
      } else if (retirement === "abort") {
        controller.abort();
        expect(await outcome).toMatchObject({
          message: "gateway request aborted for agent.identity.get",
        });
      } else {
        connection.close(1012, "restart");
        expect(await outcome).toMatchObject({ message: "gateway closed (1012): restart" });
        client.start();
      }
      notify(connection, "accepting");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connection.frames).toHaveLength(0);
      expect(client.hasPendingRequests).toBe(false);
      const current = connections.at(-1);
      assert(current);
      const next = client.request("agent.identity.get", {});
      respond(current, latestFrame(current).id, { agentId: "main" });
      await expect(next).resolves.toEqual({ agentId: "main" });
      client.stop();
    },
  );

  it("honors retry-after without resetting the original identity deadline", async () => {
    const { client, connection } = createRequestHarness();
    const request = client.request("agent.identity.get", {}, { timeoutMs: 1_500 });
    const outcome = request.catch((error: unknown) => error);
    refuseBootstrapRead(connection, latestFrame(connection).id, 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(connection.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.frames).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await outcome).toMatchObject({ code: "CLIENT_TIMEOUT", requestSent: true });
    expect(client.hasPendingRequests).toBe(false);
  });

  it("retains correlated negative payloads from a custom error factory", async () => {
    const created: GatewayProtocolRequestError[] = [];
    const generatedIds = ["same-id:1", "same-id"];
    const { client, connection } = createRequestHarness({
      createRequestId: () => generatedIds.shift() ?? "same-id",
      createRequestError: (fields) => {
        const error = new GatewayProtocolRequestError(fields);
        error.name = "CustomRequestError";
        created.push(error);
        return error;
      },
    });
    const onAccepted = vi.fn();
    const first = client.request("first", {}, { expectFinal: true, onAccepted });
    const second = client.request("second", {}, { expectFinal: true });
    const [firstFrame, secondFrame] = connection.frames;
    if (!firstFrame || !secondFrame) {
      throw new Error("expected concurrent request frames");
    }
    expect(firstFrame.id).not.toBe(secondFrame.id);
    const fields = {
      code: "UNAVAILABLE",
      message: "failed",
      details: { reason: "busy" },
      retryable: true,
      retryAfterMs: 250,
    };
    for (const [frame, payload] of [
      [secondFrame, { runId: "second-run", privateResult: "not-for-logs" }],
      [firstFrame, { runId: "first-run", status: "accepted" }],
    ] as const) {
      receive(connection, { type: "res", id: frame.id, ok: false, payload, error: fields });
    }
    const errors = await Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error),
    ]);
    for (const [index, error] of errors.entries()) {
      expect(error).toBeInstanceOf(GatewayProtocolRequestError);
      expect(isGatewayProtocolResponseError(error)).toBe(true);
      expect(error).toMatchObject({
        ...fields,
        gatewayCode: fields.code,
        name: "CustomRequestError",
        responsePayload: { runId: index === 0 ? "first-run" : "second-run" },
      });
      expect(JSON.stringify(error)).not.toContain('"responsePayload":');
      expect(JSON.stringify(error)).not.toContain("not-for-logs");
    }
    expect(created.map((error, index) => error === errors[1 - index])).toEqual([true, true]);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(client.hasPendingRequests).toBe(false);
  });

  it("reports typed deadlines before and after the send boundary", async () => {
    vi.useFakeTimers();
    const sentHarness = createRequestHarness();
    const sentRequest = sentHarness.client.request("sent.request", {}, { timeoutMs: 5 });
    const sentOutcome = sentRequest.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5);

    await expect(sentOutcome).resolves.toMatchObject({
      code: "CLIENT_TIMEOUT",
      method: "sent.request",
      timeoutMs: 5,
      requestSent: true,
    });

    let deadline: (() => void) | undefined;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
    ) => {
      deadline = callback as () => void;
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const onSent = vi.fn();
    const unsentHarness = createRequestHarness({ send: () => deadline?.() });
    const unsentRequest = unsentHarness.client.request(
      "unsent.request",
      {},
      { timeoutMs: 5, onSent },
    );

    await expect(unsentRequest).rejects.toMatchObject({
      code: "CLIENT_TIMEOUT",
      method: "unsent.request",
      timeoutMs: 5,
      requestSent: false,
    });
    expect(onSent).not.toHaveBeenCalled();
    expect(unsentHarness.client.hasPendingRequests).toBe(false);
    expect(sentHarness.client.hasPendingRequests).toBe(false);
    sentHarness.client.stop();
    unsentHarness.client.stop();
  });

  it("retires aborted and send-failed IDs before a replacement request", async () => {
    const controller = new AbortController();
    let sendCalls = 0;
    const { client, connection } = createRequestHarness({
      createRequestId: () => "same-id",
      send: () => {
        sendCalls += 1;
        if (sendCalls === 3) {
          throw new Error("synthetic send failure");
        }
      },
    });
    const aborted = client.request("aborted", {}, { timeoutMs: null, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow("gateway request aborted for aborted");

    const replacement = client.request("replacement", {}, { timeoutMs: null });
    expect(latestFrame(connection)).toMatchObject({ id: "2:same-id", method: "replacement" });
    respond(connection, "1:same-id", { stale: true });
    expect(client.hasPendingRequests).toBe(true);
    respond(connection, "2:same-id", { current: true });
    await expect(replacement).resolves.toEqual({ current: true });

    await expect(client.request("send.failure", {}, { timeoutMs: null })).rejects.toThrow(
      "synthetic send failure",
    );
    expect(latestFrame(connection)).toMatchObject({ id: "3:same-id", method: "send.failure" });
    expect(client.hasPendingRequests).toBe(false);
  });

  it("ignores late accepted and final replies after a timeout collision", async () => {
    const onAccepted = vi.fn();
    const { client, connection } = createRequestHarness({ createRequestId: () => "same-id" });
    const retired = client.request("agent", {}, { timeoutMs: 5, expectFinal: true, onAccepted });
    const retiredOutcome = retired.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    await expect(retiredOutcome).resolves.toBeInstanceOf(GatewayProtocolRequestTimeoutError);

    const replacement = client.request(
      "agent",
      {},
      { timeoutMs: null, expectFinal: true, onAccepted },
    );
    expect(latestFrame(connection)).toMatchObject({ id: "2:same-id", method: "agent" });
    respond(connection, "1:same-id", { status: "accepted", runId: "old" });
    respond(connection, "1:same-id", { status: "ok", runId: "old" });
    expect(onAccepted).not.toHaveBeenCalled();
    expect(client.hasPendingRequests).toBe(true);

    respond(connection, "2:same-id", { status: "accepted", runId: "new" });
    respond(connection, "2:same-id", { status: "ok", runId: "new" });
    await expect(replacement).resolves.toEqual({ status: "ok", runId: "new" });
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ status: "accepted", runId: "new" });
  });

  it("isolates callbacks while preserving accepted/final settlement and timing", async () => {
    let nowMs = 10;
    const trace: string[] = [];
    const sentError = new Error("sent callback failed");
    const acceptedError = new Error("accepted callback failed");
    const timingError = new Error("timing callback failed");
    const timingReceivers: unknown[] = [];
    let timing: GatewayProtocolRequestTiming | undefined;
    let callPropertyReads = 0;
    const onRequestTiming = new Proxy(
      function (this: unknown, value: GatewayProtocolRequestTiming) {
        trace.push("timing");
        timingReceivers.push(this);
        timing = value;
        throw timingError;
      },
      {
        get(target, property, receiver) {
          if (property === "call") {
            callPropertyReads += 1;
            throw new Error("timing callback .call must not be read");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const onCallbackError = vi.fn<(label: string, error: unknown) => void>((label) => {
      trace.push(`error:${label}`);
    });
    const { client, connection } = createRequestHarness({
      nowMs: () => nowMs,
      onRequestTiming,
      onCallbackError,
    });
    const request = client.request(
      "agent",
      {},
      {
        timeoutMs: null,
        expectFinal: true,
        onSent: (requestId) => {
          expect(requestId).toBe(latestFrame(connection).id);
          trace.push("sent");
          throw sentError;
        },
        onAccepted: () => {
          trace.push("accepted");
          throw acceptedError;
        },
      },
    );
    const frame = latestFrame(connection);
    respond(connection, frame.id, { status: "accepted" });
    expect(client.hasPendingRequests).toBe(true);
    nowMs = 25;
    respond(connection, frame.id, { status: "ok" });

    await expect(request).resolves.toEqual({ status: "ok" });
    trace.push("resolved");
    expect(trace).toEqual([
      "sent",
      "error:sent",
      "accepted",
      "error:accepted",
      "timing",
      "error:request timing",
      "resolved",
    ]);
    expect(onCallbackError.mock.calls).toEqual([
      ["sent", sentError],
      ["accepted", acceptedError],
      ["request timing", timingError],
    ]);
    expect(callPropertyReads).toBe(0);
    expect(timingReceivers).toHaveLength(1);
    expect(timingReceivers[0]).toMatchObject({ onTiming: onRequestTiming });
    expect(timing).toEqual({
      id: frame.id,
      method: "agent",
      ok: true,
      durationMs: 15,
      startedAtMs: 10,
      endedAtMs: 25,
    });
  });

  it("preserves requests started on a replacement socket by a close timing observer", async () => {
    let recoveredRequest: Promise<{ healthy: boolean }> | undefined;
    const { client, connections } = createRequestHarness({
      createRequestId: () => "same-id",
      onRequestTiming: ({ method }) => {
        if (method === "retired") {
          client.start();
          recoveredRequest = client.request("replacement", {}, { timeoutMs: null });
          void recoveredRequest.catch(() => undefined);
        }
      },
    });
    const firstConnection = connections[0];
    assert(firstConnection);
    const retired = client.request("retired", {}, { timeoutMs: null });
    const alsoRetired = client.request("also-retired", {}, { timeoutMs: null });
    void retired.catch(() => undefined);
    void alsoRetired.catch(() => undefined);

    firstConnection.close(1012, "service restart");

    const replacementConnection = connections[1];
    assert(replacementConnection);
    expect(latestFrame(replacementConnection)).toMatchObject({
      id: "1:same-id",
      method: "replacement",
    });
    expect(client).toMatchObject({ connected: true, hasPendingRequests: true });
    respond(replacementConnection, "1:same-id", { healthy: true });

    await expect(retired).rejects.toThrow("gateway closed (1012): service restart");
    await expect(alsoRetired).rejects.toThrow("gateway closed (1012): service restart");
    await expect(recoveredRequest).resolves.toEqual({ healthy: true });
    expect(client.hasPendingRequests).toBe(false);
  });
});
