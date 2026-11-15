import "./openclaw-tools.sessions.mocks.test-support.js";
import "./test-helpers/fast-openclaw-tools-sessions.js";
// Verifies sessions list/history/send behavior across gateway and channel targets.
import path from "node:path";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentParamsSchema } from "../../packages/gateway-protocol/src/schema/agent.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionParticipantsReadOnly,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  drainSystemEventEntries,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { createSessionVisibilityChecker } from "../plugin-sdk/session-visibility.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import { testing as embeddedRunsTesting } from "./embedded-agent-runner/runs.test-support.js";
import { registerSessionsSendParticipantTests } from "./openclaw-tools.sessions-participants.test-support.js";
import { registerSessionsSendResumeTests } from "./openclaw-tools.sessions-resume.test-support.js";
import { registerSessionsSendRejectedSteeringTests } from "./openclaw-tools.sessions-steering.rejection.cases.js";
import {
  activeRun,
  registerSessionsSendActiveSteeringTests,
  createSessionsSendTestCaller,
} from "./openclaw-tools.sessions-steering.test-support.js";
import {
  observeSessionSendContinuations,
  registerSessionsSendLateReplyTests,
  registerSessionsSendTimeoutTests,
} from "./openclaw-tools.sessions-timeout.test-support.js";
import {
  getSessionTool,
  createSessionsSendGatewayScope,
  mockAcceptedChildFollowup,
  installMessagingTestRegistry,
  TEST_CONFIG,
  type GatewayCall,
} from "./openclaw-tools.sessions.test-support.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";
import { compactToolOutputHint, toolSchemaDeclaration } from "./tool-schema-hints.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const { callGatewayMock } = await import("./openclaw-tools.sessions.mocks.test-support.js");

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-scoped-session-send-");
const continuations = observeSessionSendContinuations();
const mainKey = "agent:main:main";

async function seedSession(
  sessionKey: string,
  sessionId = sessionKey,
  fields: Parameters<typeof upsertSessionEntryCore>[1] = {},
  storePath?: string,
) {
  await upsertSessionEntryCore(
    { agentId: parseAgentSessionKey(sessionKey)!.agentId, sessionKey, storePath },
    { sessionId, updatedAt: 1, ...fields },
  );
}

async function activeSession(
  key: string,
  options: Parameters<typeof activeRun>[1],
  fields?: Parameters<typeof upsertSessionEntryCore>[1],
) {
  await seedSession(key, options.sessionId ?? "caller-active-session", fields, options.storeScope);
  return activeRun(key, options);
}

async function writeFinal(sessionKey: string, runId: string, text: string, sessionId = sessionKey) {
  await persistSessionTranscriptTurn(
    { agentId: parseAgentSessionKey(sessionKey)!.agentId, sessionKey, sessionId },
    {
      config: TEST_CONFIG,
      runId,
      expectedSessionId: sessionId,
      touchSessionEntry: false,
      updateMode: "none",
      messages: [
        { message: { ...textAssistant(text), phase: "final_answer", stopReason: "stop" } },
      ],
    },
  );
}

function cloneTestConfig() {
  return { ...TEST_CONFIG, session: { ...TEST_CONFIG.session } };
}

function sessionSender(agentSessionKey: string, agentChannel?: string, config?: OpenClawConfig) {
  return getSessionTool("sessions_send", { agentSessionKey, agentChannel, config });
}

function mockGatewayResponses(responses: Record<string, unknown>) {
  callGatewayMock.mockImplementation(
    async (request: GatewayCall) => responses[request.method ?? ""] ?? {},
  );
}

function gatewayCalls(method: string) {
  return callGatewayMock.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method);
}

async function readHistory(callId: string, messages: unknown[], includeTools?: true) {
  mockGatewayResponses({ "chat.history": { messages } });
  const result = await getSessionTool("sessions_history").execute(callId, {
    sessionKey: "main",
    ...(includeTools ? { includeTools } : {}),
  });
  return result.details as { messages?: Array<Record<string, unknown>>; bytes?: number };
}

function agentParams(call: { params?: unknown }) {
  return (call.params ?? {}) as Partial<Static<typeof AgentParamsSchema>>;
}

describe("sessions tools", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    callGatewayMock.mockClear();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    installMessagingTestRegistry();
    setRuntimeConfigSnapshot(TEST_CONFIG);
    await seedSession(mainKey);
  });
  afterEach(() =>
    runQaGatewayFixture(
      () => continuations.settle(),
      resetGatewayWorkAdmission,
      resetSystemEventsForTest,
      resetAdjustedParamsByToolCallIdForTests,
      clearRuntimeConfigSnapshot,
    ),
  );
  afterAll(() =>
    runQaGatewayFixture(
      () => continuations.settle(),
      () => continuations.restore(),
    ),
  );

  registerSessionsSendResumeTests({ getSessionTool, callGatewayMock });

  it("sessions_send notify queues next-turn context without starting or steering work", async () => {
    const targetKey = "agent:main:dashboard:notification-target";
    await seedSession(targetKey);
    callGatewayMock.mockImplementation(async () => ({}));
    const tool = sessionSender(mainKey);
    const result = await tool.execute("notify", {
      sessionKey: targetKey,
      message: "Evidence is ready",
      mode: "notify",
    });
    const queuedReceipt = {
      status: "queued",
      sessionKey: targetKey,
      durability: "process",
      runStarted: false,
    };
    expect(result.details).toMatchObject(queuedReceipt);
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    const schemaReceipt = { ...queuedReceipt, notificationId: "notification-fixture" };
    expect(Value.Check(tool.outputSchema!, { ...schemaReceipt, durability: "durable" })).toBe(
      false,
    );
    expect(Value.Check(tool.outputSchema!, { ...schemaReceipt, runStarted: true })).toBe(false);
    expect(callGatewayMock.mock.calls.some(([request]) => request.method === "agent")).toBe(false);
    const queued = peekSystemEventEntries(targetKey);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toContain("Evidence is ready");
    expect(drainSystemEventEntries(targetKey)).toEqual(queued);
    expect(peekSystemEventEntries(targetKey)).toEqual([]);
  });

  it("sessions_send steer refuses idle work and followup starts a separate turn", async () => {
    const targetKey = "agent:main:cron:followup:run:active";
    await seedSession(targetKey, "active-target");
    mockGatewayResponses({
      agent: { runId: "followup-run", status: "accepted" },
      "agent.wait": { status: "ok", terminalReply: { disposition: "empty" } },
    });
    const tool = sessionSender(mainKey);
    const idle = await tool.execute("idle-steer", {
      sessionKey: targetKey,
      message: "Adjust this",
      mode: "steer",
    });
    expect(idle.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("no active run"),
    });
    expect(gatewayCalls("agent")).toHaveLength(0);
    const defaultIdle = await tool.execute("idle-default", {
      sessionKey: targetKey,
      message: "Start synthetic idle work",
      timeoutSeconds: 0,
    });
    expect(defaultIdle.details).toMatchObject({ status: "accepted", targetDisposition: "queued" });
    await continuations.settle();
    expect(gatewayCalls("agent")).toHaveLength(1);
    callGatewayMock.mockClear();
    const queueMessage = await activeRun(targetKey, {
      config: TEST_CONFIG,
      requesterSessionKey: "agent:main:main",
      sessionId: "active-target",
      sourceReplyDeliveryMode: "automatic",
    });
    const followup = await withGatewayToolCallerIdentity(
      createSessionsSendTestCaller("agent:main:main"),
      () =>
        tool.execute("followup", {
          sessionKey: targetKey,
          message: "Do this next",
          mode: "followup",
          timeoutSeconds: 0,
        }),
    );
    expect(followup.details).toMatchObject({ status: "accepted", targetDisposition: "queued" });
    expect(queueMessage).not.toHaveBeenCalled();
    expect(gatewayCalls("agent")).toHaveLength(1);
  });

  it("sessions_send does not enqueue a notification beyond an exact session grant", async () => {
    const targetKey = "agent:main:dashboard:notification-target";
    callGatewayMock.mockImplementation(async () => ({}));
    const tool = createSessionsSendTool({
      agentSessionKey: mainKey,
      expectedTargetSessionId: "exact-incarnation",
      config: TEST_CONFIG,
      callGateway: callGatewayMock,
    });
    const result = await tool.execute("notify", {
      sessionKey: targetKey,
      message: "Evidence is ready",
      mode: "notify",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("exact-session access grant"),
    });
    expect(peekSystemEventEntries(targetKey)).toEqual([]);
  });

  it("sessions_send requires canonical message instead of hidden alias text", async () => {
    await expect(
      getSessionTool("sessions_send").execute("alias-body", {
        sessionKey: mainKey,
        text: "hidden message",
        timeoutSeconds: 0,
      }),
    ).rejects.toThrow("message required");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("sessions_list filters visibility before hydrating mailbox previews and messages", async () => {
    const session = (key: string, classification: string, extra = {}) => ({
      key: `agent:main:${key}`,
      kind: "direct",
      classification,
      sessionId: key,
      updatedAt: 10,
      ...extra,
    });
    const sessions = [
      session("main", "main", { lastChannel: "whatsapp", lastMessagePreview: "Latest update" }),
      session("discord:group:dev", "group", {
        kind: "group",
        peerKind: "group",
        channel: "discord",
        displayName: "discord:g-dev",
        status: "running",
        startedAt: 100,
        runtimeMs: 42,
        estimatedCostUsd: 0.0042,
        childSessions: ["agent:main:subagent:worker"],
        derivedTitle: "Dev room",
        lastMessagePreview: "Need review",
      }),
      session("dashboard:child", "dashboard", { parentSessionKey: mainKey }),
      session("subagent:worker", "subagent", { spawnedBy: mainKey }),
      session("cron:job-1", "cron"),
      { key: "global", kind: "global", classification: "global", agentId: "main" },
      { key: "unknown", kind: "unknown", classification: "unknown", agentId: "main" },
      { key: "agent:other:main", agentId: "other", sessionId: "hidden", classification: "main" },
    ];
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      if (request.method === "sessions.list") {
        return { sessions };
      }
      if (request.method === "sessions.describe") {
        const row = sessions.find((entry) => entry.key === request.params?.key);
        return {
          session: row
            ? { ...row, ...(row.key === mainKey ? { derivedTitle: "Main mailbox" } : {}) }
            : null,
        };
      }
      return request.method === "chat.history"
        ? { messages: [{ role: "toolResult", content: [] }, textAssistant("hi")] }
        : {};
    });
    const result = await getSessionTool("sessions_list", {
      agentSessionKey: mainKey,
      config: {
        ...TEST_CONFIG,
        tools: { sessions: { visibility: "agent" }, agentToAgent: { enabled: false } },
      },
    }).execute("mailbox", {
      agentId: "main",
      label: "mailbox",
      search: "review",
      includeDerivedTitles: true,
      includeLastMessage: true,
      messageLimit: 1,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "sessions.list",
        params: expect.objectContaining({
          agentId: "main",
          label: "mailbox",
          search: "review",
          includeDerivedTitles: false,
          includeLastMessage: false,
        }),
      }),
    );
    const described = gatewayCalls("sessions.describe").map((request) => request.params.key);
    expect(described).toContain(mainKey);
    expect(described).not.toContain("agent:other:main");
    expect(result.details).toMatchObject({
      count: 5,
      sessions: [
        {
          key: mainKey,
          agentId: "main",
          channel: "whatsapp",
          derivedTitle: "Main mailbox",
          lastMessagePreview: "Latest update",
          messages: [{ role: "assistant" }],
        },
        {
          key: "agent:main:discord:group:dev",
          status: "running",
          childSessions: ["agent:main:subagent:worker"],
          derivedTitle: "Dev room",
          lastMessagePreview: "Need review",
        },
        { key: "agent:main:dashboard:child", parentSessionKey: mainKey },
        { key: "agent:main:subagent:worker", parentSessionKey: mainKey },
        { key: "agent:main:cron:job-1", kind: "cron" },
      ],
    });
  });

  it("sessions_history caps oversized payloads and strips tool-owned heavy fields", async () => {
    const details = await readHistory(
      "bounded",
      Array.from({ length: 80 }, (_, idx) => ({
        role: "assistant",
        content: [
          { type: "text", text: `${idx}:${"x".repeat(5000)}` },
          { type: "thinking", thinking: "y".repeat(7000) },
        ],
        details: { giant: "z".repeat(12000) },
        usage: { input: 1, output: 1 },
      })),
      true,
    );
    expect(details).toMatchObject({
      truncated: true,
      droppedMessages: true,
      contentTruncated: true,
      contentRedacted: false,
    });
    expect(details.bytes).toEqual(expect.any(Number));
    expect(details.bytes).toBeLessThanOrEqual(80 * 1024);
    expect(details.messages?.length).toBeGreaterThan(0);
    const first = details.messages?.[0];
    expect(first).not.toHaveProperty("details");
    expect(first).not.toHaveProperty("usage");
    expect(first).toMatchObject({
      content: [
        { type: "text", text: expect.stringMatching(/^[\s\S]{1,4015}$/) },
        { type: "thinking", thinking: expect.stringMatching(/^[\s\S]{1,4015}$/) },
      ],
    });
  });

  it("sessions_history preserves credential text while reporting truncation", async () => {
    const secret = "sk-9876543210fedcba9876";
    const details = await readHistory("preserved", [
      textAssistant(`${secret} ${"safe text ".repeat(420)}`),
    ]);
    expect(details).toMatchObject({
      contentRedacted: false,
      contentTruncated: true,
      truncated: true,
    });
    expect(JSON.stringify(details)).toContain(secret);
  });

  it("sessions_send does not redeliver a source reply when history lacks its message-tool result", async () => {
    const sessionKey = "agent:main:discord:group:source";
    await seedSession(sessionKey, "source-session");
    const marker = "source reply delivered once";
    let waitObserved = false;
    const deliveredMessages: string[] = [];
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      if (request.method === "agent") {
        return { runId: "run-source-reply", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        waitObserved = true;
        deliveredMessages.push(marker);
        await writeFinal(sessionKey, "run-source-reply", marker, "source-session");
        return {
          runId: "run-source-reply",
          status: "ok",
          terminalReply: { disposition: "visible", text: marker },
          terminalReceipt: {
            runId: "run-source-reply",
            sessionId: "source-session",
            turnId: "source-turn",
            requested: { provider: "provider", model: "model" },
            effective: { provider: "provider", model: "model", responseModel: "model" },
            successfulToolNames: ["message"],
            sourceReplyDelivered: true,
            rerouted: false,
            terminalDisposition: "visible",
          },
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      if (request.method === "send") {
        deliveredMessages.push(String(request.params?.message));
        return { messageId: "duplicate-reply" };
      }
      return {};
    });
    const tool = sessionSender(sessionKey, "discord");

    const result = await tool.execute("call-source-reply", {
      sessionKey,
      message: "Reply through the message tool",
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-source-reply" });
    await continuations.settle();
    expect(waitObserved).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(deliveredMessages).toEqual([marker]);
    expect(gatewayCalls("chat.history")).toHaveLength(0);
  });

  it("keeps scoped sends from creating post-return work or durable watches", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const requesterSessionKey = "agent:main:clickclack:discussion-proof";
    const targetSessionKey = mainKey;
    const expectedSessionId = "scoped-main-incarnation";
    await seedSession(targetSessionKey, expectedSessionId, {}, storePath);
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) =>
      request.requesterSessionKey === requesterSessionKey &&
      request.targetSessionKey === targetSessionKey
        ? { expectedSessionId }
        : undefined,
    );
    mockGatewayResponses({
      "sessions.resolve": { key: targetSessionKey },
      agent: { runId: "run-scoped", status: "accepted", acceptedAt: 1 },
    });
    const decisionWork: ExecutionDecisionWork[] = [];
    const clearDecisionSink = configureExecutionDecisionWorkSink((work) => {
      decisionWork.push(work);
      return true;
    });
    try {
      const tool = getSessionTool("sessions_send", {
        agentSessionKey: requesterSessionKey,
        sandboxed: true,
        config: {
          session: { store: storePath, mainKey: "main", scope: "per-sender" },
          tools: { sessions: { visibility: "self" }, agentToAgent: { enabled: false } },
          agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
        } as OpenClawConfig,
      });

      const token = createExecutionIdentityAdmissionToken("scoped-session-send", {
        contextId: "scoped-session-send-context",
        executionId: "scoped-session-send-execution",
      });
      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: requesterSessionKey,
          executionIdentityToken: token,
          receiptAuthority: () => true,
        },
        async () =>
          await tool.execute("scoped-send", {
            sessionKey: targetSessionKey,
            message: "Please check the main session",
            timeoutSeconds: 0,
            watch: true,
          }),
      );

      expect(result.details).toMatchObject({
        status: "accepted",
        targetDisposition: "queued",
        delivery: { status: "skipped" },
        watched: false,
      });
      expect(callGatewayMock.mock.calls.map(([call]) => call.method)).toEqual(["agent"]);
      expect(decisionWork).toHaveLength(1);
      expect(decisionWork[0]).toMatchObject({
        receipt: {
          action: { family: "session", operation: "send" },
          decision: { outcome: "allowed", reasonCode: "session_send_committed" },
          enforcement: { coverageState: "attribution-only" },
        },
        refs: {
          target: { namespace: "session", value: `["main","${targetSessionKey}"]` },
        },
      });
    } finally {
      clearDecisionSink();
      unregister();
    }
  });

  registerSessionsSendParticipantTests({ config: TEST_CONFIG, callGatewayMock });

  it("returns an inline ordinary peer reply without starting a detached continuation", async () => {
    const requesterKey = "agent:main:whatsapp:group:req";
    const targetKey = "agent:director1:discord:group:target";
    await seedSession(requesterKey);
    await seedSession(targetKey);
    mockGatewayResponses({
      agent: { runId: "inline-result", status: "accepted" },
      "agent.wait": { status: "ok", terminalReply: { disposition: "visible", text: "initial" } },
    });
    const tool = sessionSender(requesterKey, "whatsapp");
    const waited = await tool.execute("inline-reply", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    await continuations.settle();
    const agentCalls = gatewayCalls("agent");
    expect(agentCalls).toHaveLength(1);
    expect(gatewayCalls("send")).toHaveLength(0);
    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "initial",
      delivery: { status: "skipped" },
    });
    expect(Value.Check(tool.outputSchema!, waited.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBeUndefined();
    const declaration = toolSchemaDeclaration(tool.outputSchema);
    for (const contract of [
      'durability: "process"',
      "runStarted: false",
      'status: "queued"',
      'targetDisposition: "queued" | "steered"',
      'status: "no_reply"',
      'status: "timeout"',
    ]) {
      expect(declaration).toContain(contract);
    }
    const params = agentParams(agentCalls[0]!);
    expect(params.message).toContain("[Inter-session message");
    expect(params.message).toContain("isUser=false");
    expect(params).toMatchObject({
      lane: expect.stringMatching(/^nested(?::|$)/),
      channel: "webchat",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: requesterKey,
        sourceTool: "sessions_send",
      },
    });
    expect(params.inputProvenance?.sourceRole).toBeUndefined();
    expect(params.extraSystemPrompt).toBeUndefined();
  });

  registerSessionsSendLateReplyTests({
    getSessionTool: (name, options) =>
      getSessionTool(name, { ...options, config: cloneTestConfig() }),
    callGatewayMock,
    settleContinuations: () => continuations.settle(),
  });

  registerSessionsSendActiveSteeringTests({
    mockAcceptedChildFollowup,
    runChildFollowup: (run) =>
      withPluginRuntimeGatewayRequestScope(createSessionsSendGatewayScope(), run),
    getSessionTool,
    seedSession,
    callGatewayMock,
    mockGatewayResponses,
    settleContinuations: () => continuations.settle(),
    cloneTestConfig,
    createSessionsSendTool: (options) =>
      createSessionsSendTool({ ...options, callGateway: callGatewayMock }),
  });

  registerSessionsSendRejectedSteeringTests({
    getSessionTool,
    cloneTestConfig,
    seedSession,
    callGatewayMock,
    mockGatewayResponses,
    settleContinuations: () => continuations.settle(),
  });

  it("sessions_send falls back from stranded cron run key to durable cron parent", async () => {
    const requesterKey = "agent:main:cron:source-job:run:source-run";
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:stranded";
    const durableCronCallerKey = "agent:leasing-ops:cron:monthly-utility";
    const dir = sessionDirs.make();
    const parentScope = {
      agentId: "leasing-ops",
      sessionKey: durableCronCallerKey,
      storePath: resolveSessionStorePathCore(undefined, { agentId: "leasing-ops" }),
    };
    const runScope = {
      ...parentScope,
      sessionKey: runScopedCallerKey,
      storePath: path.join(dir, "agents", "leasing-ops", "sessions", "sessions.json"),
    };
    await upsertSessionEntryCore(parentScope, { sessionId: "durable-parent", updatedAt: 1 });
    await upsertSessionEntryCore(runScope, { sessionId: "caller-active-session", updatedAt: 1 });
    const config: OpenClawConfig = {
      ...cloneTestConfig(),
      session: { store: path.join(dir, "agents", "{agentId}", "sessions", "sessions.json") },
    };
    const queueMessage = await activeRun(runScopedCallerKey, {
      config,
      streaming: false,
      requesterSessionKey: requesterKey,
      storeScope: runScope.storePath,
    });
    mockGatewayResponses({
      agent: { runId: "durable-fallback-run", status: "accepted", acceptedAt: 2000 },
      "agent.wait": {
        runId: "durable-fallback-run",
        status: "ok",
        terminalReply: { disposition: "empty" },
      },
    });

    const tool = sessionSender(requesterKey, "telegram", config);

    const result = await withGatewayToolCallerIdentity(
      createSessionsSendTestCaller(requesterKey),
      () =>
        tool.execute("call-run-scoped-caller", {
          sessionKey: runScopedCallerKey,
          message: "[TASK-COMPLETE] re-portal occupancy ready",
          timeoutSeconds: 0,
        }),
    );

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "durable-fallback-run",
      sessionKey: runScopedCallerKey,
      delivery: { status: "skipped" },
    });
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = gatewayCalls("agent");
    expect(agentCalls).toHaveLength(1);
    const params = agentParams(agentCalls[0] ?? {});
    expect(params.sessionKey).toBe(durableCronCallerKey);
    expect(params.message).toContain("[Inter-session message]");
    expect(params.message).toContain("[TASK-COMPLETE] re-portal occupancy ready");
    await continuations.settle();
    expect(gatewayCalls("agent.wait")).toHaveLength(0);
    expect(gatewayCalls("chat.history")).toHaveLength(0);
    expect(gatewayCalls("agent")).toHaveLength(1);
    await runOpenClawAgentWriteAdmission(
      toDatabaseOptions(resolveSqliteScope(parentScope)),
      () => undefined,
    );
    expect
      .soft(listSessionParticipantsReadOnly(parentScope).get(durableCronCallerKey))
      .toEqual([
        expect.objectContaining({ identity: { type: "agent", id: "main" }, contributionCount: 1 }),
      ]);
    expect
      .soft(listSessionParticipantsReadOnly(runScope).get(durableCronCallerKey) ?? [])
      .toEqual([]);
  });

  it("sessions_send never reroutes an exact-incarnation grant to a Cron parent", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const requesterKey = mainKey;
    const runScopedTargetKey = "agent:leasing-ops:cron:monthly-utility:run:run-exact";
    const targetSessionId = "exact-cron-run-incarnation";
    const config: OpenClawConfig = {
      ...cloneTestConfig(),
      session: { ...cloneTestConfig().session, store: storePath },
    };
    const queueMessage = await activeSession(runScopedTargetKey, {
      config,
      requesterSessionKey: requesterKey,
      sessionId: targetSessionId,
      streaming: false,
      storeScope: storePath,
    });
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      if (request.method === "sessions.list") {
        return { path: storePath, sessions: [{ key: runScopedTargetKey, kind: "direct" }] };
      }
      if (request.method === "agent") {
        throw new Error("exact target must not fall back to the durable Cron session");
      }
      return {};
    });
    const tool = createSessionsSendTool({
      agentSessionKey: requesterKey,
      expectedTargetSessionId: targetSessionId,
      idempotencyKey: "worker-session-send:exact-cron-operation",
      config,
      callGateway: callGatewayMock,
    });

    const result = await withGatewayToolCallerIdentity(
      createSessionsSendTestCaller(requesterKey),
      () =>
        tool.execute("exact-cron-send", {
          sessionKey: runScopedTargetKey,
          message: "do not reroute this exact message",
          timeoutSeconds: 0,
        }),
    );

    expect(result.details).toMatchObject({ status: "error", sessionKey: runScopedTargetKey });
    expect(queueMessage).not.toHaveBeenCalled();
    expect(gatewayCalls("agent")).toHaveLength(0);
  });

  registerSessionsSendTimeoutTests({ getSessionTool, callGatewayMock });

  it("sessions_history resolves sessionId inputs", async () => {
    const sessionId = "sess-group";
    const targetKey = "agent:main:discord:channel:1457165743010611293";
    mockGatewayResponses({
      "sessions.resolve": { key: targetKey },
      "chat.history": {
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      },
    });

    const tool = getSessionTool("sessions_history");

    const result = await tool.execute("call5", { sessionKey: sessionId });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toStrictEqual([textAssistant("ok")]);
    expect(gatewayCalls("chat.history")[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: targetKey },
    });
  });

  it("sessions_history enforces a hard byte cap even when a single message is huge", async () => {
    const details = await readHistory(
      "call4c",
      [{ ...textAssistant("ok"), extra: "x".repeat(200_000) }],
      true,
    );
    expect(details).toMatchObject({
      truncated: true,
      droppedMessages: true,
      contentTruncated: false,
      contentRedacted: false,
      bytes: expect.any(Number),
    });
    expect(details.bytes ?? 0).toBeLessThanOrEqual(80 * 1024);
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.content).toContain(
      "[sessions_history omitted: message too large]",
    );
  });

  it("sessions_history errors on missing sessionId", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.resolve") {
        throw new Error("No session found");
      }
      return {};
    });

    const tool = getSessionTool("sessions_history");

    const result = await tool.execute("call6", { sessionKey: sessionId });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toMatch(/Session not found|No session found/);
  });
});
