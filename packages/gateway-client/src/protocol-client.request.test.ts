import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolRequestTiming,
} from "./protocol-client.js";
import {
  startProtocolHarness,
  lastFrame as latestFrame,
  respond,
  receive,
  challenge,
  stopProtocolClients,
} from "./protocol-client.test-support.js";
import { isGatewayProtocolResponseError } from "./protocol-request.js";

const identityMethod = "agent.identity.get";
const groupsMethod = "sessions.groups.list";
type Harness = ReturnType<typeof startProtocolHarness>;
let client: Harness["client"];
let connection: Harness["connection"];
let connections: Harness["connections"];

type HarnessOptions = NonNullable<Parameters<typeof startProtocolHarness>[0]> &
  NonNullable<Parameters<typeof startProtocolHarness>[1]>;
async function completeHandshake(
  current: Harness["connection"],
  hello: unknown = { type: "hello-ok" },
) {
  challenge(current);
  respond(current, latestFrame(current).id, hello);
  await vi.advanceTimersByTimeAsync(0);
  expect(current.frames[0]?.method).toBe("connect");
  current.frames.splice(0, 1);
}

async function createRequestHarness(
  options: HarnessOptions = {},
  hello: unknown = { type: "hello-ok" },
) {
  let initializing = true;
  const createRequestId = options.createRequestId;
  ({ client, connection, connections } = startProtocolHarness(
    {
      ...options,
      ...(createRequestId
        ? { createRequestId: () => (initializing ? "handshake" : createRequestId()) }
        : {}),
      onRequestTiming: (timing) => {
        if (timing.method !== "connect") {
          options.onRequestTiming?.(timing);
        }
      },
      resolveClose: () => ({ retry: false, notify: false }),
    },
    {
      send: (frame) => {
        if (frame.method !== "connect") {
          options.send?.(frame);
        }
      },
    },
  ));
  await completeHandshake(connection, hello);
  initializing = false;
}

function retainedWrite(options: GatewayProtocolRequestOptions = {}) {
  const controller = new AbortController();
  const result = sendRequest("sessions.create", {
    timeoutMs: 1_000,
    signal: controller.signal,
    retainSentResultOnAbort: true,
    ...options,
  }).catch((error: unknown) => error);
  return { controller, result };
}

function refuse(
  id: string,
  details: { reason: string; method?: string },
  retryAfterMs = 250,
  message = "agent is preparing",
): void {
  reply({ code: "UNAVAILABLE", message, retryable: true, retryAfterMs, details }, id, false);
}

function refuseBootstrapRead(
  id = last().id,
  retryAfterMs = 60_000,
  reason = "gateway-suspending",
): void {
  refuse(id, { reason }, retryAfterMs, "suspended");
}

function notify(phase: string): void {
  receive(connection, { type: "event", event: "gateway.suspension", payload: { phase } });
}

function last(index = -1) {
  const frame = connection.frames.at(index);
  assert(frame);
  return frame;
}

function sendRequest<T = unknown>(
  method: string,
  options?: GatewayProtocolRequestOptions,
  params: unknown = {},
) {
  return client.request<T>(method, params, options);
}

function reply(payload: unknown, id = last().id, ok = true) {
  respond(connection, id, payload, ok);
}

async function advance(ms: number, count: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(connection.frames).toHaveLength(count);
}

function expectMethods(...methods: string[]) {
  expect(connection.frames.map((frame) => frame.method)).toEqual(methods);
}

beforeEach(async () => {
  vi.useFakeTimers();
  await createRequestHarness();
});

afterEach(() => {
  stopProtocolClients();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GatewayProtocolClient requests", () => {
  it.each(["direct", "retried", "deadline"])("retains aborted writes: %s", async (completion) => {
    const retry = completion === "retried";
    const onAccepted = vi.fn();
    const { controller, result } = retainedWrite({ expectFinal: retry, onAccepted });
    const frame = last();
    if (retry) {
      refuse(frame.id, { reason: "startup-sidecars", method: "sessions.create" });
      await advance(250, 2);
    }
    if (completion === "deadline") {
      await vi.advanceTimersByTimeAsync(250);
    }
    controller.abort();
    if (retry) {
      reply({ status: "accepted" }, frame.id);
      expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ status: "accepted" });
    }
    if (completion === "deadline") {
      await advance(750, 1);
      expect(await result).toMatchObject({
        code: "CLIENT_TIMEOUT",
        timeoutMs: 1_000,
        requestSent: true,
      });
    } else {
      reply({ sessionKey: "agent:main:created" }, frame.id);
      await expect(result).resolves.toEqual({ sessionKey: "agent:main:created" });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["before", "waiting", "sync"] as const)("aborts before retry: %s", async (abortAt) => {
    const refuseWrite = (id: string) =>
      refuse(id, { reason: "startup-sidecars", method: "sessions.create" });
    await createRequestHarness({
      send: (frame) => {
        if (abortAt === "sync") {
          refuseWrite(frame.id);
        }
      },
    });
    const { controller, result } = retainedWrite();
    if (abortAt === "before") {
      controller.abort();
      refuseWrite(last().id);
    } else {
      if (abortAt === "waiting") {
        refuseWrite(last().id);
      }
      controller.abort();
    }
    expect(await result).toHaveProperty("message", "gateway request aborted for sessions.create");
    await advance(1_000, 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { details: { reason: "startup-sidecars" }, accepted: false },
    { details: { reason: "startup-sidecars", method: "sessions.create" }, accepted: false },
    { details: { reason: "busy", method: "chat.send" }, accepted: false },
    { details: { reason: "startup-sidecars", method: "chat.send" }, accepted: true },
  ])("requires correlated refusal: %j", async ({ details, accepted }) => {
    const request = sendRequest("chat.send", { expectFinal: true });
    const frame = last();
    if (accepted) {
      reply({ status: "accepted", runId: "admitted" }, frame.id);
    }
    refuse(frame.id, details, 250, "not a safe retry");
    await expect(request).rejects.toThrow("not a safe retry");
    await advance(1_000, 1);
  });

  it("jitters one rollback probe before releasing queued reads", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const first = sendRequest("sessions.subscribe");
    refuseBootstrapRead(last().id, 10_000, "gateway-restarting");
    const second = sendRequest(groupsMethod);
    await advance(65_999, 1);
    await advance(1, 2);
    await advance(30_000, 2);
    reply({ subscribed: true });
    expect(last().method).toBe(groupsMethod);
    reply({ groups: [] });
    await expect(first).resolves.toEqual({ subscribed: true });
    await expect(second).resolves.toEqual({ groups: [] });
  });

  it.each(["preparing", "draining", "prepared"])("parks on late %s", async (phase) => {
    const identity = sendRequest(identityMethod);
    const identityFrame = last();
    const groups = sendRequest(groupsMethod);
    refuseBootstrapRead(identityFrame.id);
    await vi.advanceTimersByTimeAsync(500);
    notify(phase);
    refuseBootstrapRead();
    await vi.advanceTimersByTimeAsync(600_000);
    expectMethods(identityMethod, groupsMethod);
    notify("accepting");
    expectMethods(identityMethod, groupsMethod, identityMethod, groupsMethod);
    reply({ agentId: "main" }, identityFrame.id);
    reply({ groups: [] });
    await expect(identity).resolves.toEqual({ agentId: "main" });
    await expect(groups).resolves.toEqual({ groups: [] });
  });

  it("does not renew an expired empty pause before the next bootstrap probe", async () => {
    await createRequestHarness({ requestTimeoutMs: 30_000 });
    const expired = sendRequest(identityMethod).catch((error: unknown) => error);
    refuseBootstrapRead();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await expired).toMatchObject({ code: "CLIENT_TIMEOUT", requestSent: false });
    const first = sendRequest("sessions.list");
    const second = sendRequest("question.list");
    expectMethods(identityMethod, "sessions.list");
    reply({ sessions: [] });
    expect(last().method).toBe("question.list");
    reply({ questions: [] });
    await expect(first).resolves.toEqual({ sessions: [] });
    await expect(second).resolves.toEqual({ questions: [] });
  });

  it.each(["gateway-suspending", "gateway-restarting"])("max deadline: %s", async (reason) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const identity = sendRequest(identityMethod);
    const groups = sendRequest(groupsMethod);
    const [identityFrame, groupsFrame] = connection.frames;
    assert(identityFrame && groupsFrame);
    const reject = (id: string, retryAfterMs: number) =>
      refuse(id, { reason }, retryAfterMs, "draining");
    reject(identityFrame.id, 120_000);
    await vi.advanceTimersByTimeAsync(500);
    reject(groupsFrame.id, 1_000);
    await advance(119_499, 2);
    await advance(1, 3);
    reply({ agentId: "main" }, identityFrame.id);
    reply({ groups: [] }, groupsFrame.id);
    await Promise.all([identity, groups]);
  });

  it("keeps the pause when a probe fails authorization before admission", async () => {
    const question = sendRequest("question.list").catch((error: unknown) => error);
    refuseBootstrapRead();
    const groups = sendRequest(groupsMethod);
    const list = sendRequest("sessions.list");
    await vi.advanceTimersByTimeAsync(60_000);
    reply({ code: "FORBIDDEN", message: "missing question scope" }, last().id, false);
    expect(await question).toMatchObject({ gatewayCode: "FORBIDDEN" });
    expectMethods("question.list", "question.list", groupsMethod);
    reply({ groups: [] });
    expect(last().method).toBe("sessions.list");
    reply({ sessions: [] });
    await Promise.all([groups, list]);
  });

  it.each(["abort", "timeout"])("does not send queued probes retired by %s", async (retirement) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await createRequestHarness({ requestTimeoutMs: 70_000 });
    const controller = new AbortController();
    const queuedRequest = (method: string) =>
      sendRequest(method, { signal: controller.signal }).catch((error: unknown) => error);
    const identity = queuedRequest(identityMethod);
    refuseBootstrapRead(last().id, 1_000, "gateway-restarting");
    const queued = [groupsMethod, "sessions.list"].map(queuedRequest);
    await advance(60_000, 2);
    if (retirement === "abort") {
      controller.abort();
      expect(await identity).toBeInstanceOf(Error);
    } else {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await identity).toMatchObject({ code: "CLIENT_TIMEOUT", requestSent: true });
    }
    for (const outcome of await Promise.all(queued)) {
      if (retirement === "abort") {
        expect(outcome).toBeInstanceOf(Error);
      } else {
        expect(outcome).toMatchObject({ code: "CLIENT_TIMEOUT", requestSent: false });
      }
    }
    expect(connection.frames).toHaveLength(2);
    expect(client.hasPendingRequests).toBe(false);
  });

  it("does not let an older probe release a newer admission pause", async () => {
    const identity = sendRequest(identityMethod);
    refuseBootstrapRead();
    const groups = sendRequest(groupsMethod);
    const list = sendRequest("sessions.list");
    await advance(60_000, 2);
    notify("draining");
    reply({ agentId: "main" });
    await identity;
    await advance(600_000, 2);
    notify("accepting");
    expectMethods(identityMethod, identityMethod, groupsMethod, "sessions.list");
    const groupsFrame = last(-2);
    reply({ groups: [] }, groupsFrame.id);
    reply({ sessions: [] });
    await Promise.all([groups, list]);
  });

  it("seeds the identity wait from hello and keeps writes synchronous", async () => {
    await createRequestHarness(
      {},
      { type: "hello-ok", snapshot: { suspension: { phase: "prepared" } } },
    );
    const identity = sendRequest(identityMethod, undefined, { agentId: "main" });
    const write = sendRequest("users.prefs.set", undefined, { theme: "dark" });
    const control = sendRequest("gateway.suspend.resume", undefined, { suspensionId: "owned" });
    expectMethods("users.prefs.set", "gateway.suspend.resume");
    const writeFrame = last(0);
    refuseBootstrapRead(writeFrame.id);
    await expect(write).rejects.toThrow("suspended");
    reply({ resumed: true });
    await control;
    await advance(600_000, 2);
    notify("accepting");
    expect(last().method).toBe(identityMethod);
    reply({ agentId: "main" });
    await expect(identity).resolves.toEqual({ agentId: "main" });
  });

  it.each(["timeout", "abort", "disconnect", "shutdown"])("retires on %s", async (retirement) => {
    const shutdown = retirement === "shutdown";
    if (shutdown) {
      receive(connection, {
        type: "event",
        event: "shutdown",
        payload: { restartExpectedMs: 1_500 },
      });
    } else {
      notify("draining");
    }
    const method = shutdown ? "question.list" : identityMethod;
    const controller = new AbortController();
    const request = sendRequest(method, {
      timeoutMs: shutdown ? null : 500,
      signal: controller.signal,
    });
    const outcome = request.catch((error: unknown) => error);
    expect(connection.frames).toHaveLength(0);
    if (retirement === "timeout") {
      await vi.advanceTimersByTimeAsync(500);
      expect(await outcome).toMatchObject({
        code: "CLIENT_TIMEOUT",
        requestSent: false,
        method,
        timeoutMs: 500,
      });
    } else if (retirement === "abort") {
      controller.abort();
      expect(await outcome).toHaveProperty(
        "message",
        "gateway request aborted for agent.identity.get",
      );
    } else {
      if (shutdown) {
        await advance(600_000, 0);
      }
      connection.close(1012, "restart");
      expect(await outcome).toMatchObject({ message: "gateway closed (1012): restart" });
      client.start();
      const replacement = connections.at(-1);
      assert(replacement);
      await completeHandshake(replacement);
    }
    notify("accepting");
    await advance(60_000, 0);
    expect(client.hasPendingRequests).toBe(false);
    const current = connections.at(-1);
    assert(current);
    const next = sendRequest(method);
    const payload = shutdown ? { questions: [] } : { agentId: "main" };
    respond(current, latestFrame(current).id, payload);
    await expect(next).resolves.toEqual(payload);
  });

  it("retains correlated negative payloads from a custom error factory", async () => {
    const created: GatewayProtocolRequestError[] = [];
    const generatedIds = ["same-id:1", "same-id"];
    await createRequestHarness({
      createRequestId: () => generatedIds.shift() ?? "same-id",
      createRequestError: (fields) => {
        const error = new GatewayProtocolRequestError(fields);
        created.push(error);
        return error;
      },
    });
    const onAccepted = vi.fn();
    const first = sendRequest("first", { expectFinal: true, onAccepted });
    const second = sendRequest("second", { expectFinal: true });
    const firstFrame = last(0);
    const secondFrame = last(1);
    const fields = { code: "UNAVAILABLE", message: "failed" };
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
      expect(isGatewayProtocolResponseError(error)).toBe(true);
      expect(error).toHaveProperty(
        "responsePayload.runId",
        index === 0 ? "first-run" : "second-run",
      );
      expect(JSON.stringify(error)).not.toContain('"responsePayload":');
      expect(JSON.stringify(error)).not.toContain("not-for-logs");
    }
    expect(created.map((error, index) => error === errors[1 - index])).toEqual([true, true]);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(client.hasPendingRequests).toBe(false);
  });

  it("retires aborted and send-failed IDs before a replacement request", async () => {
    const controller = new AbortController();
    let sendCalls = 0;
    await createRequestHarness({
      createRequestId: () => "same-id",
      send: (frame) => {
        sendCalls += 1;
        if (sendCalls === 3) {
          throw new Error("synthetic send failure");
        }
        if (frame.method === "next") {
          reply({ current: true }, frame.id);
        }
      },
    });
    const aborted = sendRequest("aborted", { timeoutMs: null, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow("gateway request aborted for aborted");

    const replacement = sendRequest("replacement", { timeoutMs: null });
    expect(last()).toMatchObject({ id: "3:same-id", method: "replacement" });
    reply({ stale: true }, "2:same-id");
    expect(client.hasPendingRequests).toBe(true);
    reply({ current: true }, "3:same-id");
    await expect(replacement).resolves.toEqual({ current: true });

    await expect(sendRequest("send.failure", { timeoutMs: null })).rejects.toThrow(
      "synthetic send failure",
    );
    expect(last()).toMatchObject({ id: "4:same-id", method: "send.failure" });
    expect(client.hasPendingRequests).toBe(false);
    const onSent = vi.fn();
    await expect(sendRequest("next", { onSent })).resolves.toEqual({ current: true });
    expect(onSent).not.toHaveBeenCalled();
  });

  it("ignores late accepted and final replies after a timeout collision", async () => {
    const onAccepted = vi.fn();
    await createRequestHarness({ createRequestId: () => "same-id" });
    const retired = sendRequest("agent", { timeoutMs: 5, expectFinal: true, onAccepted });
    const retiredOutcome = retired.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    await expect(retiredOutcome).resolves.toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(await retiredOutcome).toMatchObject({
      code: "CLIENT_TIMEOUT",
      method: "agent",
      timeoutMs: 5,
      requestSent: true,
    });
    expect(client.hasPendingRequests).toBe(false);

    const replacement = sendRequest("agent", { timeoutMs: null, expectFinal: true, onAccepted });
    expect(last()).toMatchObject({ id: "3:same-id", method: "agent" });
    reply({ status: "accepted", runId: "old" }, "2:same-id");
    reply({ status: "ok", runId: "old" }, "2:same-id");
    expect(onAccepted).not.toHaveBeenCalled();
    expect(client.hasPendingRequests).toBe(true);

    reply({ status: "accepted", runId: "new" }, "3:same-id");
    reply({ status: "ok", runId: "new" }, "3:same-id");
    await expect(replacement).resolves.toEqual({ status: "ok", runId: "new" });
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ status: "accepted", runId: "new" });
  });

  it("isolates callbacks while preserving accepted/final settlement and timing", async () => {
    let nowMs = 10;
    const trace: string[] = [];
    const callbackError = new Error("callback failed");
    const fail = (label: string) => {
      trace.push(label);
      throw callbackError;
    };
    const onRequestTiming = (timing: GatewayProtocolRequestTiming) => {
      expect(timing.durationMs).toBe(15);
      fail("timing");
    };
    Object.defineProperty(onRequestTiming, "call", {
      get() {
        throw new Error("callback.call must not be read");
      },
    });
    const onCallbackError = vi.fn<(label: string, error: unknown) => void>((label) => {
      trace.push(`error:${label}`);
    });
    await createRequestHarness({ nowMs: () => nowMs, onRequestTiming, onCallbackError });
    const request = sendRequest("agent", {
      timeoutMs: null,
      expectFinal: true,
      onSent: (id) => {
        expect(id).toBe(last().id);
        fail("sent");
      },
      onAccepted: () => fail("accepted"),
    });
    reply({ status: "accepted" });
    expect(client.hasPendingRequests).toBe(true);
    nowMs = 25;
    reply({ status: "ok" });
    await expect(request).resolves.toEqual({ status: "ok" });
    trace.push("resolved");
    expect(trace.join(",")).toBe(
      "sent,error:sent,accepted,error:accepted,timing,error:request timing,resolved",
    );
    expect(onCallbackError.mock.calls).toEqual(
      ["sent", "accepted", "request timing"].map((label) => [label, callbackError]),
    );
  });

  it("preserves requests started on a replacement socket by a close timing observer", async () => {
    let recoveredRequest: Promise<{ healthy: boolean }> | undefined;
    await createRequestHarness({
      createRequestId: () => "same-id",
      onRequestTiming: ({ method }) => {
        if (method === "retired") {
          client.start();
          recoveredRequest = sendRequest("replacement", { timeoutMs: null });
          void recoveredRequest.catch(() => undefined);
        }
      },
    });
    const retired = sendRequest("retired", { timeoutMs: null });
    const alsoRetired = sendRequest("also-retired", { timeoutMs: null });
    void retired.catch(() => undefined);
    void alsoRetired.catch(() => undefined);

    connection.close(1012, "service restart");
    const replacementConnection = connections[1];
    assert(replacementConnection);
    expect(replacementConnection.frames).toEqual([]);
    await completeHandshake(replacementConnection);
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
