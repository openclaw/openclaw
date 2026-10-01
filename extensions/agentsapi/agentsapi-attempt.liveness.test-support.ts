import path from "node:path";
import type { AgentSessionMessage } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { vi, type Mock } from "vitest";
import { z } from "zod";
import { runAgentsApiAttempt } from "./agentsapi-attempt.js";
import type { AgentsApiEvent, AgentsApiFunctionCall } from "./agentsapi-client.js";

type SavedResource = "turns" | "items" | "session";
type ReadFailure = { resource: SavedResource; status: number };

export async function createAttemptFixture(options: {
  workspaceDir: string;
  fetch: Mock<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>;
  cleanups: Array<() => Promise<void>>;
}) {
  const { workspaceDir, fetch: fetchWithSsrFGuardMock, cleanups } = options;
  const target = {
    agentId: "main",
    sessionId: "liveness-fixture",
    sessionKey: "agent:main:liveness-fixture",
    storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  // SQLite workers keep real event-loop turns while the native reconciliation clock advances.
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout"],
    shouldClearNativeTimers: true,
  });
  const controller = new AbortController();
  let revocation: Error | undefined;
  const assertCurrent = () => {
    if (revocation) {
      throw revocation;
    }
  };
  const initialTurn: Turn = { ...completedTurn, status: "in_progress", completed_at: null };
  const requiredActions: AgentsApiFunctionCall[] = [];
  const saved = {
    turns: [initialTurn],
    items: [message("input-fixture", "user", "Fixture prompt")],
    session: {
      id: "session-fixture",
      status: "in_progress",
      error: null,
      environment: { id: "environment-fixture", type: "openai_hosted" },
      required_actions: requiredActions,
    },
    beforeItems: undefined as (() => void) | undefined,
  };
  const stream = createEventStream();
  const submitted = deferred<void>();
  const inputEvents: string[] = [];
  const pendingReadFailures: ReadFailure[] = [];
  const failedReads: ReadFailure[] = [];
  let sessionRead: ReturnType<typeof deferred<void>> | undefined;
  let delayedSessionRead: ReturnType<typeof createDelayedRead> | undefined;
  fetchWithSsrFGuardMock.mockImplementation(async (request) => {
    request.beforeRequest?.();
    const pathname = new URL(request.url).pathname;
    const failedRead = pendingReadFailures[0];
    const failurePath =
      failedRead?.resource === "session"
        ? "/v1/agents/sessions/session-fixture"
        : `/v1/agents/sessions/session-fixture/${failedRead?.resource}`;
    let response: Response;
    if (failedRead && request.init?.method === "GET" && pathname === failurePath) {
      pendingReadFailures.shift();
      failedReads.push(failedRead);
      response = Response.json(
        { error: { message: `Fixture ${failedRead.resource} read failed (${failedRead.status})` } },
        { status: failedRead.status },
      );
    } else if (request.init?.method === "POST" && pathname === "/v1/agents/sessions") {
      response = Response.json(saved.session);
    } else if (request.init?.method === "POST" && pathname.endsWith("/events")) {
      const payload = z
        .object({ events: z.array(z.object({ type: z.string() })) })
        .parse(await new Request(request.url, request.init).json());
      inputEvents.push(...payload.events.map((event) => event.type));
      if (payload.events.some((event) => event.type === "agent.session.input.cancel")) {
        saved.session.status = "idle";
      }
      response = Response.json({});
      submitted.resolve();
    } else if (new Headers(request.init?.headers).get("accept") === "text/event-stream") {
      response = stream.response(request.signal);
    } else if (pathname.endsWith("/turns")) {
      response = Response.json({ data: inputEvents.length ? saved.turns : [], has_more: false });
    } else if (pathname === "/v1/agents/sessions/session-fixture/turns/turn-fixture") {
      response = Response.json(saved.turns[0]);
    } else if (pathname.endsWith("/items")) {
      saved.beforeItems?.();
      response = Response.json({ data: saved.items, has_more: false });
    } else if (pathname.endsWith("/artifacts")) {
      response = Response.json({ data: [], has_more: false });
    } else if (pathname === "/v1/agents/sessions/session-fixture") {
      response = Response.json(saved.session);
      sessionRead?.resolve();
      sessionRead = undefined;
      const delayedRead = delayedSessionRead;
      delayedSessionRead = undefined;
      if (delayedRead) {
        await delayedRead.wait(request.signal);
      }
    } else {
      throw new Error(`Unexpected fixture request: ${request.init?.method} ${pathname}`);
    }
    return { response, finalUrl: request.url, release: async () => {} };
  });
  const onPartialReply = vi.fn<NonNullable<AgentHarnessAttemptParamsV2["onPartialReply"]>>();
  const onAgentEvent = vi.fn<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>();
  const onRunProgress = vi.fn<NonNullable<AgentHarnessAttemptParamsV2["onRunProgress"]>>((event) =>
    stream.observe(event.reason),
  );
  const authStorage = AuthStorage.inMemory();
  const params: AgentHarnessAttemptParamsV2 = {
    ...target,
    sessionTarget: target,
    sessionFile: path.join(workspaceDir, "session.jsonl"),
    workspaceDir,
    agentDir: workspaceDir,
    config: {},
    runId: "run-fixture",
    prompt: "Fixture prompt",
    timeoutMs: 5_000,
    abortSignal: controller.signal,
    provider: "openai",
    modelId: "fixture-model",
    model: {
      id: "fixture-model",
      name: "Fixture Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 512,
    },
    resolvedApiKey: "fixture-not-a-real-api-key",
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    authProfileStore: { version: 1, profiles: {} },
    thinkLevel: "off",
    disableTools: true,
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: assertCurrent,
      createToolSurface: () => [],
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
    onPartialReply,
    onAgentEvent,
    onRunProgress,
  };
  return {
    saved,
    stream,
    controller,
    inputEvents,
    failedReads,
    onPartialReply,
    onAgentEvent,
    onRunProgress,
    failNextRead: (resource: SavedResource, status: number) => {
      pendingReadFailures.push({ resource, status });
    },
    revoke: (error: Error) => {
      revocation = error;
    },
    complete: () => {
      saved.turns = [completedTurn];
      saved.session.status = "idle";
      saved.session.required_actions = [];
      saved.items = [
        message("input-fixture", "user", "Fixture prompt"),
        message("answer-fixture", "assistant", "The completed answer."),
      ];
    },
    nextSessionRead: () => {
      sessionRead = deferred<void>();
      return sessionRead.promise;
    },
    delayNextSessionRead: () => {
      delayedSessionRead = createDelayedRead();
      return delayedSessionRead;
    },
    transcript: () => SessionManager.open(target, workspaceDir).buildSessionContext().messages,
    start: async () => {
      let completed = false;
      const result = runAgentsApiAttempt(
        params,
        undefined,
        async () => {},
        assertCurrent,
        () => {},
        target,
        () => ({}),
      ).finally(() => {
        completed = true;
      });
      cleanups.push(async () => {
        controller.abort(new Error("Fixture cleanup"));
        await result;
      });
      await Promise.race([
        submitted.promise,
        result.then((value) => {
          if (value.terminal.kind === "failed") {
            throw value.terminal.error;
          }
          throw new Error(`Fixture attempt ended before native input: ${value.terminal.kind}`);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      return { result, completed: () => completed };
    },
  };
}

function createDelayedRead() {
  const response = deferred<void>();
  let started = false;
  let released = false;
  return {
    get started() {
      return started;
    },
    get released() {
      return released;
    },
    release() {
      released = true;
      response.resolve();
    },
    async wait(signal?: AbortSignal) {
      started = true;
      signal?.throwIfAborted();
      let onAbort = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Fixture read aborted", { cause: signal?.reason }));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([response.promise, aborted]);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function createEventStream() {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let detachAbort = () => {};
  const observed = new Map<string, ReturnType<typeof deferred<void>>>();
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
    send(event: AgentsApiEvent) {
      const receipt = deferred<void>();
      observed.set(event.type, receipt);
      if (!streamController) {
        throw new Error("Expected an open native event stream");
      }
      streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      return receipt.promise;
    },
    observe(type: string) {
      observed.get(type)?.resolve();
      observed.delete(type);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function message(id: string, role: "user" | "assistant", text: string): AgentSessionMessage {
  return {
    id,
    turn_id: "turn-fixture",
    type: "message",
    role,
    phase: role === "assistant" ? "final_answer" : null,
    status: "completed",
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  };
}

export const nativeFailure = {
  code: "authentication_error",
  message: "Native authentication failed.",
} satisfies NonNullable<Turn["error"]>;
export const completedTurn = {
  id: "turn-fixture",
  agent_id: "agent-fixture",
  session_id: "session-fixture",
  object: "agent.session.turn",
  created_at: 1,
  started_at: 1,
  completed_at: 2,
  status: "completed",
  subagent_id: null,
  error: null,
  usage: {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 13,
  },
} satisfies Turn;
