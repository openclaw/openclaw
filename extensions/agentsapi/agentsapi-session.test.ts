import type { AgentSession, AgentSessionMessage } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred as deferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAttemptParams } from "./agentsapi-attempt.test-helpers.js";
import { AgentsApiClient, type AgentsApiEvent, type AgentsApiItem } from "./agentsapi-client.js";
import { AgentsApiMessageProjection } from "./agentsapi-messages.js";
import { createAgentsApiSession } from "./agentsapi-session.js";
import { createHostedSession, createModel, createTurn } from "./agentsapi.test-support.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

type GuardedRequest = Parameters<
  typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard
>[0];
let controller: AbortController;
let stream: ReturnType<typeof createEventStream>;
let submitted: ReturnType<typeof deferred<void>>;
let savedTurns: Turn[];
let savedItems: AgentsApiItem[];
let savedSession: AgentSession;
let inputTypes: string[];
let post: (type: string, request: GuardedRequest) => Response | Promise<Response>;
let read: (url: string) => Response | Promise<Response>;

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  controller = new AbortController();
  stream = createEventStream();
  submitted = deferred<void>();
  savedTurns = [];
  savedItems = [];
  savedSession = createHostedSession("in_progress");
  inputTypes = [];
  post = () => Response.json({});
  read = savedStateResponse;
  fetchWithSsrFGuardMock.mockImplementation(async (request) => {
    request.beforeRequest?.();
    let response: Response;
    if (request.init?.method === "POST") {
      const body: unknown = await new Request(request.url, request.init).json();
      const { events } = z
        .object({ events: z.array(z.object({ type: z.string() })).nonempty() })
        .parse(body);
      inputTypes.push(...events.map((event) => event.type));
      response = await post(events[0]!.type, request);
    } else if (new Headers(request.init?.headers).get("accept") === "text/event-stream") {
      response = stream.response(request.signal);
    } else {
      response = await read(request.url);
    }
    return { response, finalUrl: request.url, release: async () => {} };
  });
});

afterEach(() => vi.useRealTimers());

describe("Agents API native session receipts", () => {
  it.each(["idle", "disconnect"] as const)(
    "reconciles late terminal records after %s without another native event or input",
    async (boundary) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { session, result } = startSession();
      try {
        await submitted.promise;
        await stream.send({ type: "agent.session.in_progress" });
        const healthyRequests = fetchWithSsrFGuardMock.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(healthyRequests);
        if (boundary === "idle") {
          await stream.send({ type: "agent.session.idle" });
        } else {
          const reconnected = stream.nextSubscription();
          stream.disconnect();
          await vi.advanceTimersByTimeAsync(500);
          await reconnected;
        }
        // A later consumed event fences the preceding saved-state read. It is
        // not a terminal signal and cannot repair late REST records on its own.
        await stream.send({ type: "fixture.recovery_barrier" });
        await vi.advanceTimersByTimeAsync(999);
        expect(session.isSettled()).toBe(false);
        completeSavedState();
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toMatchObject({ turn: { id: "turn-fixture" } });
        expect(inputTypes).toEqual(["agent.session.input.message"]);
      } finally {
        await abortSession(session, result);
      }
    },
  );
  it("waits for session idle and the admitted input receipt after the root turn completes", async () => {
    const { session, result } = startSession();
    await submitted.promise;

    const createdTurn = createTurn({ status: "in_progress", completed_at: null });
    savedTurns = [createdTurn];
    await stream.send({ type: "agent.session.turn.created", turn: createdTurn });
    const completedTurn = createTurn();
    savedTurns = [completedTurn];
    await stream.send({ type: "agent.session.turn.completed", turn: completedTurn });
    // Observing the next event fences the completed turn's saved-state reconciliation.
    await stream.send({ type: "agent.session.in_progress" });
    expect(session.isSettled()).toBe(false);

    savedSession = createHostedSession("idle");
    savedItems = [createSavedMessage("assistant-fixture", "assistant", "Fixture reply")];
    await stream.send({ type: "agent.session.idle" });
    await stream.send({
      type: "agent.session.turn.output_text.done",
      item_id: "assistant-fixture",
      content_index: 0,
      text: "Fixture reply",
    });
    expect(session.isSettled()).toBe(false);

    const inputReceipt = createSavedMessage("input-fixture", "user", "Fixture prompt");
    savedItems = [inputReceipt, ...savedItems];
    await stream.send({ type: "agent.session.turn.item.done", item: inputReceipt });

    await expect(result).resolves.toMatchObject({ turn: { id: "turn-fixture" }, cancelled: false });
    expect(session.isSettled()).toBe(true);
    await session.close();
  });

  it.each(["active", "completed", "completes before input"] as const)(
    "settles a continuation with a %s prior root on its late input receipt",
    async (priorStatus) => {
      const historicalTurn = createTurn({ id: "turn-history" });
      const priorTurn = createTurn({
        id: "turn-prior",
        status: priorStatus === "completed" ? "completed" : "in_progress",
        completed_at: priorStatus === "completed" ? 2 : null,
      });
      const currentTurn = createTurn({
        id: priorStatus === "active" ? priorTurn.id : "turn-current",
      });
      const historicalInput = createInput("input-history", historicalTurn.id);
      const priorInput = createInput("input-prior", priorTurn.id);
      const priorCommand: AgentsApiItem = {
        id: "command-prior",
        type: "command_execution",
        turn_id: priorTurn.id,
        command: "fixture-worker",
        status: "in_progress",
      };
      const continuationInput = createInput("input-continuation", currentTurn.id);
      savedTurns = [historicalTurn, priorTurn];
      savedItems = [historicalInput, priorInput, priorCommand];
      post = () => {
        savedTurns = [historicalTurn, { ...priorTurn, status: "completed" }];
        if (currentTurn.id !== priorTurn.id) {
          savedTurns.push(currentTurn);
        }
        savedItems = [
          historicalInput,
          priorInput,
          { ...priorCommand, status: "completed", exit_code: 0, output: "Worker result" },
        ];
        savedSession = createHostedSession("idle");
        return Response.json({});
      };
      const onReconcile = vi.fn(async (_turn: Turn, _items: AgentsApiItem[]) => {});
      const onReconcileHistory = vi.fn(async () => {});
      const observedEvents: AgentsApiEvent[] = [];
      const { session, result } = startSession(
        createSession({ onReconcile, onReconcileHistory }, (event) => {
          observedEvents.push(event);
          stream.observe(event);
        }),
        "Continue existing work",
      );
      try {
        await submitted.promise;
        void stream.send({ type: "agent.session.turn.completed", turn: historicalTurn });
        void stream.send({ type: "agent.session.turn.item.done", item: priorInput });
        await stream.send({ type: "agent.session.idle" });
        await stream.send({ type: "agent.session.in_progress" });
        expect(session.isSettled()).toBe(false);

        savedItems.push(continuationInput);
        void stream.send({ type: "agent.session.turn.item.done", item: continuationInput });
        // A still-waiting session consumes this next event. A settled session
        // completes first, so the pre-fix failure needs no timer or polling.
        const outcome = await Promise.race([
          result.then((value) => ({ kind: "settled", value })),
          stream.send({ type: "agent.session.in_progress" }).then(() => ({ kind: "waiting" })),
        ]);
        expect(outcome).toMatchObject({ kind: "settled", value: { turn: { id: currentTurn.id } } });
        expect(inputTypes).toEqual(["agent.session.input.message"]);
        expect(onReconcile.mock.calls.map(([turn]) => turn.id)).toEqual(
          priorStatus === "completes before input"
            ? [priorTurn.id, currentTurn.id]
            : [currentTurn.id],
        );
        if (priorStatus !== "completed") {
          expect(onReconcile.mock.calls[0]?.[1]).toContainEqual({
            ...priorCommand,
            status: "completed",
            exit_code: 0,
            output: "Worker result",
          });
        }
        expect(onReconcileHistory).toHaveBeenCalledWith(
          expect.arrayContaining([{ turn: historicalTurn, items: [historicalInput] }]),
        );
        expect(observedEvents.filter((event) => event.turn)).toEqual([]);
      } finally {
        await abortSession(session, result);
      }
    },
  );

  it("continues when an external executor satisfies its connection action", async () => {
    savedSession.environment = {
      type: "self_hosted",
      id: "environment-fixture",
      workspace_directory: "/fixture/workspace",
      remote_url: "wss://executor.invalid/session-fixture",
      capability_directories: [],
    };
    const { session, result } = startSession();
    await submitted.promise;
    savedSession = {
      ...savedSession,
      status: "requires_action",
      required_actions: [{ type: "environment_connection", environment_id: "environment-fixture" }],
    };
    await stream.send({ type: "agent.session.requires_action" });
    savedSession = { ...savedSession, status: "idle", required_actions: [] };
    completeSavedState();
    await stream.send({ type: "agent.session.idle" });
    await expect(result).resolves.toMatchObject({ turn: { id: "turn-fixture" } });
    expect(inputTypes).toEqual(["agent.session.input.message"]);
    await session.close();
  });

  it("surfaces a rejected input without waiting for another stream event or resubmitting it", async () => {
    savedSession = createHostedSession("idle");
    post = (type) =>
      type === "agent.session.input.message"
        ? Response.json(
            { error: { message: "Fixture input rejected", type: "invalid_request_error" } },
            { status: 400 },
          )
        : Response.json({});
    const session = createSession();
    await expect(runSession(session)).rejects.toThrow("Fixture input rejected");
    await expect(session.close()).rejects.toThrow("Fixture input rejected");
    expect(inputTypes).toEqual(["agent.session.input.message", "agent.session.input.cancel"]);
  });

  it.each([false, true])(
    "fails only for a currently failed session (failed: %s)",
    async (failed) => {
      const { session, result } = startSession();
      await submitted.promise;
      if (failed) {
        savedSession = { ...savedSession, status: "failed", error: "Fixture terminal failure" };
      }
      await stream.send({ type: "agent.session.failed" });
      if (failed) {
        await expect(result).rejects.toThrow("Fixture terminal failure");
      } else {
        await stream.send({ type: "agent.session.in_progress" });
        completeSavedState();
        await stream.send({ type: "agent.session.idle" });
        await expect(result).resolves.toMatchObject({ turn: { id: "turn-fixture" } });
      }
      await session.close();
    },
  );

  it("preserves a pending message acknowledgement before cancellation and waits for native idle", async () => {
    const messageRequested = deferred<void>();
    const messageAcknowledgement = deferred<Response>();
    const idleRequested = deferred<void>();
    const idleReceipt = deferred<Response>();
    let messageSignal: AbortSignal | undefined;
    post = (inputType, request) => {
      if (inputType === "agent.session.input.message") {
        messageSignal = request.signal;
        messageRequested.resolve();
        return messageAcknowledgement.promise;
      }
      return Response.json({});
    };
    read = (url) => {
      if (new URL(url).pathname !== "/v1/agents/sessions/session-fixture") {
        return savedStateResponse(url);
      }
      if (!inputTypes.includes("agent.session.input.cancel")) {
        throw new Error("Expected native cancellation before the idle request");
      }
      idleRequested.resolve();
      return idleReceipt.promise;
    };
    const { session, result: run } = startSession();
    await messageRequested.promise;
    const queuedSteer = session.queueMessage("Queued steering fixture");
    void queuedSteer.catch(() => {});
    const interruption = new Error("Host interruption");
    controller.abort(interruption);
    let closeSettled = false;
    const closing = session.close().then(() => {
      closeSettled = true;
    });

    expect(messageSignal?.aborted).toBe(false);
    expect(inputTypes).toEqual(["agent.session.input.message"]);
    expect(closeSettled).toBe(false);

    messageAcknowledgement.resolve(Response.json({}));
    await expect(queuedSteer).rejects.toThrow("Agents API turn settled before input was submitted");
    await idleRequested.promise;
    expect(inputTypes).toEqual(["agent.session.input.message", "agent.session.input.cancel"]);
    expect(closeSettled).toBe(false);
    idleReceipt.resolve(Response.json(createHostedSession("idle")));

    await closing;
    await expect(run).rejects.toBe(interruption);
  });

  it("admits no native work when cancellation precedes the queued message POST", async () => {
    const session = createSession();
    const queued = session.queueMessage("Fixture prompt");
    controller.abort(new Error("Host interruption"));

    await expect(queued).rejects.toThrow("Agents API turn settled before input was submitted");
    await session.close();
    expect(session.wasSubmitted()).toBe(false);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});

function runSession(session: ReturnType<typeof createSession>, prompt = "Fixture prompt") {
  return session.run(
    prompt,
    async () => {},
    () => submitted.resolve(),
  );
}

function startSession(session = createSession(), prompt = "Fixture prompt") {
  const result = runSession(session, prompt);
  void result.catch(() => {});
  return { session, result };
}

function completeSavedState() {
  savedSession = { ...savedSession, status: "idle" };
  savedTurns = [createTurn()];
  savedItems = [createSavedMessage("input-fixture", "user", "Fixture prompt")];
}

async function abortSession(session: ReturnType<typeof createSession>, result: Promise<unknown>) {
  savedSession = { ...savedSession, status: "idle" };
  controller.abort();
  await result.catch(() => {});
  await session.close();
}

function createSession(
  lifecycle: Omit<
    Parameters<typeof createAgentsApiSession>[0],
    "client" | "cleanupClient" | "sessionId" | "signal" | "assertCurrent" | "onEvent"
  > = {},
  onEvent = (event: AgentsApiEvent) => stream.observe(event),
) {
  return createAgentsApiSession({
    client: new AgentsApiClient("fixture-not-a-real-api-key", () => {}),
    cleanupClient: new AgentsApiClient("fixture-not-a-real-api-key", () => {}),
    sessionId: "session-fixture",
    signal: controller.signal,
    assertCurrent: () => {},
    onEvent,
    ...lifecycle,
  });
}

function savedStateResponse(url: string) {
  const parsed = new URL(url);
  switch (parsed.pathname) {
    case "/v1/agents/sessions/session-fixture/turns": {
      let page = parsed.searchParams.get("order") === "desc" ? savedTurns.toReversed() : savedTurns;
      const after = parsed.searchParams.get("after");
      if (after) {
        page = page.slice(page.findIndex((turn) => turn.id === after) + 1);
      }
      const limit = Number(parsed.searchParams.get("limit"));
      return Response.json({ data: limit > 0 ? page.slice(0, limit) : page, has_more: false });
    }
    case "/v1/agents/sessions/session-fixture/items":
      return Response.json({ data: savedItems, has_more: false });
    case "/v1/agents/sessions/session-fixture":
      return Response.json(savedSession);
    default:
      throw new Error(`Unexpected native session request: ${url}`);
  }
}

function createInput(id: string, turn_id: string) {
  return { ...createSavedMessage(id, "user", ""), turn_id };
}

function createSavedMessage(id: string, role: "user" | "assistant", text: string): AgentsApiItem {
  return {
    id,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    phase: role === "user" ? null : "final_answer",
    role,
    status: "completed",
    turn_id: "turn-fixture",
    type: "message",
  } satisfies AgentSessionMessage;
}

function createEventStream() {
  const encoder = new TextEncoder();
  const waiters = new Map<string, Array<() => void>>();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let detachAbort = () => {};
  let subscription: ReturnType<typeof deferred<void>> | undefined;
  return {
    nextSubscription() {
      subscription = deferred<void>();
      return subscription.promise;
    },
    disconnect() {
      detachAbort();
      streamController?.close();
    },
    response(signal?: AbortSignal) {
      const body = new ReadableStream<Uint8Array>({
        start(readerController) {
          streamController = readerController;
          subscription?.resolve();
          const abort = () => readerController.error(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          detachAbort = () => signal?.removeEventListener("abort", abort);
        },
        cancel() {
          detachAbort();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
    send(event: { type: string; [key: string]: unknown }) {
      const observed = deferred<void>();
      const callbacks = waiters.get(event.type) ?? [];
      callbacks.push(() => observed.resolve());
      waiters.set(event.type, callbacks);
      if (!streamController) {
        throw new Error("Expected an open native event stream");
      }
      streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      return observed.promise;
    },
    observe(event: AgentsApiEvent) {
      waiters.get(event.type)?.shift()?.();
    },
  };
}

type AgentEvent = Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0];

it.each(["added", "done"])("projects commentary discovered at %s once", async (knownAt) => {
  const { projection, events } = createProjection();
  const item: AgentsApiItem = {
    ...createSavedMessage("commentary-fixture", "assistant", ""),
    phase: knownAt === "added" ? "commentary" : null,
    status: "in_progress",
  };
  const text = "Checking the command.\n\n    pwd";

  await projection.observe({ type: "agent.session.turn.item.added", item });
  await projection.observe({
    type: "agent.session.turn.output_text.delta",
    item_id: item.id,
    turn_id: "turn-fixture",
    content_index: 0,
    delta: text,
  });
  const completed = {
    type: "agent.session.turn.item.done",
    item: {
      ...item,
      phase: "commentary",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  } satisfies AgentsApiEvent;
  await projection.observe(completed);
  await projection.observe(completed);

  const itemId = "agentsapi:session-fixture:turn-fixture:commentary-fixture";
  const preamble = {
    itemId,
    kind: "preamble",
    title: "Preamble",
    progressText: text,
    source: "agentsapi",
  };
  const itemEvent = (phase: string) => ({ stream: "item", data: { ...preamble, phase } });
  const assistant = (outputText: string, id = itemId) => ({
    stream: "assistant",
    data: { itemId: id, text: outputText, delta: "", replace: true, replaceable: true },
  });
  expect(events).toEqual([
    ...(knownAt === "added"
      ? [itemEvent("update")]
      : [
          assistant(text),
          { stream: "assistant", data: { itemId, text: "", delta: "", replace: true } },
        ]),
    itemEvent("end"),
  ]);

  await projection.observe({
    ...completed,
    item: {
      ...completed.item,
      id: "final-fixture",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Done." }],
    },
  });
  expect(events.at(-1)).toEqual(
    assistant("Done.", "agentsapi:session-fixture:turn-fixture:final-fixture"),
  );
});
it("replaces matching canonical usage while retaining omitted turns without counting them twice", async () => {
  const { projection } = createProjection();
  for (const [id, usage] of [
    ["turn-a", makeUsage(100, 20, 5, 1)],
    ["turn-b", makeUsage(50, 10, 3, 2)],
  ] as const) {
    await projection.observe({
      type: "agent.session.turn.completed",
      turn: { id, subagent_id: null, usage },
    });
  }
  const canonicalTurn = createTurn({ id: "turn-a", usage: makeUsage(120, 30, 6, 2) });

  const totals = { input: 130, output: 9, cacheRead: 40 };
  for (let pass = 0; pass < 2; pass++) {
    projection.recordUsage(usageModel, [canonicalTurn, canonicalTurn]);
    expect(projection.tokenUsage).toMatchObject({
      ...totals,
      reasoningTokens: 4,
      total: 179,
      contextUsage: { state: "unavailable" },
    });
    expect(projection.reply.assistantUsage).toMatchObject({ ...totals, totalTokens: 179 });
  }
});

function createProjection() {
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => void events.push(event);
  const params = createAttemptParams();
  const projection = new AgentsApiMessageProjection(params, "session-fixture", emit, () => {});
  return { projection, events };
}

const usageModel = createModel({ id: "model-fixture", reasoning: true });

function makeUsage(input: number, cached: number, output: number, reasoning: number) {
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}
