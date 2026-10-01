import path from "node:path";
import type { AgentSessionMessage } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import {
  embeddedAgentLog,
  queueAgentHarnessMessage,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgentsApiAttempt } from "./agentsapi-attempt.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itemsAuthenticationError = "Fixture authentication rejected the items request.";

afterEach(() => {
  vi.restoreAllMocks();
  fetchWithSsrFGuardMock.mockReset();
  closeOpenClawAgentDatabasesForTest();
});

describe("Agents API completed result recovery", () => {
  it.each([
    { text: "The completed answer.", failedRead: 1 },
    { text: "NO_REPLY", failedRead: 1 },
    { text: "The completed answer.", failedRead: 2 },
    { text: "NO_REPLY", failedRead: 2 },
  ])(
    "recovers $text after items read $failedRead fails without replaying native input",
    async ({ text, failedRead }) => {
      const fixture = await createAttempt({ text, failedRead });

      const result = await fixture.run();

      expect(result.terminal).toEqual({ kind: "ok" });
      expect(result.assistantTexts).toEqual([text]);
      expect(result.agentHarnessResultClassification).toBeUndefined();
      expect(result.currentAttemptCompletedAssistant).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
      });
      expect(result.assistantTranscriptOwned).toBe(true);
      expect(result.assistantTranscriptIdempotencyKey).toBe(
        "agentsapi:session-fixture:turn-fixture",
      );
      expect(fixture.transcript()).toEqual([result.currentAttemptCompletedAssistant]);
      expect(result.messagesSnapshot).toEqual(fixture.transcript());
      expect(fixture.onPartialReply).toHaveBeenCalledExactlyOnceWith({ text });
      expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
      expect(fixture.inputEvents.filter((type) => type === "agent.session.input.message")).toEqual([
        "agent.session.input.message",
      ]);
      expect(fixture.warnings).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error: expect.objectContaining({
            status: 401,
            message: expect.stringContaining(itemsAuthenticationError),
          }),
        }),
      );
    },
  );

  it.each([
    "missing input receipt",
    "later foreign input",
    "different final root with the same input count",
    "failed turn",
    "cancelled turn",
    "completed turn with error",
    "incomplete final message",
    "blank final message",
    "failed session",
    "repeated authentication failure",
  ] as const)("preserves the read failure when saved state has %s", async (condition) => {
    const fixture = await createAttempt({ failedRead: 1 });
    if (condition === "missing input receipt") {
      fixture.saved.items = fixture.saved.items.filter((item) => item.role !== "user");
    } else if (condition === "later foreign input") {
      fixture.saved.turns.push({ ...completedTurn, id: "turn-later" });
      fixture.saved.items.push({
        ...message("foreign-input", "user", "A different request."),
        turn_id: "turn-later",
      });
    } else if (condition === "different final root with the same input count") {
      fixture.saved.onItemsFailure = () => {
        fixture.saved.turns = [completedTurn, { ...completedTurn, id: "turn-later" }];
        fixture.saved.items = fixture.saved.items.map((item) => ({
          ...item,
          turn_id: "turn-later",
        }));
      };
    } else if (condition === "failed turn") {
      fixture.saved.turns = [{ ...completedTurn, status: "failed", error: nativeFailure }];
    } else if (condition === "cancelled turn") {
      fixture.saved.turns = [{ ...completedTurn, status: "cancelled" }];
    } else if (condition === "completed turn with error") {
      fixture.saved.turns = [{ ...completedTurn, error: nativeFailure }];
    } else if (condition === "incomplete final message") {
      fixture.saved.items[1] = { ...fixture.saved.items[1]!, status: "in_progress" };
    } else if (condition === "blank final message") {
      fixture.saved.items[1] = message("answer-fixture", "assistant", " \n\t");
    } else if (condition === "failed session") {
      fixture.saved.session.status = "failed";
      fixture.saved.session.error = "The saved session failed.";
    } else {
      fixture.saved.rejectAllItems = true;
    }

    const result = await fixture.run();

    expect(result.terminal).toMatchObject({
      kind: "failed",
      error: { status: 401, message: expect.stringContaining(itemsAuthenticationError) },
    });
    expect(result.assistantTexts).toEqual([]);
    expect(result.assistantTranscriptOwned).toBe(false);
    expect(fixture.onPartialReply).not.toHaveBeenCalled();
    expect(fixture.transcript()).toEqual([]);
    expect(fixture.inputEvents).toEqual([
      "agent.session.input.message",
      "agent.session.input.cancel",
    ]);
  });

  it.each([false, true])(
    "requires the accepted steering receipt before recovering a reply (receipt saved: %s)",
    async (receiptSaved) => {
      const fixture = await createAttempt({ failedRead: 1, steer: "Follow-up fixture" });
      if (receiptSaved) {
        fixture.saved.items.splice(1, 0, message("steer-fixture", "user", "Follow-up fixture"));
      }

      const result = await fixture.run();

      expect(fixture.inputEvents).toEqual([
        "agent.session.input.message",
        "agent.session.input.message",
        "agent.session.input.cancel",
      ]);
      if (receiptSaved) {
        expect(result.terminal).toEqual({ kind: "ok" });
        expect(result.assistantTexts).toEqual(["The completed answer."]);
        expect(fixture.transcript()).toEqual([result.currentAttemptCompletedAssistant]);
      } else {
        expect(result.terminal).toMatchObject({ kind: "failed", error: { status: 401 } });
        expect(result.assistantTexts).toEqual([]);
        expect(fixture.onPartialReply).not.toHaveBeenCalled();
        expect(fixture.transcript()).toEqual([]);
      }
    },
  );

  it("reads recovery items after the idle barrier exposes a different final root", async () => {
    const fixture = await createAttempt({ failedRead: 1 });
    const replaceRoot = vi.fn(() => {
      fixture.saved.turns = [completedTurn, { ...completedTurn, id: "turn-after-idle" }];
      fixture.saved.items = fixture.saved.items.map((item) => ({
        ...item,
        turn_id: "turn-after-idle",
      }));
    });
    fixture.saved.beforeRecoverySession = replaceRoot;

    const result = await fixture.run();

    expect(replaceRoot).toHaveBeenCalledOnce();
    expect(result.terminal).toMatchObject({
      kind: "failed",
      error: { status: 401, message: expect.stringContaining(itemsAuthenticationError) },
    });
    expect(result.assistantTexts).toEqual([]);
    expect(fixture.onPartialReply).not.toHaveBeenCalled();
    expect(fixture.transcript()).toEqual([]);
  });

  it("retains a later retirement failure instead of promoting the earlier completed result", async () => {
    const fixture = await createAttempt({ failedRead: 1 });
    fixture.saved.rejectCancel = true;

    const result = await fixture.run();

    expect(result.terminal).toMatchObject({
      kind: "failed",
      error: { message: expect.stringContaining("Native retirement failed.") },
    });
    expect(result.assistantTexts).toEqual([]);
    expect(fixture.onPartialReply).not.toHaveBeenCalled();
    expect(fixture.transcript()).toEqual([]);
  });

  it.each(["external abort", "revoked owner"] as const)(
    "does not publish the saved completed reply after %s during recovery",
    async (condition) => {
      const fixture = await createAttempt({ failedRead: 1 });
      const failure = new Error(condition);
      fixture.saved.beforeRecoveryItems = () => {
        if (condition === "external abort") {
          fixture.controller.abort(failure);
        } else {
          fixture.revoke(failure);
        }
      };

      const result = await fixture.run();

      expect(result.terminal.kind).not.toBe("ok");
      expect(result.assistantTexts).toEqual([]);
      expect(fixture.onPartialReply).not.toHaveBeenCalled();
      expect(fixture.transcript()).toEqual([]);
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "retains a genuine native %s outcome without a read failure",
    async (status) => {
      const fixture = await createAttempt({ failedRead: undefined });
      fixture.saved.turns = [
        {
          ...completedTurn,
          status,
          error: status === "failed" ? nativeFailure : null,
        },
      ];

      const result = await fixture.run();

      expect(result.terminal).toMatchObject(
        status === "failed"
          ? { kind: "failed", error: { message: nativeFailure.message } }
          : { kind: "aborted", source: "runtime" },
      );
      expect(result.assistantTexts).toEqual([]);
      expect(fixture.onPartialReply).not.toHaveBeenCalled();
      expect(fixture.transcript()).toEqual([]);
      expect(fixture.inputEvents).toEqual(["agent.session.input.message"]);
    },
  );
});

async function createAttempt(options: {
  text?: string;
  failedRead: number | undefined;
  steer?: string;
}) {
  const workspaceDir = tempDirs.make("agentsapi-result-recovery-");
  const target = {
    agentId: "main",
    sessionId: "recovery-fixture",
    sessionKey: "agent:main:recovery-fixture",
    storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const controller = new AbortController();
  let revocation: Error | undefined;
  const assertCurrent = () => {
    if (revocation) {
      throw revocation;
    }
  };
  const saved = {
    turns: [completedTurn],
    items: [
      message("input-fixture", "user", "Fixture prompt"),
      message("answer-fixture", "assistant", options.text ?? "The completed answer."),
    ],
    session: {
      id: "session-fixture",
      status: "idle",
      error: null as string | null,
      environment: { id: "environment-fixture", type: "openai_hosted" },
      required_actions: [],
    },
    rejectAllItems: false,
    rejectCancel: false,
    onItemsFailure: undefined as (() => void) | undefined,
    beforeRecoveryItems: undefined as (() => void) | undefined,
    beforeRecoverySession: undefined as (() => void) | undefined,
  };
  const inputEvents: string[] = [];
  let itemReads = 0;
  let sessionReads = 0;
  fetchWithSsrFGuardMock.mockImplementation(async (request) => {
    request.beforeRequest?.();
    const pathname = new URL(request.url).pathname;
    let response: Response;
    if (request.init?.method === "POST" && pathname === "/v1/agents/sessions") {
      response = Response.json(saved.session);
    } else if (request.init?.method === "POST" && pathname.endsWith("/events")) {
      const payload = z
        .object({ events: z.array(z.object({ type: z.string() })) })
        .parse(await new Request(request.url, request.init).json());
      inputEvents.push(...payload.events.map((event) => event.type));
      response =
        saved.rejectCancel &&
        payload.events.some((event) => event.type === "agent.session.input.cancel")
          ? Response.json({ error: { message: "Native retirement failed." } }, { status: 401 })
          : Response.json({});
    } else if (new Headers(request.init?.headers).get("accept") === "text/event-stream") {
      response = idleEventStream(request.signal);
    } else if (pathname.endsWith("/turns")) {
      response = Response.json({ data: inputEvents.length ? saved.turns : [], has_more: false });
    } else if (pathname.endsWith("/items")) {
      itemReads++;
      if (itemReads === options.failedRead || saved.rejectAllItems) {
        saved.onItemsFailure?.();
        response = Response.json({ error: { message: itemsAuthenticationError } }, { status: 401 });
      } else {
        if (options.failedRead !== undefined && itemReads > options.failedRead) {
          saved.beforeRecoveryItems?.();
        }
        response = Response.json({ data: saved.items, has_more: false });
      }
    } else if (pathname.endsWith("/artifacts")) {
      response = Response.json({ data: [], has_more: false });
    } else if (pathname === "/v1/agents/sessions/session-fixture") {
      sessionReads++;
      if (sessionReads === 2) {
        saved.beforeRecoverySession?.();
      }
      response = Response.json(saved.session);
    } else {
      throw new Error(`Unexpected fixture request: ${request.init?.method} ${pathname}`);
    }
    return { response, finalUrl: request.url, release: async () => {} };
  });
  const warnings = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
  const onPartialReply = vi.fn<NonNullable<AgentHarnessAttemptParamsV2["onPartialReply"]>>();
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
    onRunProgress: options.steer
      ? () => {
          expect(queueAgentHarnessMessage(target.sessionId, options.steer!)).toBe(true);
        }
      : undefined,
  };
  return {
    saved,
    controller,
    inputEvents,
    warnings,
    onPartialReply,
    revoke: (error: Error) => {
      revocation = error;
    },
    transcript: () => SessionManager.open(target, workspaceDir).buildSessionContext().messages,
    run: () =>
      runAgentsApiAttempt(
        params,
        undefined,
        async () => {},
        assertCurrent,
        () => {},
        target,
        () => ({}),
      ),
  };
}

function idleEventStream(signal?: AbortSignal) {
  let detachAbort = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"agent.session.idle"}\n\n'));
      const abort = () => controller.error(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      detachAbort = () => signal?.removeEventListener("abort", abort);
    },
    cancel() {
      detachAbort();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function message(id: string, role: "user" | "assistant", text: string): AgentSessionMessage {
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

const nativeFailure: NonNullable<Turn["error"]> = {
  code: "authentication_error",
  message: "Native authentication failed.",
};
const completedTurn: Turn = {
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
};
