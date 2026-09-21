import "./openclaw-tools.sessions.mocks.test-support.js";
import "./test-helpers/fast-openclaw-tools-sessions.js";
// Verifies sessions list/history/send behavior across gateway and channel targets.
import fs from "node:fs";
import os from "node:os";
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
  drainSystemEventEntries,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { createSessionVisibilityChecker } from "../plugin-sdk/session-visibility.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../process/gateway-work-admission.test-helpers.js";
import { isCompletionReportInputProvenance } from "../sessions/input-provenance.js";
import { disposeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import { setActiveEmbeddedRun } from "./embedded-agent-runner/runs.js";
import { testing as embeddedRunsTesting } from "./embedded-agent-runner/runs.test-support.js";
import { registerSessionsSendResumeTests } from "./openclaw-tools.sessions-resume.test-support.js";
import {
  observeSessionSendContinuations,
  registerSessionsSendPendingErrorTest,
  registerSessionsSendTimeoutTests,
} from "./openclaw-tools.sessions-timeout.test-support.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";
import { compactToolOutputHint, toolSchemaDeclaration } from "./tool-schema-hints.js";
import { testing as agentStepTesting } from "./tools/agent-step.test-support.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSearchTool } from "./tools/sessions-search-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const { callGatewayMock, loadSessionEntryByKeyMock } =
  await import("./openclaw-tools.sessions.mocks.test-support.js");

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

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean) {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

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
  // Registry stubs expose enough channel target resolution for session-send tests.
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord",
            docsPath: "/channels/discord",
            blurb: "Discord test stub.",
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp",
            docsPath: "/channels/whatsapp",
            blurb: "WhatsApp test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]),
  );
}

function createOpenClawTools(options?: {
  agentSessionKey?: string;
  agentChannel?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}) {
  // Sessions tests exercise the related tools as a small local bundle.
  const config = options?.config ?? TEST_CONFIG;
  const gatewayCall = (opts: unknown) => callGatewayMock(opts);
  return [
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
    createSessionsSearchTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel as never,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
  ];
}

function getSessionTool(
  name: "sessions_list" | "sessions_history" | "sessions_search" | "sessions_send",
  options?: Parameters<typeof createOpenClawTools>[0],
) {
  const tool = createOpenClawTools(options).find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`missing ${name} tool`);
  }
  return tool;
}

function cloneTestConfig() {
  return { ...TEST_CONFIG, session: { ...TEST_CONFIG.session } };
}

const waitForCalls = async (getCount: () => number, count: number, timeoutMs = 2000) => {
  await vi.waitFor(
    () => {
      expect(getCount()).toBeGreaterThanOrEqual(count);
    },
    { timeout: timeoutMs, interval: 5 },
  );
};

type GatewayCall = {
  method?: string;
  params?: Record<string, unknown>;
};

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

type SessionsSendDetails = {
  status?: string;
  runId?: string;
  reply?: string;
  error?: string;
  sentBeforeError?: boolean;
  sessionKey?: string;
  targetDisposition?: string;
  delivery?: {
    status?: string;
    mode?: string;
  };
};

function requireGatewayCall(call: unknown, method: string): GatewayCall {
  const request = call as GatewayCall | undefined;
  if (request?.method !== method) {
    throw new Error(`expected ${method} gateway call`);
  }
  return request;
}

function agentParams(call: { params?: unknown }): AgentCallParams {
  return (call.params ?? {}) as AgentCallParams;
}

function expectInterSessionAgentCall(call: { params?: unknown }): void {
  // Inter-session sends should be marked as nested non-user agent calls.
  const params = agentParams(call);
  expect(params.message).toContain("[Inter-session message");
  expect(params.message).toContain("isUser=false");
  expect(params.lane).toMatch(/^nested(?::|$)/);
  expect(params.channel).toBe("webchat");
  expect(params.inputProvenance?.kind).toBe("inter_session");
}

function sessionsSendDetails(details: unknown): SessionsSendDetails {
  return details as SessionsSendDetails;
}

describe("sessions tools", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    callGatewayMock.mockClear();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    loadSessionEntryByKeyMock.mockReset();
    loadSessionEntryByKeyMock.mockReturnValue(undefined);
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
    loadSessionEntryByKeyMock,
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
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "active-target",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "automatic",
        abort: () => {},
      },
      targetKey,
    );
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

  it("uses integer schemas for session count and window parameters", () => {
    const tools = createOpenClawTools();
    const byName = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`missing ${name} tool`);
      }
      return tool;
    };

    const schemaProp = (toolName: string, prop: string) => {
      const tool = byName(toolName);
      const schema = tool.parameters as {
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();

      const properties = schema.properties ?? {};
      const value = properties[prop] as { type?: unknown } | undefined;
      if (!value) {
        throw new Error(`missing ${toolName} schema prop: ${prop}`);
      }
      return value;
    };
    const hasSchemaProp = (toolName: string, prop: string) => {
      const tool = byName(toolName);
      const schema = tool.parameters as {
        properties?: Record<string, unknown>;
      };
      return Object.hasOwn(schema.properties ?? {}, prop);
    };

    expect(schemaProp("sessions_history", "limit").type).toBe("integer");
    expect(schemaProp("sessions_history", "messageId").type).toBe("string");
    expect(schemaProp("sessions_history", "sessionId").type).toBe("string");
    expect(schemaProp("sessions_search", "limit").type).toBe("integer");
    expect(schemaProp("sessions_list", "limit").type).toBe("integer");
    expect(schemaProp("sessions_list", "activeMinutes").type).toBe("integer");
    expect(schemaProp("sessions_list", "messageLimit").type).toBe("integer");
    expect(schemaProp("sessions_list", "label").type).toBe("string");
    expect(schemaProp("sessions_list", "agentId").type).toBe("string");
    expect(schemaProp("sessions_list", "search").type).toBe("string");
    expect(schemaProp("sessions_list", "includeDerivedTitles").type).toBe("boolean");
    expect(schemaProp("sessions_list", "includeLastMessage").type).toBe("boolean");
    expect(schemaProp("sessions_send", "message").type).toBe("string");
    expect(hasSchemaProp("sessions_send", "SendMessage")).toBe(false);
    expect(hasSchemaProp("sessions_send", "content")).toBe(false);
    expect(hasSchemaProp("sessions_send", "text")).toBe(false);
    expect(schemaProp("sessions_send", "timeoutSeconds").type).toBe("integer");
    const sendRequired =
      (byName("sessions_send").parameters as { required?: string[] }).required ?? [];
    expect(sendRequired).toContain("message");
  });

  it.each([
    { alias: "SendMessage", value: "hello from SendMessage" },
    { alias: "content", value: "hello from content" },
    { alias: "text", value: "hello from text" },
  ])("sessions_send prepares hidden $alias alias before validation", ({ alias, value }) => {
    const tool = getSessionTool("sessions_send");
    if (!tool.prepareArguments) {
      throw new Error("sessions_send missing prepareArguments");
    }

    const prepared = tool.prepareArguments({
      sessionKey: "main",
      [alias]: value,
      timeoutSeconds: 0,
    }) as Record<string, unknown>;

    expect(prepared.message).toBe(value);
    expect(prepared[alias]).toBeUndefined();
  });

  it.each([
    { alias: "SendMessage", value: "hello from SendMessage" },
    { alias: "content", value: "hello from content" },
    { alias: "text", value: "hello from text" },
  ])("sessions_send normalizes $alias alias to message", async ({ alias, value }) => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-alias", status: "accepted" };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send");

    const result = await tool.execute("call-alias", {
      sessionKey: "main",
      [alias]: value,
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details).status).toBe("accepted");
    const agentCall = callGatewayMock.mock.calls
      .map((call) => call[0] as GatewayCall)
      .find((call) => call.method === "agent");
    expect(agentCall).toBeDefined();
    expect(agentParams(agentCall ?? {}).message).toContain(value);
  });

  it("sessions_send sanitizes formatted reasoning from aliases", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-alias", status: "accepted" };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send");

    const result = await tool.execute("call-alias", {
      sessionKey: "main",
      SendMessage: "Reasoning:\n_internal plan_\n\nVisible answer",
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details).status).toBe("accepted");
    const agentCall = callGatewayMock.mock.calls
      .map((call) => call[0] as GatewayCall)
      .find((call) => call.method === "agent");
    expect(agentCall).toBeDefined();
    expect(agentParams(agentCall ?? {}).message).toContain("Visible answer");
    expect(agentParams(agentCall ?? {}).message).not.toContain("internal plan");
  });

  it("sessions_send prepares sanitized aliases without exposing alias keys", () => {
    const tool = getSessionTool("sessions_send");
    if (!tool.prepareArguments) {
      throw new Error("missing sessions_send prepareArguments");
    }

    const prepared = tool.prepareArguments({
      sessionKey: "main",
      SendMessage: "Reasoning:\n_internal plan_\n\nVisible answer",
      timeoutSeconds: 0,
    }) as Record<string, unknown>;

    expect(prepared.message).toBe("Visible answer");
    expect(prepared.SendMessage).toBeUndefined();
  });

  it("sessions_list forwards mailbox filters and includes messages", async () => {
    const storePath = path.join(tempDirs.make("openclaw-sessions-mailbox-"), "sessions.json");
    const sessions = [
      {
        key: "agent:main:main",
        kind: "direct",
        classification: "main",
        sessionId: "s-main",
        updatedAt: 10,
        lastChannel: "whatsapp",
        derivedTitle: "Main mailbox",
        lastMessagePreview: "Latest assistant update",
      },
      {
        key: "agent:main:discord:group:dev",
        kind: "group",
        classification: "group",
        peerKind: "group",
        sessionId: "s-group",
        updatedAt: 11,
        channel: "discord",
        displayName: "discord:g-dev",
        status: "running",
        startedAt: 100,
        runtimeMs: 42,
        estimatedCostUsd: 0.0042,
        childSessions: ["agent:main:subagent:worker"],
        derivedTitle: "Dev room",
        lastMessagePreview: "Need review on the patch",
      },
      {
        key: "agent:main:dashboard:child",
        kind: "direct",
        classification: "dashboard",
        sessionId: "s-dashboard-child",
        updatedAt: 12,
        parentSessionKey: "agent:main:main",
      },
      {
        key: "agent:main:subagent:worker",
        kind: "direct",
        classification: "subagent",
        sessionId: "s-subagent-worker",
        updatedAt: 13,
        spawnedBy: "agent:main:main",
      },
      {
        key: "agent:main:cron:job-1",
        kind: "direct",
        classification: "cron",
        sessionId: "s-cron",
        updatedAt: 9,
      },
      { key: "global", kind: "global", classification: "global", agentId: "main" },
      { key: "unknown", kind: "unknown", classification: "unknown", agentId: "main" },
    ];
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      if (request.method === "sessions.list") {
        return { path: storePath, sessions };
      }
      if (request.method === "sessions.describe") {
        return { session: sessions.find((session) => session.key === request.params?.key) ?? null };
      }
      if (request.method === "chat.history") {
        return {
          messages: [{ role: "toolResult", content: [] }, textAssistant("hi")],
        };
      }
      return {};
    });

    const tool = getSessionTool("sessions_list");

    const result = await tool.execute("call1", {
      agentId: "main",
      label: "mailbox",
      search: "review",
      includeDerivedTitles: true,
      includeLastMessage: true,
      messageLimit: 1,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "sessions.list",
      params: {
        activeMinutes: undefined,
        activeOnly: false,
        agentId: "main",
        archived: false,
        creatorId: undefined,
        excludeSubagents: false,
        group: undefined,
        ownerId: undefined,
        pinned: undefined,
        profileRelation: undefined,
        projectId: undefined,
        workspaceDir: undefined,
        includeDerivedTitles: false,
        includeLastMessage: false,
        includeGlobal: true,
        includeUnknown: true,
        label: "mailbox",
        limit: 200,
        offset: 0,
        search: "review",
        spawnedBy: undefined,
      },
    });
    const details = result.details as {
      sessions?: Array<{
        key?: string;
        agentId?: string;
        channel?: string;
        derivedTitle?: string;
        lastMessagePreview?: string;
        status?: string;
        childSessions?: string[];
        parentSessionKey?: string;
        messages?: Array<{ role?: string }>;
      }>;
    };
    expect(details.sessions).toHaveLength(5);
    const main = details.sessions?.find((s) => s.key === "agent:main:main");
    expect(main?.agentId).toBe("main");
    expect(main?.channel).toBe("whatsapp");
    expect(main?.derivedTitle).toBe("Main mailbox");
    expect(main?.lastMessagePreview).toBe("Latest assistant update");
    expect(main?.messages?.length).toBe(1);
    expect(main?.messages?.[0]?.role).toBe("assistant");

    const group = details.sessions?.find((s) => s.key === "agent:main:discord:group:dev");
    expect(group?.status).toBe("running");
    expect(group?.childSessions).toEqual(["agent:main:subagent:worker"]);
    expect(group?.derivedTitle).toBe("Dev room");
    expect(group?.lastMessagePreview).toBe("Need review on the patch");

    const dashboardChild = details.sessions?.find((s) => s.key === "agent:main:dashboard:child");
    expect(dashboardChild?.parentSessionKey).toBe("agent:main:main");

    const subagentWorker = details.sessions?.find((s) => s.key === "agent:main:subagent:worker");
    expect(subagentWorker?.parentSessionKey).toBe("agent:main:main");

    const cronOnly = await tool.execute("call2", { kinds: ["cron"] });
    const cronDetails = cronOnly.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    expect(cronDetails.sessions).toHaveLength(1);
    expect(cronDetails.sessions?.[0]?.kind).toBe("cron");
  });

  it("requests mailbox previews only after agent visibility filtering", async () => {
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      if (request.method === "sessions.list") {
        expect(request.params?.includeDerivedTitles).toBe(false);
        expect(request.params?.includeLastMessage).toBe(false);
        return {
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              classification: "main",
              sessionId: "visible",
              updatedAt: 20,
            },
            {
              key: "agent:other:main",
              kind: "direct",
              classification: "main",
              sessionId: "hidden",
              updatedAt: 21,
            },
          ],
        };
      }
      if (request.method === "sessions.describe") {
        expect(request.params).toEqual({
          key: "agent:main:main",
          agentId: "main",
          includeDerivedTitles: true,
          includeLastMessage: true,
        });
        return {
          session: {
            key: "agent:main:main",
            sessionId: "visible",
            derivedTitle: "Visible project kickoff",
            lastMessagePreview: "Visible latest reply",
          },
        };
      }
      return {};
    });

    const tool = getSessionTool("sessions_list", {
      agentSessionKey: "agent:main:main",
      config: {
        ...TEST_CONFIG,
        tools: {
          sessions: { visibility: "agent" },
          agentToAgent: { enabled: false },
        },
      } as OpenClawConfig,
    });

    const result = await tool.execute("call-preview", {
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    const details = result.details as { sessions?: Array<Record<string, unknown>> };
    expect(details.sessions).toStrictEqual([
      {
        key: "agent:main:main",
        sessionId: "visible",
        agentId: "main",
        kind: "main",
        channel: "unknown",
        archived: false,
        pinned: false,
        derivedTitle: "Visible project kickoff",
        lastMessagePreview: "Visible latest reply",
        updatedAt: 20,
      },
    ]);
    expect(
      callGatewayMock.mock.calls
        .map(([request]) => request as GatewayCall)
        .filter((request) => request.method === "sessions.describe")
        .map((request) => request.params?.key),
    ).toEqual(["agent:main:main"]);
    expect(JSON.stringify(details.sessions)).not.toContain("Hidden");
  });

  it("sessions_list exposes lifecycle identity without transcript paths", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "(multiple)",
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              classification: "main",
              sessionId: "sess-main",
              updatedAt: 12,
            },
          ],
        };
      }
      return {};
    });

    const tool = getSessionTool("sessions_list");

    const result = await tool.execute("call2b", {});
    const details = result.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    const main = details.sessions?.find((session) => session.key === "agent:main:main");
    expect(main).not.toHaveProperty("transcriptPath");
    expect(main).toHaveProperty("sessionId", "sess-main");
  });

  it("sessions_history filters tool messages by default", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            {
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              content: [{ type: "text", text: "mirrored" }],
            },
            {
              role: "assistant",
              provider: "openclaw",
              model: "gateway-injected",
              content: [{ type: "text", text: "injected" }],
            },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
          ],
        };
      }
      return {};
    });

    const tool = getSessionTool("sessions_history");

    const result = await tool.execute("call3", { sessionKey: "main" });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toHaveLength(3);
    expect(details.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "gateway-injected" }),
    );
    expect(details.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );

    const withTools = await tool.execute("call4", {
      sessionKey: "main",
      includeTools: true,
    });
    const withToolsDetails = withTools.details as { messages?: unknown[] };
    expect(withToolsDetails.messages).toHaveLength(4);
    expect(withToolsDetails.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
    expect(withToolsDetails.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "gateway-injected" }),
    );
  });

  it("sessions_history caps oversized payloads and strips tool-owned heavy fields", async () => {
    const oversized = Array.from({ length: 80 }, (_, idx) => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `${String(idx)}:${"x".repeat(5000)}`,
        },
        {
          type: "thinking",
          thinking: "y".repeat(7000),
        },
      ],
      details: {
        giant: "z".repeat(12000),
      },
      usage: {
        input: 1,
        output: 1,
      },
    }));
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return { messages: oversized };
      }
      return {};
    });

    const tool = getSessionTool("sessions_history");

    const result = await tool.execute("call4b", {
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
    expect(details.contentTruncated).toBe(true);
    expect(details.contentRedacted).toBe(false);
    expect(typeof details.bytes).toBe("number");
    expect((details.bytes ?? 0) <= 80 * 1024).toBe(true);
    expect(details.messages && details.messages.length > 0).toBe(true);

    const first = details.messages?.[0] as
      | {
          details?: unknown;
          usage?: unknown;
          content?: Array<{
            type?: string;
            text?: string;
            thinking?: string;
          }>;
        }
      | undefined;
    expect(first?.details).toBeUndefined();
    expect(first?.usage).toBeUndefined();
    const textBlock = first?.content?.find((block) => block.type === "text");
    expect(typeof textBlock?.text).toBe("string");
    expect((textBlock?.text ?? "").length <= 4015).toBe(true);
    const thinkingBlock = first?.content?.find((block) => block.type === "thinking");
    expect((thinkingBlock?.thinking ?? "").length <= 4015).toBe(true);
  });

  it("sessions_history enforces a hard byte cap even when a single message is huge", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              extra: "x".repeat(200_000),
            },
          ],
        };
      }
      return {};
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

  it("sessions_history sets contentRedacted when sensitive data is redacted", async () => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [textAssistant("Use sk-1234567890abcdef1234 to authenticate with the API.")],
        };
      }
      return {};
    });

    const tool = getSessionTool("sessions_history");

    const result = await tool.execute("call-redact-1", { sessionKey: "main" });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
    };
    expect(details.contentRedacted).toBe(true);
    expect(details.contentTruncated).toBe(false);
    expect(details.truncated).toBe(false);
    const msg = details.messages?.[0] as { content?: Array<{ type?: string; text?: string }> };
    const textBlock = msg?.content?.find((b) => b.type === "text");
    expect(typeof textBlock?.text).toBe("string");
    expect(textBlock?.text).not.toContain("sk-1234567890abcdef1234");
  });

  it("sessions_history sets both contentRedacted and contentTruncated independently", async () => {
    callGatewayMock.mockReset();
    const longPrefix = "safe text ".repeat(420);
    const sensitiveText = `${longPrefix} sk-9876543210fedcba9876 end`;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: sensitiveText }],
            },
          ],
        };
      }
      return {};
    });

    const tool = getSessionTool("sessions_history");

    const result = await tool.execute("call-redact-2", { sessionKey: "main" });
    const details = result.details as {
      truncated?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
    };
    expect(details.contentRedacted).toBe(true);
    expect(details.contentTruncated).toBe(true);
    expect(details.truncated).toBe(true);
  });

  it("sessions_history resolves sessionId inputs", async () => {
    const sessionId = "sess-group";
    const targetKey = "agent:main:discord:channel:1457165743010611293";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return {
          key: targetKey,
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        };
      }
      return {};
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
    const request = requireGatewayCall(historyCall?.[0], "chat.history");
    expect(request.params?.sessionKey).toBe(targetKey);
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

  it("sessions_send supports fire-and-forget and wait", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let waitCallCount = 0;
    let sendCallCount = 0;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as { message?: string; sessionKey?: string } | undefined;
        const message = params?.message ?? "";
        let reply = "REPLY_SKIP";
        if (message.includes("ping") || message.includes("wait")) {
          reply = "done";
        } else if (message.includes("Agent-to-agent announce step.")) {
          reply = "ANNOUNCE_SKIP";
        } else if (params?.sessionKey === requesterKey) {
          reply = "pong";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 1234 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        waitCallCount += 1;
        const params = request.params as { runId?: string } | undefined;
        const runId = params?.runId ?? "run-1";
        return {
          runId,
          status: "ok",
          terminalReply: { disposition: "visible", text: replyByRunId.get(runId) },
        };
      }
      if (request.method === "send") {
        sendCallCount += 1;
        return { messageId: "m1" };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    });

    const fire = await tool.execute("call5", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });
    const fireDetails = sessionsSendDetails(fire.details);
    expect(fireDetails.status).toBe("accepted");
    expect(fireDetails.runId).toBe("run-1");
    expect(fireDetails.targetDisposition).toBe("queued");
    expect(fireDetails.delivery?.status).toBe("pending");
    expect(fireDetails.delivery?.mode).toBe("announce");
    await waitForCalls(() => agentCallCount, 3);
    await waitForCalls(() => waitCallCount, 3);

    const waitPromise = tool.execute("call6", {
      sessionKey: "main",
      message: "wait",
      timeoutSeconds: 1,
    });
    const waited = await waitPromise;
    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("done");
    expect(waitedDetails.delivery?.status).toBe("pending");
    expect(waitedDetails.delivery?.mode).toBe("announce");
    expect(typeof (waited.details as { runId?: string }).runId).toBe("string");
    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, fire.details)).toBe(true);
    expect(Value.Check(tool.outputSchema!, waited.details)).toBe(true);
    expect(
      Value.Check(tool.outputSchema!, {
        runId: "run-no-reply",
        status: "no_reply",
        sessionKey: "agent:main:other",
        message: "Target session completed without a visible reply.",
      }),
    ).toBe(true);
    expect(
      Value.Check(tool.outputSchema!, {
        runId: "run-invalid-ok",
        status: "ok",
        sessionKey: "agent:main:other",
        delivery: { status: "pending", mode: "announce" },
      }),
    ).toBe(false);
    expect(
      Value.Check(tool.outputSchema!, {
        runId: "run-error",
        status: "forbidden",
        error: "hidden",
      }),
    ).toBe(true);
    expect(
      Value.Check(tool.outputSchema!, {
        runId: "run-error",
        status: "error",
        error: "failed",
        extra: true,
      }),
    ).toBe(false);
    // Six result variants exceed the compact catalog budget; full tool discovery
    // and Code Mode must still describe every outcome without guessing fields.
    expect(compactToolOutputHint(tool.outputSchema)).toBeUndefined();
    const declaration = toolSchemaDeclaration(tool.outputSchema);
    expect(declaration).not.toBe("unknown");
    expect(declaration).toContain('durability: "process"');
    expect(declaration).toContain("runStarted: false");
    expect(declaration).toContain('status: "queued"');
    expect(declaration).toContain('targetDisposition: "queued" | "steered"');
    expect(declaration).toContain('status: "no_reply"');
    expect(declaration).toContain('status: "timeout"');
    await waitForCalls(() => agentCallCount, 6);
    await waitForCalls(() => waitCallCount, 6);

    const agentCalls = calls.filter((call) => call.method === "agent");
    const waitCalls = calls.filter((call) => call.method === "agent.wait");
    const historyOnlyCalls = calls.filter((call) => call.method === "chat.history");
    expect(agentCalls).toHaveLength(6);
    for (const call of agentCalls) {
      expectInterSessionAgentCall(call);
    }
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent message context",
          ),
      ),
    ).toBe(true);
    const initialAgentCall = agentCalls.find((call) =>
      agentParams(call).extraSystemPrompt?.includes("Agent-to-agent message context"),
    );
    const initialAgentParams = agentParams(initialAgentCall ?? {});
    expect(initialAgentParams.extraSystemPrompt).toContain(
      "Agent 1 (requester) session: <REQUESTER_SESSION>.",
    );
    expect(initialAgentParams.extraSystemPrompt).toContain("Agent 1 (requester) channel: discord.");
    expect(initialAgentParams.extraSystemPrompt).toContain(
      "Agent 2 (target) session: <TARGET_SESSION>.",
    );
    expect(initialAgentParams.extraSystemPrompt).not.toContain(requesterKey);
    expect(initialAgentParams.inputProvenance).toMatchObject({
      kind: "inter_session",
      sourceSessionKey: requesterKey,
      sourceChannel: "discord",
      sourceTool: "sessions_send",
    });
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent reply step",
          ),
      ),
    ).toBe(true);
    expect(waitCalls).toHaveLength(6);
    expect(historyOnlyCalls).toHaveLength(0);
    expect(sendCallCount).toBe(0);
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
    await vi.waitFor(() => {
      expect(waitObserved).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(deliveredMessages).toEqual([marker]);
    expect(callGatewayMock.mock.calls.some(([request]) => request.method === "chat.history")).toBe(
      false,
    );
  });

  it("keeps scoped sends from creating post-return work or durable watches", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scoped-session-send-"));
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records the admitted target on the waited-send branch", async () => {
    const targetSessionKey = "agent:main:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method === "agent") {
        return { runId: "run-waited-audit", status: "accepted", acceptedAt: 1 };
      }
      if (request.method === "agent.wait") {
        return {
          runId: request.params?.runId,
          status: "ok",
          terminalReply: { disposition: "silent" },
        };
      }
      return {};
    });
    const decisionWork: ExecutionDecisionWork[] = [];
    const clearDecisionSink = configureExecutionDecisionWorkSink((work) => {
      decisionWork.push(work);
      return true;
    });
    const token = createExecutionIdentityAdmissionToken("waited-session-send", {
      contextId: "waited-session-send-context",
      executionId: "waited-session-send-execution",
    });
    const tool = getSessionTool("sessions_send", {
      agentSessionKey: "agent:main:dashboard:requester",
      config: TEST_CONFIG,
    });
    try {
      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:dashboard:requester",
          executionIdentityToken: token,
          receiptAuthority: () => true,
        },
        async () =>
          await tool.execute("waited-send-audit", {
            sessionKey: targetSessionKey,
            message: "wait without reply-back",
            timeoutSeconds: 1,
          }),
      );

      expect(result.details).toMatchObject({ status: "no_reply", sessionKey: targetSessionKey });
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
    }
  });

  it.each([
    { timeoutSeconds: 0, admitted: true },
    { timeoutSeconds: 1, admitted: true },
    { timeoutSeconds: 0, admitted: false },
    { timeoutSeconds: 1, admitted: false },
  ])(
    "records exactly one cross-agent contribution at the original prompt time only after admission (timeoutSeconds: $timeoutSeconds, admitted: $admitted)",
    async ({ timeoutSeconds, admitted }) => {
      const storeTemplate = path.join(
        tempDirs.make("openclaw-session-send-participant-"),
        "agents/{agentId}/agent/openclaw-agent.sqlite",
      );
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "research" });
      const scope = { agentId: "research", sessionKey: "agent:research:main", storePath };
      const sessionId = "participant-target";
      const promptedAt = 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(promptedAt);
      try {
        await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
        callGatewayMock.mockImplementation(async (opts: unknown) => {
          const request = opts as GatewayCall;
          if (request.method === "sessions.resolve") {
            return { key: scope.sessionKey, agentId: scope.agentId };
          }
          if (request.method === "agent") {
            clock.mockReturnValue(promptedAt + 100);
            if (!admitted) {
              throw new Error("admission rejected");
            }
            return { runId: "participant-run", status: "accepted" };
          }
          if (request.method === "agent.wait") {
            return { status: "ok" };
          }
          return { messages: [] };
        });
        const tool = createSessionsSendTool({
          agentSessionKey: "agent:main:main",
          expectedTargetSessionId: sessionId,
          config: { ...TEST_CONFIG, session: { ...TEST_CONFIG.session, store: storeTemplate } },
          callGateway: callGatewayMock,
        });
        const result = await tool.execute("participant-send", {
          sessionKey: scope.sessionKey,
          message: "Review this input",
          timeoutSeconds,
        });
        expect(result.details).toMatchObject(
          admitted
            ? { status: timeoutSeconds === 0 ? "accepted" : "no_reply", runId: "participant-run" }
            : { status: "error", error: "admission rejected" },
        );
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? []).toEqual(
          admitted
            ? [
                {
                  identity: { type: "agent", id: "main" },
                  contributionCount: 1,
                  firstPromptedAt: promptedAt,
                  lastPromptedAt: promptedAt,
                },
              ]
            : [],
        );
      } finally {
        clock.mockRestore();
        disposeOpenClawAgentDatabaseByPath(storePath);
      }
    },
  );

  registerSessionsSendPendingErrorTest({
    getSessionTool,
    callGatewayMock,
    settleContinuations: () => continuations.settle(),
  });

  it("sessions_send resolves sessionId inputs", async () => {
    const sessionId = "sess-send";
    const targetKey = "agent:main:discord:channel:123";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return { key: targetKey };
      }
      if (request.method === "agent") {
        return { runId: "run-1", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        return { status: "ok", terminalReply: { disposition: "empty" } };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: "main",
      agentChannel: "discord",
    });

    const result = await tool.execute("call7", {
      sessionKey: sessionId,
      message: "ping",
      timeoutSeconds: 0,
    });
    const details = result.details as { status?: string };
    expect(details.status).toBe("accepted");
    const agentCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    const request = requireGatewayCall(agentCall?.[0], "agent");
    expect(request.params?.sessionKey).toBe(targetKey);
  });

  it("sessions_send runs ping-pong then announces", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "agent:main:whatsapp:group:req";
    const targetKey = "agent:director1:discord:group:target";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = agentParams(request);
        let reply = "initial";
        if (params.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = params.sessionKey === requesterKey ? "pong-1" : "pong-2";
        }
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted" };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        const runId = params?.runId ?? "run-1";
        return {
          runId,
          status: "ok",
          terminalReply: { disposition: "visible", text: replyByRunId.get(runId) },
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
      agentChannel: "whatsapp",
    });

    const waited = await tool.execute("call7", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("initial");
    await waitForCalls(() => countMatching(calls, (call) => call.method === "send"), 1);

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(6);
    for (const call of agentCalls) {
      const params = agentParams(call);
      expect(params.lane).toMatch(/^nested(?::|$)/);
      expect(params.channel).toBe("webchat");
      expect(params.inputProvenance?.kind).toBe("inter_session");
      expect(params.inputProvenance?.sourceRole).toBeUndefined();
    }

    const replySteps = agentCalls.filter((call) =>
      agentParams(call).extraSystemPrompt?.includes("Agent-to-agent reply step"),
    );
    expect(replySteps).toHaveLength(5);
    const requesterStep = {
      agentId: "main",
      sessionKey: requesterKey,
      inputProvenance: {
        sourceSessionKey: targetKey,
        sourceChannel: "discord",
        sourceTool: "sessions_send",
      },
      extraSystemPrompt: expect.stringContaining("Current agent: Agent 1 (requester)."),
    };
    const targetStep = {
      agentId: "director1",
      sessionKey: targetKey,
      inputProvenance: {
        sourceSessionKey: requesterKey,
        sourceChannel: "whatsapp",
        sourceTool: "sessions_send",
      },
      extraSystemPrompt: expect.stringContaining("Current agent: Agent 2 (target)."),
    };
    expect(replySteps.map((step) => step.params)).toMatchObject([
      { ...requesterStep, message: expect.stringContaining("initial") },
      { ...targetStep, message: expect.stringContaining("pong-1") },
      { ...requesterStep, message: expect.stringContaining("pong-2") },
      { ...targetStep, message: expect.stringContaining("pong-1") },
      { ...requesterStep, message: expect.stringContaining("pong-2") },
    ]);
    const announcements = calls.filter((call) => call.method === "send");
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.params).toMatchObject({
      to: "group:target",
      channel: "discord",
      message: "announce now",
    });
  });

  it.each<{
    targetKind: string;
    targetKey: string;
    spawned: boolean;
    timeoutSeconds?: number;
    pendingError?: boolean;
    failure?: string;
    stopReason?: string;
    cronRequester?: boolean;
  }>([
    { targetKind: "peer", targetKey: "agent:director1:main", spawned: false },
    { targetKind: "visible child", targetKey: "agent:director1:dashboard:child", spawned: true },
    { targetKind: "hidden child", targetKey: "agent:director1:subagent:child", spawned: true },
    {
      targetKind: "nonblocking child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      timeoutSeconds: 0,
    },
    {
      targetKind: "retrying child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      pendingError: true,
    },
    {
      targetKind: "failed child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      failure: "child run failed",
    },
    {
      targetKind: "failed retrying child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      pendingError: true,
      failure: "child retry exhausted",
    },
    {
      targetKind: "cancelled child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      failure: "child run cancelled",
      stopReason: "aborted",
    },
    ...["dashboard", "subagent"].flatMap((kind) =>
      [0, 1].flatMap((timeoutSeconds) =>
        [false, true].map((failed) => ({
          targetKind: `${kind} child of Cron, timeout=${timeoutSeconds}, failed=${failed}`,
          targetKey: `agent:director1:${kind}:child`,
          spawned: true,
          cronRequester: true,
          timeoutSeconds,
          failure: failed ? "Cron child run failed" : undefined,
        })),
      ),
    ),
  ])(
    "sessions_send delivers the late reply from a $targetKind after the parent root releases",
    async ({
      targetKey,
      spawned,
      timeoutSeconds = 1,
      pendingError,
      failure,
      stopReason,
      cronRequester = false,
    }) => {
      const calls: Array<{ method?: string; params?: unknown }> = [];
      const requesterKey = cronRequester ? "agent:main:cron:job:run:once" : "agent:main:main";
      if (spawned) {
        await upsertSessionEntryCore(
          { agentId: "director1", sessionKey: targetKey },
          { sessionId: "child-session", updatedAt: 1, spawnedBy: requesterKey, spawnDepth: 1 },
        );
      }
      let targetWaitCount = 0;
      let releaseDelayedWait = () => {};
      const delayedWaitGate = new Promise<void>((resolve) => {
        releaseDelayedWait = resolve;
      });
      let requesterProviderStarts = 0;
      let requesterAdmissionClosed: boolean | undefined;
      let finalAnnounceProviderStarts = 0;
      let finalAnnounceAdmissionClosed: boolean | undefined;
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: unknown };
        calls.push(request);
        if (request.method === "agent") {
          const params = request.params as { sessionKey?: string } | undefined;
          if (params?.sessionKey === targetKey) {
            return { runId: "run-target", status: "accepted", acceptedAt: 2000 };
          }
          if (params?.sessionKey === requesterKey) {
            requesterAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
            if (requesterAdmissionClosed) {
              throw new GatewayDrainingError();
            }
            requesterProviderStarts += 1;
            return { runId: "run-requester", status: "accepted", acceptedAt: 2001 };
          }
        }
        if (request.method === "agent.wait") {
          const params = request.params as { runId?: string } | undefined;
          if (params?.runId === "run-target") {
            targetWaitCount += 1;
            if (timeoutSeconds !== 0 && targetWaitCount === 1) {
              return {
                runId: "run-target",
                status: "timeout",
                ...(pendingError ? { pendingError: true, error: "retrying provider" } : {}),
              };
            }
            await delayedWaitGate;
            if (failure) {
              return { runId: "run-target", status: "error", error: failure, stopReason };
            }
            return {
              runId: "run-target",
              status: "ok",
              terminalReply: { disposition: "visible", text: "late director reply" },
            };
          }
          if (params?.runId === "run-requester") {
            return {
              runId: "run-requester",
              status: "ok",
              terminalReply: { disposition: "visible", text: "requester saw director" },
            };
          }
        }
        return {};
      });
      await agentStepTesting.setDepsForTest({
        agentCommandFromIngress: async (opts) => {
          expect(opts.sessionKey).toBe(targetKey);
          expect(opts.extraSystemPrompt).toContain("Agent-to-agent announce step");
          finalAnnounceAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
          if (finalAnnounceAdmissionClosed) {
            throw new GatewayDrainingError();
          }
          finalAnnounceProviderStarts += 1;
          return {
            payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
            meta: { durationMs: 1 },
          };
        },
      });

      const tool = getSessionTool("sessions_send", {
        agentSessionKey: requesterKey,
        agentChannel: "discord",
        config: cloneTestConfig(),
      });

      const result = await runWithGatewayRootWorkAdmissionForTest(() =>
        tool.execute("call-delayed", {
          sessionKey: targetKey,
          message: "ping",
          timeoutSeconds,
        }),
      );
      const details = sessionsSendDetails(result.details);
      expect(details.status).toBe(pendingError ? "timeout" : "accepted");
      expect(details.sessionKey).toBe(targetKey);
      if (!pendingError) {
        expect(details.targetDisposition).toBe("queued");
      }
      expect(details.delivery?.status).toBe("pending");
      expect(details.delivery?.mode).toBe("announce");
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(requesterProviderStarts).toBe(0);
      releaseDelayedWait();

      if (!cronRequester) {
        await vi.waitFor(
          () => {
            expect(requesterAdmissionClosed).toBe(false);
          },
          { timeout: 2_000, interval: 5 },
        );
      }
      await vi.waitFor(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
      expect(requesterProviderStarts).toBe(cronRequester ? 0 : spawned ? 1 : 3);

      const requesterReplyCall = calls.find(
        (call) =>
          call.method === "agent" &&
          (call.params as { sessionKey?: string } | undefined)?.sessionKey === requesterKey,
      );
      if (cronRequester) {
        expect(requesterReplyCall).toBeUndefined();
        expect(requesterAdmissionClosed).toBeUndefined();
        expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
      } else {
        const replyParams = requesterReplyCall?.params as
          | {
              extraSystemPrompt?: string;
              inputProvenance?: { sourceSessionKey?: string; sourceRole?: string };
              message?: string;
              sessionKey?: string;
            }
          | undefined;
        expect(replyParams?.sessionKey).toBe(requesterKey);
        expect(replyParams?.inputProvenance?.sourceSessionKey).toBe(targetKey);
        expect(replyParams?.message).toContain(failure ?? "late director reply");
        expect(replyParams?.inputProvenance?.sourceRole).toBe(spawned ? "subagent" : undefined);
        expect(
          isCompletionReportInputProvenance(replyParams?.inputProvenance),
          "requested child results use the completion boundary so parent answers remain visible",
        ).toBe(spawned);
        if (spawned) {
          expect(replyParams?.extraSystemPrompt).not.toContain("REPLY_SKIP");
        } else {
          expect(replyParams?.extraSystemPrompt).toContain("Agent-to-agent reply step");
          expect(replyParams?.extraSystemPrompt).toContain("Current agent: Agent 1 (requester)");
        }
      }
      expect(calls.find((call) => call.method === "send")).toBeUndefined();
      const announces = !spawned || (cronRequester && !failure);
      expect(finalAnnounceAdmissionClosed).toBe(announces ? false : undefined);
      expect(finalAnnounceProviderStarts).toBe(announces ? 1 : 0);
    },
  );

  it("sessions_send reports active-run queue rejection without durable-session fallback", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:re-portal:main";
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const queueMessage = vi.fn(async (_text: string, _options?: unknown) => {
      throw new Error("active session ended before queued steering message was committed");
    });
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "telegram",
      config: cloneTestConfig(),
    });

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(details.error).toContain("queue_message_failed reason=runtime_rejected");
    expect(details.error).toContain("caller-active-session");
    expect(details.error).not.toContain("fallback_failed");
    const queuedText = queueMessage.mock.calls[0]?.[0];
    expect(queuedText).toContain("[Inter-session message]");
    expect(queuedText).toContain("[TASK-COMPLETE] re-portal occupancy ready");
    expect(queueMessage).toHaveBeenCalledWith(queuedText, {
      steeringMode: "all",
      debounceMs: 0,
      deliveryTimeoutMs: 30_000,
      waitForTranscriptCommit: true,
      sourceReplyDeliveryMode: "message_tool_only",
      userTurnTranscriptRecorder: expect.any(Object),
    });
    expect(calls.some((call) => call.method === "agent")).toBe(false);
  });

  it("sessions_send reports source reply delivery mode mismatch without durable-session fallback", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "automatic",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: cloneTestConfig(),
    });

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(details.error).toContain(
      "queue_message_failed reason=source_reply_delivery_mode_mismatch",
    );
    expect(queueMessage).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "agent")).toBe(false);
  });

  it("sessions_send keeps ordinary active session targets on the gateway agent path", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const ordinaryActiveKey = "agent:main:main";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "ordinary-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "automatic",
        abort: () => {},
      },
      ordinaryActiveKey,
    );
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

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.runId).toBe("ordinary-agent-run");
    expect(details.sessionKey).toBe(ordinaryActiveKey);
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
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => false,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
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

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.runId).toBe("durable-fallback-run");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    const params = agentParams(agentCalls[0] ?? {});
    expect(params.sessionKey).toBe(durableCronCallerKey);
    expect(params.message).toContain("[Inter-session message]");
    expect(params.message).toContain("[TASK-COMPLETE] re-portal occupancy ready");
    await waitForCalls(() => countMatching(calls, (call) => call.method === "agent.wait"), 1);
    expect(calls.find((call) => call.method === "agent.wait")?.params).toMatchObject({
      runId: "durable-fallback-run",
    });
    expect(calls.filter((call) => call.method === "chat.history")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exact-cron-send-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const requesterKey = "agent:main:main";
    const runScopedTargetKey = "agent:leasing-ops:cron:monthly-utility:run:run-exact";
    const targetSessionId = "exact-cron-run-incarnation";
    const queueMessage = vi.fn(async () => {});
    try {
      await upsertSessionEntryCore(
        { agentId: "leasing-ops", sessionKey: runScopedTargetKey, storePath },
        { sessionId: targetSessionId, updatedAt: 1 },
      );
      setActiveEmbeddedRun(
        targetSessionId,
        {
          queueMessage,
          isStreaming: () => false,
          isCompacting: () => false,
          supportsTranscriptCommitWait: true,
          sourceReplyDeliveryMode: "message_tool_only",
          abort: () => {},
        },
        runScopedTargetKey,
      );
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

      expect(sessionsSendDetails(result.details)).toMatchObject({
        status: "error",
        sessionKey: runScopedTargetKey,
      });
      expect(queueMessage).not.toHaveBeenCalled();
      expect(calls.some((call) => call.method === "agent")).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sessions_send rejects non-cron run-looking keys without durable-session fallback", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const runScopedCallerKey = "agent:leasing-ops:slack:channel:c-room:run:run-fast";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => false,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "durable-fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: cloneTestConfig(),
    });

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(details.error).toContain("queue_message_failed reason=not_streaming");
    expect(queueMessage).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "agent")).toBe(false);
  });

  it("sessions_send reports run-scoped queue admission failures without gateway fallback", async () => {
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const queueMessage = vi.fn(async () => {
      throw new Error("active session ended before queued steering message was committed");
    });
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        throw new Error("gateway request timeout for agent");
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(details.error).toContain("queue_message_failed reason=runtime_rejected");
    expect(details.error).not.toContain("fallback_failed");
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string } | undefined)?.method === "agent",
      ),
    ).toBe(false);
  });

  registerSessionsSendTimeoutTests({ getSessionTool, callGatewayMock });

  it("sessions_send preserves delivery evidence for post-start agent errors", async () => {
    const targetKey = "agent:director1:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-error", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-error", status: "error", error: "agent failed" };
      }
      return {};
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
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.error).toBe("agent failed");
    expect(details.sentBeforeError).toBe(true);
    expect(details.sessionKey).toBe(targetKey);
  });

  it("sessions_send preserves threadId when announce target is hydrated via sessions.list", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const targetKey = "agent:main:worker";
    let sendParams: {
      to?: string;
      channel?: string;
      accountId?: string;
      message?: string;
      threadId?: string;
    } = {};

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              sessionKey?: string;
              extraSystemPrompt?: string;
            }
          | undefined;
        let reply = "initial";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = params.sessionKey === requesterKey ? "pong-1" : "pong-2";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "announce now";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 3000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        const runId = params?.runId ?? "run-1";
        return {
          runId,
          status: "ok",
          terminalReply: { disposition: "visible", text: replyByRunId.get(runId) },
        };
      }
      if (request.method === "sessions.list") {
        return {
          sessions: [
            {
              key: targetKey,
              agentId: "main",
              deliveryContext: {
                channel: "whatsapp",
                to: "123@g.us",
                accountId: "work",
                threadId: 99,
              },
            },
          ],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | {
              to?: string;
              channel?: string;
              accountId?: string;
              message?: string;
              threadId?: string;
            }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          accountId: params?.accountId,
          message: params?.message,
          threadId: params?.threadId,
        };
        return { messageId: "m-threaded-announce" };
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
      agentChannel: "discord",
    });

    const waited = await tool.execute("call-thread", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("initial");
    await vi.waitFor(
      () => {
        expect(countMatching(calls, (call) => call.method === "send")).toBe(1);
      },
      { timeout: 2_000, interval: 5 },
    );

    expect(sendParams.to).toBe("123@g.us");
    expect(sendParams.channel).toBe("whatsapp");
    expect(sendParams.accountId).toBe("work");
    expect(sendParams.message).toBe("announce now");
    expect(sendParams.threadId).toBe("99");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
