import type { AgentSession, AgentSessionMessage } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentsApiClient, type AgentsApiEvent } from "./agentsapi-client.js";
import { createAgentsApiSession } from "./agentsapi-session.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

describe("Agents API native session receipts", () => {
  it("waits for session idle and the admitted input receipt after the root turn completes", async () => {
    const controller = new AbortController();
    const stream = createEventStream();
    let savedTurns: Turn[] = [];
    let savedItems: AgentSessionMessage[] = [];
    let savedSession = createSavedSession("in_progress");
    fetchWithSsrFGuardMock.mockImplementation(async (request) => {
      request.beforeRequest?.();
      if (request.init?.method === "POST") {
        return guardedResponse(request.url, Response.json({}));
      }
      if (new Headers(request.init?.headers).get("accept") === "text/event-stream") {
        return guardedResponse(request.url, stream.response(request.signal));
      }
      return guardedResponse(
        request.url,
        savedStateResponse(request.url, savedTurns, savedItems, savedSession),
      );
    });
    const session = createSession(controller.signal, (event) => stream.observe(event));
    const submitted = deferred<void>();
    const result = session.run(
      "Fixture prompt",
      async () => {},
      () => submitted.resolve(),
    );
    await submitted.promise;

    const createdTurn = createSavedTurn("in_progress");
    savedTurns = [createdTurn];
    await stream.send({
      type: "agent.session.turn.created",
      turn: createdTurn,
    });
    const completedTurn = createSavedTurn("completed");
    savedTurns = [completedTurn];
    await stream.send({
      type: "agent.session.turn.completed",
      turn: completedTurn,
    });
    // Observing the next event fences the completed turn's saved-state reconciliation.
    await stream.send({ type: "agent.session.in_progress" });
    expect(session.isSettled()).toBe(false);

    savedSession = createSavedSession("idle");
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
    await stream.send({
      type: "agent.session.turn.item.done",
      item: inputReceipt,
    });
    expect(session.isSettled()).toBe(false);
    await stream.send({ type: "agent.session.idle" });

    await expect(result).resolves.toMatchObject({ turn: { id: "turn-fixture" }, cancelled: false });
    expect(session.isSettled()).toBe(true);
    await session.close();
  });

  it("preserves a pending message acknowledgement before cancellation and waits for native idle", async () => {
    const controller = new AbortController();
    const stream = createEventStream();
    const messageRequested = deferred<void>();
    const messageAcknowledgement = deferred<Response>();
    const idleRequested = deferred<void>();
    const idleReceipt = deferred<Response>();
    const inputTypes: string[] = [];
    let messageSignal: AbortSignal | undefined;
    fetchWithSsrFGuardMock.mockImplementation(async (request) => {
      request.beforeRequest?.();
      if (request.init?.method === "POST") {
        const payload = z
          .object({ events: z.array(z.object({ type: z.string() })) })
          .parse(await new Request(request.url, request.init).json());
        const inputType = payload.events[0]?.type;
        if (!inputType) {
          throw new Error("Expected a native input event");
        }
        inputTypes.push(inputType);
        if (inputType === "agent.session.input.message") {
          messageSignal = request.signal;
          messageRequested.resolve();
          return guardedResponse(request.url, await messageAcknowledgement.promise);
        }
        return guardedResponse(request.url, Response.json({}));
      }
      if (new Headers(request.init?.headers).get("accept") === "text/event-stream") {
        return guardedResponse(request.url, stream.response(request.signal));
      }
      if (new URL(request.url).pathname !== "/v1/agents/sessions/session-fixture") {
        return guardedResponse(
          request.url,
          savedStateResponse(request.url, [], [], createSavedSession("in_progress")),
        );
      }
      if (!inputTypes.includes("agent.session.input.cancel")) {
        throw new Error("Expected native cancellation before the idle request");
      }
      idleRequested.resolve();
      return guardedResponse(request.url, await idleReceipt.promise);
    });
    const session = createSession(controller.signal, (event) => stream.observe(event));
    const run = session.run(
      "Fixture prompt",
      async () => {},
      () => {},
    );
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
    idleReceipt.resolve(Response.json(createSavedSession("idle")));

    await closing;
    await expect(run).rejects.toBe(interruption);
  });

  it("admits no native work when cancellation precedes the queued message POST", async () => {
    const controller = new AbortController();
    const session = createSession(controller.signal, () => {});
    const queued = session.queueMessage("Fixture prompt");
    controller.abort(new Error("Host interruption"));

    await expect(queued).rejects.toThrow("Agents API turn settled before input was submitted");
    await session.close();
    expect(session.wasSubmitted()).toBe(false);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});

function createSession(signal: AbortSignal, onEvent: (event: AgentsApiEvent) => void) {
  return createAgentsApiSession({
    client: new AgentsApiClient("fixture-not-a-real-api-key", () => {}),
    cleanupClient: new AgentsApiClient("fixture-not-a-real-api-key", () => {}),
    sessionId: "session-fixture",
    signal,
    assertCurrent: () => {},
    onEvent,
  });
}

function savedStateResponse(
  url: string,
  turns: Turn[],
  items: AgentSessionMessage[],
  session: AgentSession,
) {
  switch (new URL(url).pathname) {
    case "/v1/agents/sessions/session-fixture/turns":
      return Response.json({ data: turns, has_more: false });
    case "/v1/agents/sessions/session-fixture/items":
      return Response.json({ data: items, has_more: false });
    case "/v1/agents/sessions/session-fixture":
      return Response.json(session);
    default:
      throw new Error(`Unexpected native session request: ${url}`);
  }
}

function createSavedTurn(status: "in_progress" | "completed"): Turn {
  return {
    id: "turn-fixture",
    agent_id: "agent-fixture",
    completed_at: status === "completed" ? 2 : null,
    created_at: 1,
    error: null,
    object: "agent.session.turn",
    session_id: "session-fixture",
    started_at: 1,
    status,
    subagent_id: null,
    usage: null,
  };
}

function createSavedMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
): AgentSessionMessage {
  return {
    id,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    phase: role === "user" ? null : "final_answer",
    role,
    status: "completed",
    turn_id: "turn-fixture",
    type: "message",
  };
}

function createSavedSession(status: AgentSession["status"]): AgentSession {
  return {
    id: "session-fixture",
    agent: {
      id: "agent-fixture",
      instructions: "Fixture instructions",
      model: "fixture-model",
      multi_agent: { enabled: false, max_concurrent_subagents: null },
      name: null,
      reasoning: { effort: null, summary: null },
      service_tier: "auto",
      text: { format: { type: "text" }, verbosity: "medium" },
      tools: [],
    },
    created_at: 1,
    environment: {
      id: "environment-fixture",
      capability_directories: [],
      files: [],
      network: { access: "disabled", allowed_domains: [] },
      packages: { npm: [], python: [], system: [] },
      plugins: [],
      skills: [],
      type: "openai_hosted",
    },
    error: null,
    last_active_at: 2,
    metadata: {},
    object: "agent.session",
    required_actions: [],
    status,
    usage: null,
    vault_ids: [],
  };
}

function guardedResponse(url: string, response: Response) {
  return { response, finalUrl: url, release: async () => {} };
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
  return {
    response(signal?: AbortSignal) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          const abort = () => controller.error(signal?.reason);
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
