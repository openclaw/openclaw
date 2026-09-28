import "./openclaw-tools.sessions.mocks.test-support.js";
import "./test-helpers/fast-openclaw-tools-sessions.js";
// Verifies sessions list/history/send behavior across gateway and channel targets.
import path from "node:path";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionParticipantsReadOnly,
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
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import * as embeddedRuns from "./embedded-agent-runner/runs.js";
import {
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueMessageOptions,
} from "./embedded-agent-runner/runs.js";
import { testing as embeddedRunsTesting } from "./embedded-agent-runner/runs.test-support.js";
import { registerSessionsSendParticipantTests } from "./openclaw-tools.sessions-participants.test-support.js";
import { registerSessionsSendResumeTests } from "./openclaw-tools.sessions-resume.test-support.js";
import {
  observeSessionSendContinuations,
  registerSessionsSendLateReplyTests,
  registerSessionsSendTimeoutTests,
} from "./openclaw-tools.sessions-timeout.test-support.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";
import { compactToolOutputHint, toolSchemaDeclaration } from "./tool-schema-hints.js";
import { testing as agentStepTesting } from "./tools/agent-step.test-support.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import * as sessionsSendFollowup from "./tools/sessions-send-followup.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const { callGatewayMock } = await import("./openclaw-tools.sessions.mocks.test-support.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const continuations = observeSessionSendContinuations();

const TEST_CONFIG = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
  tools: {
    sessions: { visibility: "all" },
    agentToAgent: { enabled: true },
  },
} as OpenClawConfig;

const resolveSessionConversationStub: NonNullable<
  ChannelMessagingAdapter["resolveSessionConversation"]
> = ({ rawId }) => ({
  id: rawId,
});
const resolveSessionTargetStub: NonNullable<ChannelMessagingAdapter["resolveSessionTarget"]> = ({
  kind,
  id,
  threadId,
}) => (threadId ? `${kind}:${id}:thread:${threadId}` : `${kind}:${id}`);

function installMessagingTestRegistry() {
  setActivePluginRegistry(
    createTestRegistry(
      (
        [
          { id: "discord", label: "Discord", chatTypes: ["direct", "channel", "thread"] },
          { id: "whatsapp", label: "WhatsApp", chatTypes: ["direct", "group"] },
        ] as const
      ).map(({ id, label, chatTypes }) => ({
        pluginId: id,
        source: "test",
        plugin: {
          id,
          meta: {
            id,
            label,
            selectionLabel: label,
            docsPath: `/channels/${id}`,
            blurb: `${label} test stub.`,
            ...(id === "whatsapp" ? { preferSessionLookupForAnnounceTarget: true } : {}),
          },
          capabilities: { chatTypes: [...chatTypes] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
        },
      })),
    ),
  );
}

function getSessionTool(
  name: "sessions_list" | "sessions_history" | "sessions_send",
  options?: {
    agentSessionKey?: string;
    agentChannel?: string;
    sandboxed?: boolean;
    config?: OpenClawConfig;
  },
) {
  return {
    sessions_list: createSessionsListTool,
    sessions_history: createSessionsHistoryTool,
    sessions_send: createSessionsSendTool,
  }[name]({
    ...options,
    agentChannel: options?.agentChannel as never,
    config: options?.config ?? TEST_CONFIG,
    callGateway: callGatewayMock,
  });
}

function cloneTestConfig() {
  return { ...TEST_CONFIG, session: { ...TEST_CONFIG.session } };
}

type GatewayCall = {
  method?: string;
  params?: Record<string, unknown>;
};

function mockGatewayResponses(responses: Record<string, unknown>) {
  callGatewayMock.mockImplementation(
    async (request: GatewayCall) => responses[request.method ?? ""] ?? {},
  );
}

type AgentCallParams = {
  message?: string;
  lane?: string;
  channel?: string;
  sessionKey?: string;
  extraSystemPrompt?: string;
  inputProvenance?: {
    kind?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
    sourceRole?: string;
  };
};

function activeRun(
  sessionKey: string,
  options: {
    sessionId?: string;
    streaming?: boolean;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    rejects?: boolean;
  } = {},
) {
  const queueMessage = vi.fn(async (_text: string, _options?: EmbeddedAgentQueueMessageOptions) => {
    if (options.rejects) {
      throw new Error("active session ended before queued steering message was committed");
    }
  });
  setActiveEmbeddedRun(
    options.sessionId ?? "caller-active-session",
    {
      queueMessage,
      isStreaming: () => options.streaming ?? true,
      isCompacting: () => false,
      supportsTranscriptCommitWait: true,
      sourceReplyDeliveryMode: options.sourceReplyDeliveryMode ?? "message_tool_only",
      abort: () => {},
    },
    sessionKey,
  );
  return queueMessage;
}

function agentParams(call: { params?: unknown }): AgentCallParams {
  return (call.params ?? {}) as AgentCallParams;
}

describe("sessions tools", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    callGatewayMock.mockClear();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    installMessagingTestRegistry();
    await agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
    });
  });
  afterEach(() =>
    runQaGatewayFixture(
      () => continuations.settle(),
      resetGatewayWorkAdmission,
      resetSystemEventsForTest,
      resetAdjustedParamsByToolCallIdForTests,
      () => agentStepTesting.setDepsForTest(),
    ),
  );
  afterAll(() =>
    runQaGatewayFixture(
      () => continuations.settle(),
      () => continuations.restore(),
    ),
  );

  registerSessionsSendResumeTests({
    getSessionTool,
    callGatewayMock,
  });

  it("sessions_send notify queues next-turn context without starting or steering work", async () => {
    const targetKey = "agent:main:dashboard:notification-target";
    callGatewayMock.mockImplementation(async () => ({}));
    const tool = getSessionTool("sessions_send", { agentSessionKey: "agent:main:main" });
    const result = await tool.execute("notify", {
      sessionKey: targetKey,
      message: "Evidence is ready",
      mode: "notify",
    });
    expect(result.details).toMatchObject({
      status: "queued",
      sessionKey: targetKey,
      durability: "process",
      runStarted: false,
    });
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    const queuedReceipt = {
      status: "queued",
      sessionKey: targetKey,
      notificationId: "notification-fixture",
      durability: "process",
      runStarted: false,
    };
    expect(Value.Check(tool.outputSchema!, { ...queuedReceipt, durability: "durable" })).toBe(
      false,
    );
    expect(Value.Check(tool.outputSchema!, { ...queuedReceipt, runStarted: true })).toBe(false);
    expect(callGatewayMock.mock.calls.some(([request]) => request.method === "agent")).toBe(false);
    const queued = peekSystemEventEntries(targetKey);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toContain("Evidence is ready");
    expect(drainSystemEventEntries(targetKey)).toEqual(queued);
    expect(peekSystemEventEntries(targetKey)).toEqual([]);
  });

  it("sessions_send steer refuses idle work and followup bypasses an active steering route", async () => {
    const targetKey = "agent:main:cron:followup:run:active";
    const calls: GatewayCall[] = [];
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "followup-run", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok", terminalReply: { disposition: "empty" } };
      }
      return {};
    });
    const tool = getSessionTool("sessions_send", { agentSessionKey: "agent:main:main" });
    const idle = await tool.execute("idle-steer", {
      sessionKey: targetKey,
      message: "Adjust this",
      mode: "steer",
    });
    expect(idle.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("no active run"),
    });
    expect(calls.some((request) => request.method === "agent")).toBe(false);
    const queueMessage = activeRun(targetKey, {
      sessionId: "active-target",
      sourceReplyDeliveryMode: "automatic",
    });
    const followup = await tool.execute("followup", {
      sessionKey: targetKey,
      message: "Do this next",
      mode: "followup",
      timeoutSeconds: 0,
    });
    expect(followup.details).toMatchObject({ status: "accepted", targetDisposition: "queued" });
    expect(queueMessage).not.toHaveBeenCalled();
    expect(calls.filter((request) => request.method === "agent")).toHaveLength(1);
  });

  it("sessions_send does not enqueue a notification beyond an exact session grant", async () => {
    const targetKey = "agent:main:dashboard:notification-target";
    callGatewayMock.mockImplementation(async () => ({}));
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
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

  it("sessions_send prepares sanitized aliases without exposing alias keys", () => {
    const tool = getSessionTool("sessions_send");
    if (!tool.prepareArguments) {
      throw new Error("missing sessions_send prepareArguments");
    }

    const prepared = tool.prepareArguments({
      sessionKey: "main",
      SendMessage: " ",
      content: "Reasoning:\n_internal plan_\n\nVisible answer",
      text: "ignored lower-priority alias",
      timeoutSeconds: 0,
    }) as Record<string, unknown>;

    expect(prepared.message).toBe("Visible answer");
    for (const alias of ["SendMessage", "content", "text"]) {
      expect(prepared).not.toHaveProperty(alias);
      expect(tool.parameters).not.toHaveProperty(`properties.${alias}`);
    }
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
      session("main", "main", {
        lastChannel: "whatsapp",
        lastMessagePreview: "Latest update",
      }),
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
      session("dashboard:child", "dashboard", { parentSessionKey: "agent:main:main" }),
      session("subagent:worker", "subagent", { spawnedBy: "agent:main:main" }),
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
            ? { ...row, ...(row.key === "agent:main:main" ? { derivedTitle: "Main mailbox" } : {}) }
            : null,
        };
      }
      return request.method === "chat.history"
        ? { messages: [{ role: "toolResult", content: [] }, textAssistant("hi")] }
        : {};
    });
    const result = await getSessionTool("sessions_list", {
      agentSessionKey: "agent:main:main",
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
    const described = callGatewayMock.mock.calls.filter(
      ([request]) => request.method === "sessions.describe",
    );
    expect(described.map(([request]) => request.params.key)).toContain("agent:main:main");
    expect(described.map(([request]) => request.params.key)).not.toContain("agent:other:main");
    expect(result.details).toMatchObject({
      count: 5,
      sessions: [
        {
          key: "agent:main:main",
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
        { key: "agent:main:dashboard:child", parentSessionKey: "agent:main:main" },
        { key: "agent:main:subagent:worker", parentSessionKey: "agent:main:main" },
        { key: "agent:main:cron:job-1", kind: "cron" },
      ],
    });
  });

  it("sessions_history caps oversized payloads and strips tool-owned heavy fields", async () => {
    mockGatewayResponses({
      "chat.history": {
        messages: Array.from({ length: 80 }, (_, idx) => ({
          role: "assistant",
          content: [
            { type: "text", text: `${idx}:${"x".repeat(5000)}` },
            { type: "thinking", thinking: "y".repeat(7000) },
          ],
          details: { giant: "z".repeat(12000) },
          usage: { input: 1, output: 1 },
        })),
      },
    });
    const result = await getSessionTool("sessions_history").execute("bounded", {
      sessionKey: "main",
      includeTools: true,
    });
    const details = result.details as { messages?: Array<Record<string, unknown>>; bytes?: number };
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

  it("sessions_history sets contentRedacted independently of contentTruncated", async () => {
    const secret = "sk-9876543210fedcba9876";
    mockGatewayResponses({
      "chat.history": { messages: [textAssistant(`${secret} ${"safe text ".repeat(420)}`)] },
    });
    const result = await getSessionTool("sessions_history").execute("redacted", {
      sessionKey: "main",
    });
    expect(result.details).toMatchObject({
      contentRedacted: true,
      contentTruncated: true,
      truncated: true,
    });
    expect(JSON.stringify(result.details)).not.toContain(secret);
  });

  it("sessions_send does not redeliver a source reply when history lacks its message-tool result", async () => {
    const sessionKey = "agent:main:discord:group:source";
    const marker = "source reply delivered once";
    let waitObserved = false;
    const deliveredMessages: string[] = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as GatewayCall;
      if (request.method === "agent") {
        return { runId: "run-source-reply", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        waitObserved = true;
        deliveredMessages.push(marker);
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
        return {
          messages: waitObserved ? [{ role: "assistant", content: marker, timestamp: 20 }] : [],
        };
      }
      if (request.method === "send") {
        deliveredMessages.push(String(request.params?.message));
        return { messageId: "duplicate-reply" };
      }
      return {};
    });
    const tool = getSessionTool("sessions_send", {
      agentSessionKey: sessionKey,
      agentChannel: "discord",
    });

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
    expect(callGatewayMock.mock.calls.some(([request]) => request.method === "chat.history")).toBe(
      false,
    );
  });

  it("keeps scoped sends from creating post-return work or durable watches", async () => {
    const tmpDir = tempDirs.make("openclaw-scoped-session-send-");
    const storePath = path.join(tmpDir, "sessions.json");
    const requesterSessionKey = "agent:main:clickclack:discussion-proof";
    const targetSessionKey = "agent:main:main";
    const expectedSessionId = "scoped-main-incarnation";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: targetSessionKey, storePath },
      { sessionId: expectedSessionId, updatedAt: 1 },
    );
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) =>
      request.requesterSessionKey === requesterSessionKey &&
      request.targetSessionKey === targetSessionKey
        ? { expectedSessionId }
        : undefined,
    );
    const calls: GatewayCall[] = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as GatewayCall;
      calls.push(request);
      if (request.method === "sessions.resolve") {
        return { key: targetSessionKey };
      }
      if (request.method === "agent") {
        return { runId: "run-scoped", status: "accepted", acceptedAt: 1 };
      }
      return {};
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
        delivery: { status: "skipped", mode: "announce" },
        watched: false,
      });
      expect(calls.map((call) => call.method)).toEqual(["agent"]);
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
      await closeOpenClawAgentDatabasesAsync(tmpDir);
    }
  });

  registerSessionsSendParticipantTests({
    config: TEST_CONFIG,
    makeTempDir: (prefix) => tempDirs.make(prefix),
    callGatewayMock,
  });

  it.each([
    {
      name: "session-key target",
      requesterKey: "agent:main:whatsapp:group:req",
      requesterChannel: "whatsapp",
      targetKey: "agent:director1:discord:group:target",
      targetAgentId: "director1",
      targetChannel: "discord",
      to: "group:target",
      hydrated: false,
    },
    {
      name: "hydrated threaded target",
      requesterKey: "discord:group:req",
      requesterChannel: "discord",
      targetKey: "agent:main:worker",
      targetAgentId: "main",
      targetChannel: "whatsapp",
      to: "123@g.us",
      hydrated: true,
    },
  ])(
    "runs ping-pong then announces to the $name",
    async ({
      requesterKey,
      requesterChannel,
      targetKey,
      targetAgentId,
      targetChannel,
      to,
      hydrated,
    }) => {
      const calls: GatewayCall[] = [];
      const replies = new Map<string, string>();
      callGatewayMock.mockImplementation(async (request: GatewayCall) => {
        calls.push(request);
        if (request.method === "agent") {
          const runId = `run-${replies.size + 1}`;
          const params = agentParams(request);
          replies.set(
            runId,
            params.extraSystemPrompt?.includes("Agent-to-agent reply step")
              ? params.sessionKey === requesterKey
                ? "pong-1"
                : "pong-2"
              : "initial",
          );
          return { runId, status: "accepted" };
        }
        if (request.method === "agent.wait") {
          return {
            status: "ok",
            terminalReply: {
              disposition: "visible",
              text: replies.get(String(request.params?.runId)),
            },
          };
        }
        if (request.method === "sessions.list" && hydrated) {
          return {
            sessions: [
              {
                key: targetKey,
                agentId: "main",
                deliveryContext: {
                  channel: "whatsapp",
                  to,
                  accountId: "work",
                  threadId: 99,
                },
              },
            ],
          };
        }
        return {};
      });
      await agentStepTesting.setDepsForTest({
        agentCommandFromIngress: async () => ({
          payloads: [{ text: "announce now", mediaUrl: null }],
          meta: { durationMs: 1 },
        }),
      });
      const tool = getSessionTool("sessions_send", {
        agentSessionKey: requesterKey,
        agentChannel: requesterChannel,
      });
      const waited = await tool.execute("ping-pong", {
        sessionKey: targetKey,
        message: "ping",
        timeoutSeconds: 1,
      });
      expect(waited.details).toMatchObject({
        status: "ok",
        reply: "initial",
        delivery: { status: "pending", mode: "announce" },
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
      await continuations.settle();
      const agentCalls = calls.filter((call) => call.method === "agent");
      expect(agentCalls).toHaveLength(6);
      for (const call of agentCalls) {
        const params = agentParams(call);
        expect(params.message).toContain("[Inter-session message");
        expect(params.message).toContain("isUser=false");
        expect(params.lane).toMatch(/^nested(?::|$)/);
        expect(params.channel).toBe("webchat");
        expect(params.inputProvenance?.kind).toBe("inter_session");
        expect(params.inputProvenance?.sourceRole).toBeUndefined();
      }
      const requesterStep = {
        agentId: "main",
        sessionKey: requesterKey,
        inputProvenance: {
          sourceSessionKey: targetKey,
          sourceChannel: targetChannel,
          sourceTool: "sessions_send",
        },
        extraSystemPrompt: expect.stringContaining("Current agent: Agent 1 (requester)."),
      };
      const targetStep = {
        agentId: targetAgentId,
        sessionKey: targetKey,
        inputProvenance: {
          sourceSessionKey: requesterKey,
          sourceChannel: requesterChannel,
          sourceTool: "sessions_send",
        },
        extraSystemPrompt: expect.stringContaining("Current agent: Agent 2 (target)."),
      };
      const repliesSent = agentCalls.filter((call) =>
        agentParams(call).extraSystemPrompt?.includes("Agent-to-agent reply step"),
      );
      expect(repliesSent.map((step) => step.params)).toMatchObject([
        { ...requesterStep, message: expect.stringContaining("initial") },
        { ...targetStep, message: expect.stringContaining("pong-1") },
        { ...requesterStep, message: expect.stringContaining("pong-2") },
        { ...targetStep, message: expect.stringContaining("pong-1") },
        { ...requesterStep, message: expect.stringContaining("pong-2") },
      ]);
      const announcements = calls.filter((call) => call.method === "send");
      expect(announcements).toHaveLength(1);
      expect(announcements[0]?.params).toMatchObject({
        to,
        channel: targetChannel,
        message: "announce now",
        ...(hydrated ? { accountId: "work", threadId: "99" } : {}),
      });
    },
  );

  registerSessionsSendLateReplyTests({
    getSessionTool: (name, options) =>
      getSessionTool(name, { ...options, config: cloneTestConfig() }),
    callGatewayMock,
    settleContinuations: () => continuations.settle(),
  });

  it.each([
    {
      name: "runtime rejection",
      key: "agent:leasing-ops:cron:monthly-utility:run:run-fast",
      rejects: true,
      reason: "runtime_rejected",
    },
    {
      name: "delivery mode mismatch",
      key: "agent:leasing-ops:cron:monthly-utility:run:run-fast",
      deliveryMode: "automatic" as const,
      reason: "source_reply_delivery_mode_mismatch",
    },
    {
      name: "non-Cron run-looking key",
      key: "agent:leasing-ops:slack:channel:c-room:run:run-fast",
      streaming: false,
      reason: "not_streaming",
    },
  ])(
    "rejects $name without durable-session fallback",
    async ({ key, rejects, deliveryMode, streaming, reason }) => {
      const queueMessage = activeRun(key, {
        rejects,
        streaming,
        sourceReplyDeliveryMode: deliveryMode,
      });
      mockGatewayResponses({
        agent: { runId: "fallback-run", status: "accepted", acceptedAt: 2000 },
      });
      const result = await getSessionTool("sessions_send", {
        agentSessionKey: "agent:re-portal:main",
        agentChannel: "telegram",
        config: cloneTestConfig(),
      }).execute("active-send", {
        sessionKey: key,
        message: "[TASK-COMPLETE] occupancy ready",
        timeoutSeconds: 0,
      });
      expect(result.details).toMatchObject({
        status: "error",
        sessionKey: key,
        error: expect.stringContaining(`queue_message_failed reason=${reason}`),
      });
      expect(callGatewayMock.mock.calls.some(([request]) => request.method === "agent")).toBe(
        false,
      );
      if (rejects) {
        expect(result.details).toHaveProperty(
          "error",
          expect.stringContaining("caller-active-session"),
        );
        expect(result.details).toHaveProperty(
          "error",
          expect.not.stringContaining("fallback_failed"),
        );
        const queuedText = queueMessage.mock.calls[0]?.[0];
        expect(queuedText).toContain("[Inter-session message]");
        expect(queuedText).toContain("[TASK-COMPLETE] occupancy ready");
        expect(queueMessage).toHaveBeenCalledWith(queuedText, {
          steeringMode: "all",
          debounceMs: 0,
          deliveryTimeoutMs: 30_000,
          waitForTranscriptCommit: true,
          sourceReplyDeliveryMode: "message_tool_only",
          userTurnTranscriptRecorder: expect.any(Object),
        });
      } else {
        expect(queueMessage).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { name: "steers into its running child", steered: true },
    { name: "starts the same child after no_active_run", rejection: "no_active_run" as const },
    { name: "starts the same child after stale_run", rejection: "stale_run" as const },
    { name: "starts the same child after not_streaming", rejection: "not_streaming" as const },
    { name: "rejects other steering failures", rejection: "runtime_rejected" as const },
    { name: "starts an explicit followup", mode: "followup" as const },
    { name: "starts a waited turn", timeoutSeconds: 1 },
    { name: "starts an idle child", idle: true },
  ])("sessions_send $name", async ({ steered, rejection, mode, timeoutSeconds = 0, idle }) => {
    const requesterKey = "agent:main:main";
    const targetKey = "agent:main:subagent:steering-child";
    const sessionId = "own-child-active-session";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: targetKey },
      { sessionId, updatedAt: 1, spawnedBy: requesterKey, spawnDepth: 1 },
    );
    const queueMessage = idle ? undefined : activeRun(targetKey, { sessionId });
    const queue = vi.spyOn(embeddedRuns, "queueEmbeddedAgentMessageWithOutcomeAsync");
    const prepare = vi.spyOn(sessionsSendFollowup, "prepareSessionsSendFollowup");
    try {
      if (rejection) {
        queue.mockResolvedValueOnce({
          queued: false,
          sessionId,
          reason: rejection,
          gatewayHealth: "live",
        });
      }
      mockGatewayResponses({
        agent: { runId: "child-followup", status: "accepted" },
        "agent.wait": { status: "ok", terminalReply: { disposition: "empty" } },
      });
      const result = await getSessionTool("sessions_send", {
        agentSessionKey: requesterKey,
      }).execute("child-send", {
        sessionKey: targetKey,
        message: "deps are ready",
        timeoutSeconds,
        mode,
      });
      const failed = rejection === "runtime_rejected";
      expect(result.details).toMatchObject(
        timeoutSeconds > 0
          ? { status: "no_reply", sessionKey: targetKey }
          : failed
            ? { status: "error", sessionKey: targetKey, error: expect.stringContaining(rejection) }
            : {
                status: "accepted",
                sessionKey: targetKey,
                targetDisposition: steered ? "steered" : "queued",
                delivery: { status: steered ? "skipped" : "pending", mode: "announce" },
              },
      );
      const attempts = steered || rejection ? 1 : 0;
      expect(queue).toHaveBeenCalledTimes(attempts);
      if (attempts) {
        expect(queue).toHaveBeenCalledWith(sessionId, expect.stringContaining("deps are ready"), {
          steeringMode: "all",
          debounceMs: 0,
          deliveryTimeoutMs: 30_000,
          waitForTranscriptCommit: true,
          sourceReplyDeliveryMode: "message_tool_only",
          userTurnTranscriptRecorder: expect.any(Object),
        });
      }
      if (steered) {
        expect(queueMessage).toHaveBeenCalledOnce();
      }
      const agentCalls = callGatewayMock.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(agentCalls).toHaveLength(steered || failed ? 0 : 1);
      expect(prepare).toHaveBeenCalledTimes(steered || failed ? 0 : 1);
      if (agentCalls.length) {
        expect(agentCalls[0]?.[0].params).toMatchObject({ sessionKey: targetKey });
        expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
          callGatewayMock.mock.invocationCallOrder[
            callGatewayMock.mock.calls.findIndex(([request]) => request.method === "agent")
          ]!,
        );
      }
    } finally {
      await continuations.settle();
      queue.mockRestore();
      prepare.mockRestore();
    }
  });

  it("sessions_send keeps ordinary active session targets on the gateway agent path", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const ordinaryActiveKey = "agent:main:main";
    const queueMessage = activeRun(ordinaryActiveKey, {
      sessionId: "ordinary-active-session",
      sourceReplyDeliveryMode: "automatic",
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "ordinary-agent-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: cloneTestConfig(),
    });

    const result = await tool.execute("call-ordinary-active", {
      sessionKey: ordinaryActiveKey,
      message: "ordinary active target should stay gateway routed",
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "ordinary-agent-run",
      sessionKey: ordinaryActiveKey,
    });
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentParams(agentCalls[0] ?? {}).sessionKey).toBe(ordinaryActiveKey);
  });

  it("sessions_send falls back from stranded cron run key to durable cron parent", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:cron:source-job:run:source-run";
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const durableCronCallerKey = "agent:leasing-ops:cron:monthly-utility";
    const dir = tempDirs.make("openclaw-cron-fallback-stores-");
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
    const queueMessage = activeRun(runScopedCallerKey, { streaming: false });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "durable-fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return {
          runId: "durable-fallback-run",
          status: "ok",
          terminalReply: { disposition: "empty" },
        };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "telegram",
      config: {
        ...cloneTestConfig(),
        session: { store: path.join(dir, "agents", "{agentId}", "sessions", "sessions.json") },
      },
    });

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "durable-fallback-run",
      sessionKey: runScopedCallerKey,
    });
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    const params = agentParams(agentCalls[0] ?? {});
    expect(params.sessionKey).toBe(durableCronCallerKey);
    expect(params.message).toContain("[Inter-session message]");
    expect(params.message).toContain("[TASK-COMPLETE] re-portal occupancy ready");
    await continuations.settle();
    expect(calls.find((call) => call.method === "agent.wait")?.params).toMatchObject({
      runId: "durable-fallback-run",
    });
    expect(calls.filter((call) => call.method === "chat.history")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
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
    const tmpDir = tempDirs.make("openclaw-exact-cron-send-");
    const storePath = path.join(tmpDir, "sessions.json");
    const requesterKey = "agent:main:main";
    const runScopedTargetKey = "agent:leasing-ops:cron:monthly-utility:run:run-exact";
    const targetSessionId = "exact-cron-run-incarnation";
    try {
      await upsertSessionEntryCore(
        { agentId: "leasing-ops", sessionKey: runScopedTargetKey, storePath },
        { sessionId: targetSessionId, updatedAt: 1 },
      );
      const queueMessage = activeRun(runScopedTargetKey, {
        sessionId: targetSessionId,
        streaming: false,
      });
      const calls: GatewayCall[] = [];
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as GatewayCall;
        calls.push(request);
        if (request.method === "sessions.list") {
          return {
            path: storePath,
            sessions: [{ key: runScopedTargetKey, kind: "direct" }],
          };
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
        config: {
          ...cloneTestConfig(),
          session: {
            ...cloneTestConfig().session,
            store: storePath,
          },
        },
        callGateway: callGatewayMock,
      });

      const result = await tool.execute("exact-cron-send", {
        sessionKey: runScopedTargetKey,
        message: "do not reroute this exact message",
        timeoutSeconds: 0,
      });

      expect(result.details).toMatchObject({
        status: "error",
        sessionKey: runScopedTargetKey,
      });
      expect(queueMessage).not.toHaveBeenCalled();
      expect(calls.some((call) => call.method === "agent")).toBe(false);
    } finally {
      await closeOpenClawAgentDatabasesAsync(tmpDir);
    }
  });

  registerSessionsSendTimeoutTests({ getSessionTool, callGatewayMock });

  it("sessions_send preserves delivery evidence for post-start agent errors", async () => {
    const targetKey = "agent:director1:main";
    mockGatewayResponses({
      agent: { runId: "run-error", status: "accepted", acceptedAt: 2000 },
      "agent.wait": { runId: "run-error", status: "error", error: "agent failed" },
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    });

    const result = await tool.execute("call-error", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(result.details).toMatchObject({
      status: "error",
      error: "agent failed",
      sentBeforeError: true,
      sessionKey: targetKey,
    });
  });

  it("sessions_history resolves sessionId inputs", async () => {
    const sessionId = "sess-group";
    const targetKey = "agent:main:discord:channel:1457165743010611293";
    mockGatewayResponses({
      "sessions.resolve": {
        key: targetKey,
      },
      "chat.history": {
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      },
    });

    const tool = getSessionTool("sessions_history");

    const result = await tool.execute("call5", { sessionKey: sessionId });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toStrictEqual([
      {
        content: [{ text: "ok", type: "text" }],
        role: "assistant",
      },
    ]);
    const historyCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "chat.history",
    );
    expect(historyCall?.[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: targetKey },
    });
  });

  it("sessions_history enforces a hard byte cap even when a single message is huge", async () => {
    mockGatewayResponses({
      "chat.history": {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            extra: "x".repeat(200_000),
          },
        ],
      },
    });

    const tool = getSessionTool("sessions_history");

    const result = await tool.execute("call4c", {
      sessionKey: "main",
      includeTools: true,
    });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      droppedMessages?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
      bytes?: number;
    };
    expect(details.truncated).toBe(true);
    expect(details.droppedMessages).toBe(true);
    expect(details.contentTruncated).toBe(false);
    expect(details.contentRedacted).toBe(false);
    expect(typeof details.bytes).toBe("number");
    expect((details.bytes ?? 0) <= 80 * 1024).toBe(true);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
