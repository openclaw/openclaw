import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { createDeferred as deferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceGatewayControl } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import { parseOpenAIQuicksilverEvent } from "./realtime-quicksilver-wire.js";
import {
  FakeSocket,
  parseSent,
  createDelegationHarness as createFixture,
  type ConsultRunner,
} from "./realtime-quicksilver.test-helpers.js";

const controllers = new Set<OpenAIQuicksilverDelegationController>();
const finishConsultations: Array<() => Promise<void>> = [];
function createDelegationHarness(params?: Parameters<typeof createFixture>[0]) {
  const harness = createFixture(params);
  controllers.add(harness.controller);
  return harness;
}

function pendingHarness(params?: Parameters<typeof createFixture>[0]) {
  const result = deferred<Awaited<ReturnType<ConsultRunner>>>();
  const runAgentConsult = vi.fn<ConsultRunner>(async () => await result.promise);
  finishConsultations.push(async () => {
    result.resolve({ text: "Finished" });
    await result.promise;
  });
  return { ...createDelegationHarness({ ...params, runAgentConsult }), runAgentConsult, result };
}

function controlHarness(params?: Parameters<typeof createFixture>[0]) {
  let respond!: (text: string) => void;
  const handleDelegationInput = vi.fn<
    NonNullable<RealtimeVoiceGatewayControl["handleDelegationInput"]>
  >((_text, reply) => {
    respond = reply;
    return "control";
  });
  return {
    ...createDelegationHarness({ ...params, handleDelegationInput }),
    handleDelegationInput,
    reply: (text: string) => respond(text),
  };
}

function frame(controller: OpenAIQuicksilverDelegationController, event: unknown) {
  controller.handleFrame(Buffer.from(JSON.stringify(event)), false);
}

function readAppends(socket: FakeSocket, id?: string) {
  return parseSent(socket).filter(
    (event) =>
      event.type === "delegation.context.append" &&
      (id === undefined || event.delegation_item_id === id),
  );
}

function waitForAppend(socket: FakeSocket, id: string, text: string) {
  return vi.waitFor(() => expect(parseSent(socket)).toContainEqual(delegationAppend(id, text)));
}

function parseEvent(event: unknown) {
  return parseOpenAIQuicksilverEvent(JSON.stringify(event));
}

function inputText<T>(text: T) {
  return [{ type: "input_text", text }];
}

function contextAppend<T>(text: T) {
  return {
    type: "session.context.append",
    channel: "speakable",
    content: inputText(text),
  };
}

function delegate(
  controller: OpenAIQuicksilverDelegationController,
  id: string,
  prompt: string,
): void {
  controller.handleEvent({ kind: "delegation", id, prompt });
}

function delegationAppend(id: string, text: string) {
  return {
    ...contextAppend(text),
    type: "delegation.context.append",
    delegation_item_id: id,
  };
}

function appendFinal(runner: ReturnType<typeof vi.fn<ConsultRunner>>, index: number, text: string) {
  return runner.mock.calls[index]?.[0].requesterFinal?.append(text);
}

afterEach(async () => {
  for (const finish of finishConsultations.splice(0)) {
    await finish();
  }
  for (const controller of controllers) {
    controller.stop(new Error("test complete"));
  }
  controllers.clear();
  vi.restoreAllMocks();
});

it("targets the control delegation without consuming transcript context or cancelling the task", async () => {
  const { controller, socket, runAgentConsult, result } = pendingHarness({
    handleDelegationInput: (text, respond) => {
      if (text !== "status") {
        return "consult";
      }
      respond("Host status");
      respond("duplicate status");
      return "control";
    },
  });
  delegate(controller, "task-A", "Original task");
  controller.handleEvent({ kind: "transcript-done", role: "user", text: "history only" });
  const beforeControl = socket.sent.length;
  delegate(controller, "control-C", "status");
  expect(runAgentConsult.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  expect(runAgentConsult).toHaveBeenCalledOnce();
  expect(parseSent(socket).slice(beforeControl)).toEqual([
    delegationAppend("control-C", "Host status"),
  ]);
  result.resolve({ text: "Original result" });
  await waitForAppend(socket, "task-A", "Original result");
  await nextEventLoopTurn();
  delegate(controller, "task-B", "Another task");
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
  expect(runAgentConsult.mock.calls[1]?.[0].prompt).toContain("history only");
});

it("fences a retained control responder after socket replacement", () => {
  const original = new FakeSocket("manual");
  original.readyState = 1;
  const replacement = new FakeSocket("manual");
  replacement.readyState = 1;
  let socket = original;
  const { controller, runAgentConsult, reply } = controlHarness({
    getSocket: () => socket,
  });
  delegate(controller, "control-C", "status");
  socket = replacement;
  reply("Late control");
  expect(original.sent).toEqual([]);
  expect(replacement.sent).toEqual([]);
  expect(runAgentConsult).not.toHaveBeenCalled();
});

it("consumes a multi-chunk response before a send failure and never retries or starts a task", () => {
  const { controller, socket, onFatalError, runAgentConsult, handleDelegationInput, reply } =
    controlHarness();
  const send = vi
    .spyOn(socket, "send")
    .mockImplementationOnce(() => undefined)
    .mockImplementation(() => {
      throw new Error("socket send failed");
    });
  delegate(controller, "control-C", "status");
  reply("x".repeat(1_100));
  reply("second attempt");
  expect(send).toHaveBeenCalledTimes(2);
  expect(onFatalError).toHaveBeenCalledExactlyOnceWith(new Error("socket send failed"));
  expect(handleDelegationInput).toHaveBeenCalledOnce();
  expect(runAgentConsult).not.toHaveBeenCalled();
});

it("does not fall through to a task when native admission throws", () => {
  const { controller, socket, onFatalError, runAgentConsult } = createDelegationHarness({
    handleDelegationInput: () => {
      throw new Error("owner closed");
    },
  });
  delegate(controller, "control-C", "status");
  expect(onFatalError).toHaveBeenCalledOnce();
  expect(socket.sent).toEqual([]);
  expect(runAgentConsult).not.toHaveBeenCalled();
});

it("keeps standalone speech at session scope while a delegation owns its result", async () => {
  const { controller, socket, result } = pendingHarness();
  controller.sendSessionContext("Ready", "speakable");
  delegate(controller, "work", "Check the project");
  controller.sendSessionContext("Still checking", "speakable");
  result.resolve({ text: "Finished checking" });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
  expect(parseSent(socket)).toEqual([
    contextAppend("Ready"),
    contextAppend("Still checking"),
    delegationAppend("work", "Finished checking"),
  ]);
  controller.detach();
  controller.sendSessionContext("Late speech", "speakable");
  expect(socket.sent).toHaveLength(3);
});

it("parses session expiry and assistant transcript events", () => {
  expect(parseEvent({ type: "session.started", session: { expires_at: 123 } })).toEqual({
    kind: "session-started",
    expiresAt: 123,
  });
  expect(parseEvent({ type: "output_transcript.added", item: { text: "wor" } })).toEqual({
    kind: "transcript-delta",
    role: "assistant",
    text: "wor",
  });
});

it("forwards only classified sideband event types", () => {
  const onWireEventType = vi.fn();
  const { controller } = createDelegationHarness({ onWireEventType });

  frame(controller, { type: "sensitive-private-event" });
  frame(controller, { type: "session.updated" });
  frame(controller, { type: "output_audio_buffer.cleared" });

  expect(onWireEventType.mock.calls).toEqual([
    ["session.updated"],
    ["output_audio_buffer.cleared"],
  ]);
});

it("parses client delegations and ignores non-client targets", () => {
  expect(
    parseEvent({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-1",
        content: [
          { type: "input_text", text: "curl https://exa" },
          { type: "output_text", text: "ignored" },
          { type: "input_text", text: "mple.com" },
        ],
      },
    }),
  ).toEqual({ kind: "delegation", id: "delegation-1", prompt: "curl https://example.com" });
  expect(
    parseEvent({
      type: "delegation.created",
      item: { type: "delegation", target: "server", id: "delegation-2", content: [] },
    }),
  ).toEqual({ kind: "ignored", eventType: "delegation.created" });
});

it("parses errors, reports unknown events, and rejects malformed JSON", () => {
  expect(parseEvent({ type: "error", error: { message: "call failed" } })).toEqual({
    kind: "error",
    fatalAuth: false,
  });
  expect(parseEvent({ type: "future.event" })).toEqual({
    kind: "unknown",
    eventType: "future.event",
  });
  expect(parseOpenAIQuicksilverEvent("not-json")).toBeNull();
});

it("revokes the old late-final owner on newer delegation and detach", async () => {
  const revokeRequesterFinal = vi.fn();
  const runAgentConsult = vi
    .fn<ConsultRunner>()
    .mockResolvedValue({ text: "started", yielded: true });
  const { controller } = createDelegationHarness({
    revokeRequesterFinal,
    runAgentConsult,
  });

  delegate(controller, "delegation-old", "old task");
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(runAgentConsult.mock.calls[0]?.[0].requesterFinal).toBeDefined());
  delegate(controller, "delegation-new", "new task");
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
  expect(appendFinal(runAgentConsult, 0, "stale final")).toBe(false);

  controller.detach();
  expect(appendFinal(runAgentConsult, 1, "detached final")).toBe(false);
  expect(revokeRequesterFinal).toHaveBeenCalled();
});

it("bounds and chunks delegation output before sideband sends", async () => {
  const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "x".repeat(10_000) }));
  const { controller, socket } = createDelegationHarness({ runAgentConsult });

  delegate(controller, "delegation-large", "summarize everything");

  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
  const appends = readAppends(socket);
  const content = appends.map((event) => event.content as Array<{ text: string }>);
  expect(appends.length).toBeLessThanOrEqual(11);
  expect(content.map((parts) => parts[0]?.text ?? "").join("")).toMatch(/^x+ \[truncated\]$/);
  expect(content.flat().every(({ text }) => Buffer.byteLength(text, "utf8") <= 500)).toBe(true);
});

it("does not start a late control after the active consultation settles", async () => {
  const { controller, socket, runAgentConsult } = createDelegationHarness({
    handleDelegationInput: (text) => (text === "cancel" ? "control" : "consult"),
  });
  delegate(controller, "finished-task", "first task");
  await waitForAppend(socket, "finished-task", "Done");
  delegate(controller, "late-cancel", "cancel");
  expect(runAgentConsult).toHaveBeenCalledOnce();
  expect(socket.sent).toHaveLength(2);
  expect(parseSent(socket)[0]).toMatchObject(
    contextAppend(expect.stringContaining('Status: "I’ll check that request."')),
  );
});

it("consumes bounded transcript context once and in event order", async () => {
  const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
  const { controller } = createDelegationHarness({ runAgentConsult });
  controller.handleEvent({ kind: "transcript-delta", role: "user", text: "hel" });
  controller.handleEvent({ kind: "transcript-done", role: "user", text: "hello" });
  controller.handleEvent({ kind: "transcript-delta", role: "assistant", text: "ack" });

  delegate(controller, "delegation-1", "check weather");
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(1));
  expect(runAgentConsult.mock.calls[0]?.[0].prompt).toBe(
    "<realtime_delegation>\n  <input>check weather</input>\n  <transcript_delta>user: hello\nassistant: ack</transcript_delta>\n</realtime_delegation>",
  );

  controller.handleEvent({ kind: "transcript-done", role: "user", text: "second context" });
  delegate(controller, "delegation-2", "next task");
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
  expect(runAgentConsult.mock.calls[1]?.[0].prompt).toBe(
    "<realtime_delegation>\n  <input>next task</input>\n  <transcript_delta>user: second context</transcript_delta>\n</realtime_delegation>",
  );
});

it("consumes aborted ownership before starting the pending replacement", async () => {
  const firstResult = deferred<{ text: string }>();
  const runAgentConsult = vi
    .fn<ConsultRunner>()
    .mockImplementationOnce(async () => await firstResult.promise)
    .mockResolvedValue({ text: "latest result" });
  const claimAppend = vi.fn(() => true);
  const { controller, socket } = createDelegationHarness({
    claimAppend,
    runAgentConsult,
  });

  delegate(controller, "delegation-first", "first task");
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
  delegate(controller, "delegation-latest", "latest task");
  expect(runAgentConsult.mock.calls[0]?.[0].signal?.aborted).toBe(true);

  firstResult.resolve({ text: "stale result" });
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
  await waitForAppend(socket, "delegation-latest", "latest result");

  expect(claimAppend).toHaveBeenCalledTimes(2);
  expect(claimAppend.mock.invocationCallOrder[0]).toBeLessThan(
    runAgentConsult.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
  );
  expect(readAppends(socket)).toHaveLength(1);
});

it("steers one accepted run and appends its final result only to the latest delegation", async () => {
  const steerAgentConsult = vi
    .fn<NonNullable<ConsultRunner["steer"]>>()
    .mockResolvedValue({ text: "" });
  const { controller, socket, result, runAgentConsult } = pendingHarness({ steerAgentConsult });

  delegate(controller, "delegation-first", "first task");
  delegate(controller, "delegation-second", "second task");
  delegate(controller, "delegation-latest", "latest task");

  const request = runAgentConsult.mock.calls[0]?.[0];
  expect(request?.signal?.aborted).toBe(false);
  expect(runAgentConsult).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(steerAgentConsult).toHaveBeenCalledOnce());
  expect(steerAgentConsult.mock.calls[0]?.[0].prompt).toContain("latest task");
  expect(steerAgentConsult.mock.calls[0]?.[0].prompt).not.toContain("second task");

  result.resolve({ text: "work continues", yielded: true });
  await waitForAppend(socket, "delegation-latest", "work continues");
  expect(appendFinal(runAgentConsult, 0, "latest result")).toBe(true);
  expect(appendFinal(runAgentConsult, 0, "duplicate result")).toBe(false);
  expect(readAppends(socket, "delegation-latest")).toEqual([
    delegationAppend("delegation-latest", "work continues"),
    delegationAppend("delegation-latest", "latest result"),
  ]);
  expect(readAppends(socket, "delegation-first")).toEqual([]);
});

it("drops queued work when steering fails", async () => {
  const runAgentConsult = vi.fn<ConsultRunner>(async ({ signal }) => {
    return await new Promise<{ text: string }>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
        { once: true },
      );
    });
  });
  const { promise: steering, reject: rejectSteering } = deferred<{ text: string }>();
  const steerAgentConsult = vi.fn<NonNullable<ConsultRunner["steer"]>>(async () => await steering);
  const { controller, onFatalError, socket } = createDelegationHarness({
    runAgentConsult,
    steerAgentConsult,
  });

  delegate(controller, "delegation-first", "first task");
  delegate(controller, "delegation-second", "second task");
  await vi.waitFor(() => expect(steerAgentConsult).toHaveBeenCalledOnce());
  delegate(controller, "delegation-latest", "latest task");
  rejectSteering(new Error("steering failed"));

  await nextEventLoopTurn();
  expect(onFatalError).toHaveBeenCalledOnce();
  expect(runAgentConsult).toHaveBeenCalledOnce();
  expect(socket.sent).toEqual([]);
  expect(appendFinal(runAgentConsult, 0, "late stale result")).toBe(false);
});

it("rejects a revoked completion before provider output", async () => {
  const claimAppend = vi.fn(() => false);
  const revokeRequesterFinal = vi.fn();
  const runAgentConsult = vi.fn<ConsultRunner>().mockResolvedValue({ text: "stale result" });
  const { controller, socket } = createDelegationHarness({
    claimAppend,
    revokeRequesterFinal,
    runAgentConsult,
  });

  delegate(controller, "delegation-stale", "stale task");

  await vi.waitFor(() => expect(claimAppend).toHaveBeenCalledOnce());
  expect(revokeRequesterFinal).toHaveBeenCalledOnce();
  expect(appendFinal(runAgentConsult, 0, "late stale result")).toBe(false);
  expect(socket.sent).toEqual([]);
});

it("preserves successful completion for a plain consult runner", async () => {
  const { controller, onFatalError, socket } = createDelegationHarness({
    claimAppend: null,
    claimFailureAppend: null,
    runAgentConsult: vi.fn(async () => ({ text: "plain result" })),
  });

  delegate(controller, "delegation-plain", "plain task");

  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  expect(onFatalError).not.toHaveBeenCalled();
});

it("fails visibly when completion ownership is unavailable", async () => {
  const runAgentConsult = Object.assign(
    vi.fn(async () => ({ text: "unowned result" })),
    { adoptCompletionClaims: vi.fn() },
  );
  const { controller, onFatalError, socket } = createDelegationHarness({
    claimAppend: null,
    runAgentConsult,
  });

  delegate(controller, "delegation-unowned", "unowned task");

  await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledOnce());
  expect(socket.sent).toEqual([]);
});

it("keeps transcript context when it skips a blank delegation", async () => {
  const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
  const { controller, socket } = createDelegationHarness({
    runAgentConsult,
  });
  controller.handleEvent({ kind: "transcript-done", role: "user", text: "hello" });

  delegate(controller, "non-task", "  ");
  expect(runAgentConsult).not.toHaveBeenCalled();
  expect(socket.sent).toEqual([]);
  delegate(controller, "delegation-1", "check weather");

  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(1));
  expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain(
    "<transcript_delta>user: hello</transcript_delta>",
  );
});

it("drops pending receipts and late results when detached before settlement", async () => {
  const { controller, socket, result, runAgentConsult } = pendingHarness({
    handleDelegationInput: () => "consult",
  });
  delegate(controller, "active", "first task");
  delegate(controller, "pending", "next task");
  expect(socket.sent).toHaveLength(1);
  controller.detach();
  delegate(controller, "late", "late task");
  result.resolve({ text: "Late result" });
  await result.promise;
  await nextEventLoopTurn();
  expect(runAgentConsult).toHaveBeenCalledOnce();
  expect(socket.sent).toHaveLength(1);
});

it("returns a speakable failure for a delegated Unicode failure", async () => {
  const expectedReason = "x".repeat(179);
  const error = new Error(`${expectedReason}🤖`);
  const runAgentConsult = vi.fn<ConsultRunner>().mockRejectedValue(error);
  const { controller, logger, socket } = createDelegationHarness({ runAgentConsult });

  delegate(controller, "delegation-failed", "do work");

  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
  expect(parseSent(socket)).toContainEqual(
    expect.objectContaining({
      delegation_item_id: "delegation-failed",
      channel: "speakable",
      content: inputText(
        "The agent task failed. Tell the user it did not complete and offer to try again.",
      ),
    }),
  );
  expect(socket.sent.join("\n")).not.toContain(error.message);
  expect(logger.warn).toHaveBeenCalledWith(
    `OpenAI GPT-Live delegation consult failed: ${expectedReason}`,
  );
});

it.each([
  { state: "revoked", claimFailureAppend: () => false },
  { state: "unavailable", claimFailureAppend: null },
])("does not append a startup failure when ownership is $state", async ({ claimFailureAppend }) => {
  const runAgentConsult = Object.assign(
    vi.fn<ConsultRunner>().mockRejectedValue(new Error("startup failed")),
    { adoptCompletionClaims: vi.fn() },
  );
  const { controller, onFatalError, socket } = createDelegationHarness({
    claimAppend: () => false,
    claimFailureAppend,
    runAgentConsult,
  });

  delegate(controller, "delegation-startup-rejected", "do work");

  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
  await nextEventLoopTurn();
  expect(socket.sent).toEqual([]);
  if (claimFailureAppend === null) {
    expect(onFatalError).toHaveBeenCalledOnce();
  } else {
    expect(onFatalError).not.toHaveBeenCalled();
  }
});

it("redacts the opaque model from sideband errors before logging or callbacks", () => {
  const model = "gpt-live-test-private";
  const sensitiveDetails = ["sensitive-route", "sensitive-session", "sensitive-transcript"];
  const { controller, logger, onFatalError } = createDelegationHarness();

  frame(controller, {
    type: "error",
    error: {
      code: "invalid_token",
      message: `provider rejected ${model} ${sensitiveDetails.join(" ")}`,
    },
  });

  expect(logger.warn).toHaveBeenCalledWith("OpenAI GPT-Live provider error");
  expect(onFatalError).toHaveBeenCalledOnce();
  const projectedError = onFatalError.mock.calls[0]?.[0];
  expect(projectedError).toBeInstanceOf(Error);
  expect(projectedError).toMatchObject({
    name: "Error",
    message: "OpenAI GPT-Live provider error",
  });
  expect(projectedError?.cause).toBeUndefined();
  const projected = JSON.stringify({
    logs: logger.warn.mock.calls,
  });
  for (const privateValue of [model, ...sensitiveDetails]) {
    expect(projected).not.toContain(privateValue);
  }
});

it("suppresses host cancellation and stops accepting work after teardown", async () => {
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  const runAgentConsult = vi.fn<ConsultRunner>().mockRejectedValue(abortError);
  const { controller, logger, socket } = createDelegationHarness({
    runAgentConsult,
  });

  delegate(controller, "delegation-cancelled", "stop this");
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
  expect(socket.sent).toEqual([]);
  expect(logger.warn).not.toHaveBeenCalled();

  controller.stop(new Error("session closed"));
  delegate(controller, "delegation-late", "late task");
  expect(runAgentConsult).toHaveBeenCalledOnce();
});
