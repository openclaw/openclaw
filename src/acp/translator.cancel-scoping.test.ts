import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createPromptScenario, expectSingleCall } from "./translator.scenario.test-support.js";

const SESSION_KEY = "agent:main:shared";
const SESSION_ID = "session-1";

function tool(h: Harness, runId: string, toolCallId = "tool-2") {
  return h.event("agent", {
    runId,
    stream: "tool",
    data: { phase: "start", name: "read_file", toolCallId, args: { path: "notes.txt" } },
  });
}

function createHarness({
  accepted = false,
  ...options
}: NonNullable<Parameters<typeof createPromptScenario>[0]> & { accepted?: boolean } = {}) {
  return createPromptScenario({
    send: accepted ? (params) => ({ runId: params?.idempotencyKey, status: "started" }) : undefined,
    ...options,
    sessionKey: SESSION_KEY,
  });
}

type Harness = ReturnType<typeof createHarness>;
type Pending = Awaited<ReturnType<Harness["active"]>>;

function blockAbort(h: Harness, first: Pending) {
  const started = createDeferred();
  const released = createDeferred();
  h.request.mockImplementationOnce(async (method) => {
    expect(method).toBe("chat.abort");
    expect(first.settlement).not.toHaveBeenCalled();
    started.resolve();
    await released.promise;
    return {};
  });
  return { started: started.promise, release: released.resolve };
}

function expectAbort(h: Harness, runId: string) {
  expect(h.request).toHaveBeenCalledWith("chat.abort", { sessionKey: SESSION_KEY, runId });
}

async function blockedReplacement(accepted = false, text = "hello") {
  const h = createHarness({ accepted });
  const first = await h.active();
  const abort = blockAbort(h, first);
  const replacement = h.prompt(SESSION_ID, text);
  await abort.started;
  return { h, first, abort, replacement };
}

it.each(["close", "cancel"] as const)(
  "%s wins queued admissions during a blocked abort",
  async (action) => {
    const { h, first, abort, replacement } = await blockedReplacement();
    const third = action === "cancel" ? h.prompt() : undefined;
    const closing =
      action === "close"
        ? h.agent.closeSession({ sessionId: SESSION_ID, _meta: {} })
        : h.agent.cancel({ sessionId: SESSION_ID });
    expectAbort(h, first.runId);
    expect(h.runIds).toEqual([first.runId]);
    abort.release();
    const result = await closing;
    expect(h.runIds).toEqual([first.runId]);
    for (const prompt of [first.result, replacement, ...(third ? [third] : [])]) {
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    }
    if (action === "close") {
      expect(result).toEqual({});
      expect(h.sessionStore.getSession(SESSION_ID)).toBeUndefined();
    }
  },
);

it("settles shutdown when a superseded prompt's abort never returns", async () => {
  const h = createHarness();
  const first = await h.active();
  h.request.mockImplementationOnce(async (method) => {
    expect(method).toBe("chat.abort");
    return new Promise<never>(() => {});
  });
  const replacement = h.prompt();
  await vi.waitFor(() => expectAbort(h, first.runId));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    h.agent.shutdown().then(() => "closed"),
    new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve("still pending"), 25);
    }),
  ]);
  clearTimeout(timeout);
  expect(result).toBe("closed");
  expect(h.runIds).toEqual([first.runId]);
  await expect(replacement).resolves.toEqual({ stopReason: "cancelled" });
});

it("shutdown interrupts a blocked final snapshot", async ({ signal }) => {
  const h = createHarness({ accepted: true });
  const pending = await h.active();
  const started = createDeferred();
  const snapshot = createDeferred<Record<string, unknown>>();
  h.request.mockImplementation(async (method) => {
    if (method === "sessions.list") {
      started.resolve();
      return snapshot.promise;
    }
    return {};
  });
  const terminalEvent = h.chat(pending.runId);
  await started.promise;
  const shutdown = h.agent.shutdown();
  try {
    await withinTest(shutdown, signal);
    await expect(pending.result).resolves.toEqual({ stopReason: "cancelled" });
  } finally {
    snapshot.resolve({ sessions: [] });
    await terminalEvent;
    await shutdown;
  }
});

it("submits only the latest of three overlapping prompts after the active abort settles", async () => {
  const { h, first, abort, replacement: second } = await blockedReplacement(true, "second");
  const third = h.start(SESSION_ID, "third");
  await Promise.resolve();
  expectAbort(h, first.runId);
  expect(h.runIds).toEqual([first.runId]);
  abort.release();
  await vi.waitFor(() => expect(h.runIds).toHaveLength(2));
  await expect(first.result).resolves.toEqual({ stopReason: "cancelled" });
  await expect(second).resolves.toEqual({ stopReason: "cancelled" });
  expect(
    h.request.mock.calls
      .filter(([method]) => method === "chat.send")
      .map(([, params]) => params?.message),
  ).toEqual(["[Working directory: /tmp]\n\nhello", "[Working directory: /tmp]\n\nthird"]);
  const runId = expectDefined(h.runIds[1], "latest admitted run");
  expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(runId);
  await h.finish(third);
});

it("does not replay a superseded prompt after its delayed provenance rejection", async () => {
  const firstSend = createDeferred<Record<string, unknown>>();
  let sends = 0;
  const h = createHarness({
    provenanceMode: "meta",
    send: () => (sends++ === 0 ? firstSend.promise : new Promise<never>(() => {})),
  });
  const first = await h.active();
  const replacement = await h.active();
  await expect(first.result).resolves.toEqual({ stopReason: "cancelled" });
  firstSend.reject(
    Object.assign(new Error("system provenance fields require admin scope"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    }),
  );
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(h.runIds).toEqual([first.runId, replacement.runId]);
  expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(replacement.runId);
  await h.finish(replacement);
});

it("does not let a stale cancel completion remove a newer prompt", async () => {
  const h = createHarness();
  const first = await h.active();
  const abort = blockAbort(h, first);
  const cancellation = h.agent.cancel({ sessionId: SESSION_ID });
  await abort.started;
  const replacement = await h.active();
  abort.release();
  await cancellation;
  await expect(first.result).resolves.toEqual({ stopReason: "cancelled" });
  expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(replacement.runId);
  await h.finish(replacement);
});

it.each([false, true])("cancel fallback (idle: %s)", async (idle) => {
  const h = createHarness({ sessions: idle ? [SESSION_ID, "session-2"] : undefined });
  const pending = await h.active(idle ? "session-2" : SESSION_ID);
  if (!idle) {
    h.sessionStore.clearActiveRun(SESSION_ID);
  }
  await h.agent.cancel({ sessionId: SESSION_ID });
  if (!idle) {
    expectAbort(h, pending.runId);
    await expect(pending.result).resolves.toEqual({ stopReason: "cancelled" });
    return;
  }
  expect(h.request.mock.calls.filter(([method]) => method === "chat.abort")).toEqual([]);
  expect(h.sessionStore.getSession("session-2")?.activeRunId).toBe(pending.runId);
  await h.finish(pending);
});

it("drops stale text from a final snapshot after replacement during thought delivery", async () => {
  const h = createHarness();
  const first = await h.active();
  const thought = "old hidden thought";
  const started = createDeferred();
  const released = createDeferred();
  h.sessionUpdate.mockImplementationOnce(async () => {
    started.resolve();
    await released.promise;
  });
  const staleSnapshot = h.chat(first.runId, {
    message: {
      content: [
        { type: "thinking", thinking: thought },
        { type: "text", text: "old visible response" },
      ],
    },
  });
  await started.promise;
  expect(h.sessionUpdate).toHaveBeenCalledWith({
    sessionId: SESSION_ID,
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thought } },
  });
  const replacement = await h.active();
  released.resolve();
  await staleSnapshot;
  expect(
    h.sessionUpdate.mock.calls.filter(
      ([payload]) => payload.update.sessionUpdate === "agent_message_chunk",
    ),
  ).toEqual([]);
  expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(replacement.runId);
  await expect(first.result).resolves.toEqual({ stopReason: "cancelled" });
  await h.finish(replacement, { seq: 2 });
});

it("routes only matching run events when session keys are shared", async () => {
  const h = createHarness({ sessions: [SESSION_ID, "session-2"] });
  const first = await h.active();
  const second = await h.active("session-2");
  h.sessionUpdate.mockClear();
  await h.chat("run-other");
  await tool(h, "run-other");
  expect(h.sessionUpdate).not.toHaveBeenCalled();
  expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(first.runId);
  expect(h.sessionStore.getSession("session-2")?.activeRunId).toBe(second.runId);
  await tool(h, second.runId);
  expectSingleCall(h.sessionUpdate, { sessionId: "session-2" });
  await h.finish(second, { seq: 2 });
  expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(first.runId);
  await h.finish(first, { seq: 3 });
});
