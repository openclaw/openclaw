import type { AgentSession, AgentSessionMessage } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentsApiClient, type AgentsApiEvent, type AgentsApiItem } from "./agentsapi-client.js";
import { createAgentsApiSession } from "./agentsapi-session.js";
import { createHostedSession, createTurn } from "./agentsapi.test-support.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));
const connectionAction = {
  type: "environment_connection",
  environment_id: "environment-fixture",
} as const;
const selfHostedEnvironment: AgentSession["environment"] = {
  type: "self_hosted",
  id: "environment-fixture",
  workspace_directory: "/fixture/workspace",
  remote_url: "wss://executor.invalid/session-fixture",
  capability_directories: [],
};

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
let post: (type: string, request: GuardedRequest, body: unknown) => Response | Promise<Response>;
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
      response = await post(events[0]!.type, request, body);
    } else if (new Headers(request.init?.headers).get("accept") === "text/event-stream") {
      response = stream.response(request.signal);
    } else {
      response = await read(request.url);
    }
    return { response, finalUrl: request.url, release: async () => {} };
  });
});

describe("Agents API native session receipts", () => {
  it.each(["idle", "disconnect"] as const)(
    "reconciles late terminal records after %s without another native event or input",
    async (boundary) => {
      const refresh = deferred<void>();
      const waitForRecovery = vi.fn(async (ms: number) => {
        if (ms === 1_000) {
          await refresh.promise;
        }
      });
      const session = createSession({ waitForRecovery });
      const result = runSession(session);
      void result.catch(() => {});
      try {
        await submitted.promise;
        await stream.send({ type: "agent.session.in_progress" });
        expect(waitForRecovery).not.toHaveBeenCalled();
        if (boundary === "idle") {
          await stream.send({ type: "agent.session.idle" });
        } else {
          const reconnected = stream.nextSubscription();
          stream.disconnect();
          await reconnected;
        }
        // A later consumed event fences the preceding saved-state read. It is
        // not a terminal signal and cannot repair late REST records on its own.
        await stream.send({ type: "fixture.recovery_barrier" });
        expect(waitForRecovery).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
        expect(session.isSettled()).toBe(false);
        savedSession = createHostedSession("idle");
        savedTurns = [createTurn()];
        savedItems = [createSavedMessage("input-fixture", "user", "Fixture prompt")];
        refresh.resolve();
        await expect(result).resolves.toMatchObject({ turn: { id: "turn-fixture" } });
        expect(inputTypes).toEqual(["agent.session.input.message"]);
      } finally {
        savedSession = createHostedSession("idle");
        controller.abort();
        refresh.resolve();
        await result.catch(() => {});
        await session.close();
      }
    },
  );
  it("waits for session idle and the admitted input receipt after the root turn completes", async () => {
    const session = createSession();
    const result = runSession(session);
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
      const historicalInput = {
        ...createSavedMessage("input-history", "user", "Historical request"),
        turn_id: historicalTurn.id,
      };
      const priorInput = {
        ...createSavedMessage("input-prior", "user", "Original request"),
        turn_id: priorTurn.id,
      };
      const priorCommand: AgentsApiItem = {
        id: "command-prior",
        type: "command_execution",
        turn_id: priorTurn.id,
        command: "fixture-worker",
        status: "in_progress",
      };
      const continuationInput = {
        ...createSavedMessage("input-continuation", "user", "Continue existing work"),
        turn_id: currentTurn.id,
      };
      savedTurns = [historicalTurn, priorTurn];
      savedItems = [historicalInput, priorInput, priorCommand];
      const postedBodies: unknown[] = [];
      post = (_type, _request, body) => {
        postedBodies.push(body);
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
      const session = createSession({ onReconcile, onReconcileHistory }, (event) => {
        observedEvents.push(event);
        stream.observe(event);
      });
      const result = runSession(session, "Continue existing work");
      void result.catch(() => {});
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
        expect(postedBodies).toEqual([
          {
            events: [
              {
                type: "agent.session.input.message",
                input: [
                  {
                    role: "user",
                    content: [{ type: "input_text", text: "Continue existing work" }],
                  },
                ],
              },
            ],
          },
        ]);
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
        controller.abort();
        await result.catch(() => {});
        await session.close();
      }
    },
  );

  it("continues when an external executor satisfies its connection action", async () => {
    savedSession.environment = selfHostedEnvironment;
    const session = createSession();
    const result = runSession(session);
    await submitted.promise;
    requireActions([connectionAction]);
    await stream.send({ type: "agent.session.requires_action" });
    savedSession = { ...savedSession, status: "idle", required_actions: [] };
    savedTurns = [createTurn()];
    savedItems = [createSavedMessage("input-fixture", "user", "Fixture prompt")];
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
      const session = createSession();
      const result = runSession(session);
      void result.catch(() => {});
      await submitted.promise;
      if (failed) {
        savedSession = { ...savedSession, status: "failed", error: "Fixture terminal failure" };
      }
      await stream.send({ type: "agent.session.failed" });
      if (failed) {
        await expect(result).rejects.toThrow("Fixture terminal failure");
      } else {
        await stream.send({ type: "agent.session.in_progress" });
        savedSession = createHostedSession("idle");
        savedTurns = [createTurn()];
        savedItems = [createSavedMessage("input-fixture", "user", "Fixture prompt")];
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
    const session = createSession();
    const run = runSession(session);
    void run.catch(() => {});
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

function requireActions(required_actions: AgentSession["required_actions"]) {
  savedSession = { ...savedSession, status: "requires_action", required_actions };
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
