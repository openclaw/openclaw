import type { AgentSession, AgentSessionMessage } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentsApiClient, type AgentsApiEvent, type AgentsApiItem } from "./agentsapi-client.js";
import { createAgentsApiSession } from "./agentsapi-session.js";
import { createHostedSession, createTurn } from "./agentsapi.test-support.js";

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
    let savedItems: AgentsApiItem[] = [];
    let savedSession = createHostedSession("in_progress");
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

    const createdTurn = createTurn({ status: "in_progress", completed_at: null });
    savedTurns = [createdTurn];
    await stream.send({
      type: "agent.session.turn.created",
      turn: createdTurn,
    });
    const completedTurn = createTurn();
    savedTurns = [completedTurn];
    await stream.send({
      type: "agent.session.turn.completed",
      turn: completedTurn,
    });
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

  it.each([false, true])(
    "connects while the original input acknowledgement is pending (existing action: %s)",
    async (existingAction) => {
      const controller = new AbortController();
      const stream = createEventStream();
      const messageRequested = deferred<void>();
      const messageAcknowledgement = deferred<Response>();
      const submitted = deferred<void>();
      const connected = deferred<void>();
      const initialConnectionStateRead = deferred<void>();
      let savedSession: AgentSession = {
        ...createHostedSession(existingAction ? "requires_action" : "in_progress"),
        environment: {
          type: "self_hosted" as const,
          id: "environment-fixture",
          workspace_directory: "/fixture/workspace",
          remote_url: "wss://executor.invalid/session-fixture",
          capability_directories: [],
        },
        required_actions: existingAction
          ? [{ type: "environment_connection", environment_id: "environment-fixture" }]
          : [],
      };
      let savedTurns: Turn[] = [];
      let savedItems: AgentsApiItem[] = [];
      const inputTypes: string[] = [];
      fetchWithSsrFGuardMock.mockImplementation(async (request) => {
        request.beforeRequest?.();
        if (request.init?.method === "POST") {
          const payload = z
            .object({ events: z.array(z.object({ type: z.string() })) })
            .parse(await new Request(request.url, request.init).json());
          inputTypes.push(payload.events[0]!.type);
          messageRequested.resolve();
          return guardedResponse(request.url, await messageAcknowledgement.promise);
        }
        if (new Headers(request.init?.headers).get("accept") === "text/event-stream") {
          return guardedResponse(request.url, stream.response(request.signal));
        }
        const response = savedStateResponse(request.url, savedTurns, savedItems, savedSession);
        if (new URL(request.url).pathname === "/v1/agents/sessions/session-fixture") {
          initialConnectionStateRead.resolve();
        }
        return guardedResponse(request.url, response);
      });
      const connectEnvironment = vi.fn(async (environmentId: string) => {
        expect(environmentId).toBe("environment-fixture");
        expect(inputTypes).toEqual(["agent.session.input.message"]);
        savedSession = { ...savedSession, status: "in_progress", required_actions: [] };
        connected.resolve();
      });
      const session = createSession(controller.signal, (event) => stream.observe(event), {
        connectEnvironment,
      });
      const result = session.run(
        "Fixture prompt",
        async () => {},
        () => submitted.resolve(),
      );
      await messageRequested.promise;
      let connectionEvent: Promise<void> | undefined;
      if (!existingAction) {
        await initialConnectionStateRead.promise;
        savedSession = {
          ...savedSession,
          status: "requires_action",
          required_actions: [
            { type: "environment_connection", environment_id: "environment-fixture" },
          ],
        };
        connectionEvent = stream.send({ type: "agent.session.requires_action" });
      }
      await connected.promise;
      messageAcknowledgement.resolve(Response.json({}));
      await submitted.promise;
      await connectionEvent;
      // Replayed stream notifications do not become new startup requests after
      // the authoritative required action has been resolved.
      await stream.send({ type: "agent.session.requires_action" });
      savedSession = { ...savedSession, status: "idle" };
      savedTurns = [createTurn()];
      savedItems = [createSavedMessage("input-fixture", "user", "Fixture prompt")];
      await stream.send({ type: "agent.session.idle" });
      await expect(result).resolves.toMatchObject({ turn: { id: "turn-fixture" } });
      expect(connectEnvironment).toHaveBeenCalledTimes(1);
      expect(inputTypes).toEqual(["agent.session.input.message"]);
      await session.close();
    },
  );

  it("services a connection action while acknowledging a Gateway function result", async () => {
    const controller = new AbortController();
    const stream = createEventStream();
    const submitted = deferred<void>();
    const resultRequested = deferred<void>();
    const resultAcknowledgement = deferred<Response>();
    const resultRecorded = deferred<void>();
    const connected = deferred<void>();
    let savedSession: AgentSession = {
      ...createHostedSession("in_progress"),
      environment: {
        type: "self_hosted",
        id: "environment-fixture",
        workspace_directory: "/fixture/workspace",
        remote_url: "wss://executor.invalid/session-fixture",
        capability_directories: [],
      },
    };
    let savedTurns: Turn[] = [];
    const savedItems: AgentsApiItem[] = [
      createSavedMessage("input-fixture", "user", "Fixture prompt"),
      {
        id: "function-fixture",
        type: "function_call",
        turn_id: "turn-fixture",
        call_id: "call-fixture",
        name: "fixture_tool",
        arguments: "{}",
      },
    ];
    const inputTypes: string[] = [];
    fetchWithSsrFGuardMock.mockImplementation(async (request) => {
      request.beforeRequest?.();
      if (request.init?.method === "POST") {
        const payload = z
          .object({ events: z.array(z.object({ type: z.string() })) })
          .parse(await new Request(request.url, request.init).json());
        const type = payload.events[0]!.type;
        inputTypes.push(type);
        if (type === "agent.session.input.tool_result") {
          savedSession = {
            ...savedSession,
            status: "requires_action",
            required_actions: [
              { type: "environment_connection", environment_id: "environment-fixture" },
            ],
          };
          resultRequested.resolve();
          return guardedResponse(request.url, await resultAcknowledgement.promise);
        }
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
    const executeFunction = vi.fn(async () => ({
      success: true as const,
      output: "Fixture result",
    }));
    const connectEnvironment = vi.fn(async () => {
      savedSession = { ...savedSession, status: "in_progress", required_actions: [] };
      connected.resolve();
    });
    const session = createSession(controller.signal, (event) => stream.observe(event), {
      executeFunction,
      connectEnvironment,
      onFunctionResult: () => resultRecorded.resolve(),
    });
    const result = session.run(
      "Fixture prompt",
      async () => {},
      () => submitted.resolve(),
    );
    await submitted.promise;
    savedTurns = [createTurn({ status: "in_progress", completed_at: null })];
    savedSession = {
      ...savedSession,
      status: "requires_action",
      required_actions: [
        {
          type: "function_call",
          turn_id: "turn-fixture",
          call_id: "call-fixture",
          name: "fixture_tool",
          arguments: "{}",
        },
      ],
    };
    await stream.send({ type: "agent.session.requires_action" });
    await resultRequested.promise;
    const connectionEvent = stream.send({ type: "agent.session.requires_action" });
    await connected.promise;
    resultAcknowledgement.resolve(Response.json({}));
    await resultRecorded.promise;
    await connectionEvent;
    savedSession = { ...savedSession, status: "idle" };
    savedTurns = [createTurn()];
    await stream.send({ type: "agent.session.idle" });
    await expect(result).resolves.toMatchObject({ turn: { id: "turn-fixture" } });
    expect(executeFunction).toHaveBeenCalledTimes(1);
    expect(connectEnvironment).toHaveBeenCalledTimes(1);
    expect(inputTypes).toEqual(["agent.session.input.message", "agent.session.input.tool_result"]);
    await session.close();
  });

  it("surfaces a rejected input without waiting for another stream event or resubmitting it", async () => {
    const controller = new AbortController();
    const stream = createEventStream();
    const inputTypes: string[] = [];
    fetchWithSsrFGuardMock.mockImplementation(async (request) => {
      request.beforeRequest?.();
      if (request.init?.method === "POST") {
        const payload = z
          .object({ events: z.array(z.object({ type: z.string() })) })
          .parse(await new Request(request.url, request.init).json());
        const type = payload.events[0]!.type;
        inputTypes.push(type);
        return guardedResponse(
          request.url,
          type === "agent.session.input.message"
            ? Response.json(
                { error: { message: "Fixture input rejected", type: "invalid_request_error" } },
                { status: 400 },
              )
            : Response.json({}),
        );
      }
      if (new Headers(request.init?.headers).get("accept") === "text/event-stream") {
        return guardedResponse(request.url, stream.response(request.signal));
      }
      return guardedResponse(
        request.url,
        savedStateResponse(request.url, [], [], createHostedSession("idle")),
      );
    });
    const session = createSession(controller.signal, (event) => stream.observe(event));
    await expect(
      session.run(
        "Fixture prompt",
        async () => {},
        () => {},
      ),
    ).rejects.toThrow("Fixture input rejected");
    await expect(session.close()).rejects.toThrow("Fixture input rejected");
    expect(inputTypes).toEqual(["agent.session.input.message", "agent.session.input.cancel"]);
  });

  it.each([false, true])("retires only a currently failed session (failed: %s)", async (failed) => {
    const controller = new AbortController();
    const stream = createEventStream();
    const submitted = deferred<void>();
    let savedTurns: Turn[] = [];
    let savedItems: AgentsApiItem[] = [];
    let savedSession = createHostedSession("in_progress");
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
    const onSessionFailed = vi.fn(async () => {});
    const session = createSession(controller.signal, (event) => stream.observe(event), {
      onSessionFailed,
    });
    const result = session.run(
      "Fixture prompt",
      async () => {},
      () => submitted.resolve(),
    );
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
    expect(onSessionFailed).toHaveBeenCalledTimes(failed ? 1 : 0);
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
          savedStateResponse(request.url, [], [], createHostedSession("in_progress")),
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
    idleReceipt.resolve(Response.json(createHostedSession("idle")));

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

function createSession(
  signal: AbortSignal,
  onEvent: (event: AgentsApiEvent) => void,
  lifecycle: Pick<
    Parameters<typeof createAgentsApiSession>[0],
    "connectEnvironment" | "onSessionFailed" | "executeFunction" | "onFunctionResult"
  > = {},
) {
  return createAgentsApiSession({
    client: new AgentsApiClient("fixture-not-a-real-api-key", () => {}),
    cleanupClient: new AgentsApiClient("fixture-not-a-real-api-key", () => {}),
    sessionId: "session-fixture",
    signal,
    assertCurrent: () => {},
    onEvent,
    ...lifecycle,
  });
}

function savedStateResponse(
  url: string,
  turns: Turn[],
  items: AgentsApiItem[],
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
