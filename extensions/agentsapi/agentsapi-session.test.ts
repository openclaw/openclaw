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
    fetchWithSsrFGuardMock.mockImplementation(async (request) => {
      request.beforeRequest?.();
      if (request.init?.method === "POST") {
        return guardedResponse(request.url, Response.json({}));
      }
      if (new URL(request.url).pathname.endsWith("/events")) {
        return guardedResponse(request.url, stream.response(request.signal));
      }
      return guardedResponse(
        request.url,
        Response.json({ data: [], has_more: false, last_id: null }),
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

    await stream.send({
      type: "agent.session.turn.created",
      turn: { id: "turn-fixture", subagent_id: null },
    });
    await stream.send({
      type: "agent.session.turn.completed",
      turn: { id: "turn-fixture", subagent_id: null },
    });
    expect(session.isSettled()).toBe(false);

    await stream.send({ type: "agent.session.idle" });
    await stream.send({
      type: "agent.session.turn.output_text.done",
      item_id: "assistant-fixture",
      content_index: 0,
      text: "Fixture reply",
    });
    expect(session.isSettled()).toBe(false);

    await stream.send({
      type: "agent.session.turn.item.done",
      item: { id: "input-fixture", type: "message", role: "user", turn_id: "turn-fixture" },
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
      if (request.url.includes("/turns?")) {
        return guardedResponse(
          request.url,
          Response.json({ data: [], has_more: false, last_id: null }),
        );
      }
      if (new URL(request.url).pathname.endsWith("/events")) {
        return guardedResponse(request.url, stream.response(request.signal));
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
    let cancellationSettled = false;
    const cancellation = session.cancel().then(() => {
      cancellationSettled = true;
    });

    expect(messageSignal?.aborted).toBe(false);
    expect(inputTypes).toEqual(["agent.session.input.message"]);
    expect(cancellationSettled).toBe(false);

    messageAcknowledgement.resolve(Response.json({}));
    await expect(queuedSteer).rejects.toThrow("Agents API turn settled before input was submitted");
    await idleRequested.promise;
    expect(inputTypes).toEqual(["agent.session.input.message", "agent.session.input.cancel"]);
    expect(cancellationSettled).toBe(false);
    idleReceipt.resolve(Response.json({ id: "session-fixture", status: "idle", error: null }));

    await cancellation;
    await expect(run).rejects.toBe(interruption);
    await session.close();
  });

  it("admits no native work when cancellation precedes the queued message POST", async () => {
    const controller = new AbortController();
    const session = createSession(controller.signal, () => {});
    const queued = session.queueMessage("Fixture prompt");
    controller.abort(new Error("Host interruption"));

    await expect(queued).rejects.toThrow("Agents API turn settled before input was submitted");
    await session.cancel();
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
