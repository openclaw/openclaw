// Verifies sessions list/history/send behavior across gateway and channel targets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSteeringAuthorizationAffinity } from "../auto-reply/reply/steering-authorization-affinity.js";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { createTurnAuthoritySnapshot } from "../plugins/turn-authority.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

const callGatewayMock = vi.fn();
const runtimeIdentityMocks = vi.hoisted(() => {
  const runtimeIdentity = ["signed", "sessions", "send"].join("-");
  const mintRuntimeIdentity = vi.fn(async (_params: unknown) => runtimeIdentity);
  return { mintRuntimeIdentity, runtimeIdentity };
});
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
vi.mock("../gateway/agent-runtime-identity-token.js", () => ({
  async mintAgentRuntimeIdentityToken(params: unknown) {
    return await runtimeIdentityMocks.mintRuntimeIdentity(params);
  },
}));
const loadSessionEntryByKeyMock = vi.fn();
vi.mock("./subagent-announce-delivery.js", () => ({
  loadSessionEntryByKey: (sessionKey: string) => loadSessionEntryByKeyMock(sessionKey),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    session: {
      mainKey: "main",
      scope: "per-sender",
      agentToAgent: { maxPingPongTurns: 2 },
    },
    tools: {
      // Keep sessions tools permissive in this suite; dedicated visibility tests cover defaults.
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true },
    },
  }),
  resolveGatewayPort: () => 18789,
}));

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setActiveEmbeddedRun } from "./embedded-agent-runner/runs.js";
import { testing as embeddedRunsTesting } from "./embedded-agent-runner/runs.test-support.js";
import { compactToolOutputHint } from "./tool-schema-hints.js";
import { testing as agentStepTesting } from "./tools/agent-step.test-support.js";
import { wrapToolWithGatewayCallerIdentity } from "./tools/gateway-caller-context.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { testing as sessionsResolutionTesting } from "./tools/sessions-resolution.test-support.js";
import { createSessionsSearchTool } from "./tools/sessions-search-tool.js";
import { testing as sessionsSendA2ATesting } from "./tools/sessions-send-tool.a2a.test-support.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const TEST_CONFIG = {
  session: {
    mainKey: "main",
    scope: "per-sender",
    agentToAgent: { maxPingPongTurns: 2 },
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
  agentId?: string;
  agentSessionKey?: string;
  agentChannel?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}) {
  // Sessions tests exercise the related tools as a small local bundle.
  const config = options?.config ?? TEST_CONFIG;
  const gatewayCall = (opts: unknown) => callGatewayMock(opts);
  const callerSessionKey = options?.agentSessionKey ?? "agent:main:main";
  const callerAgentId = options?.agentId ?? resolveAgentIdFromSessionKey(callerSessionKey);
  const turnAuthority = createTurnAuthoritySnapshot({
    principal: {
      kind: "sender",
      provider: options?.agentChannel,
      senderId: "maintainer-test-sender",
      senderIsOwner: false,
      isAuthorizedSender: true,
      roleIds: ["maintainers"],
    },
    agentId: callerAgentId,
    sessionKey: callerSessionKey,
    conversationId: "maintenance-test-channel",
    trigger: "channel",
  });
  const sessionsSendTool = wrapToolWithGatewayCallerIdentity(
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel as never,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
    {
      agentId: callerAgentId,
      sessionKey: callerSessionKey,
      turnAuthority,
    },
  );
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
    sessionsSendTool,
  ];
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
  clientName?: string;
  clientDisplayName?: string;
  mode?: string;
  scopes?: string[];
  requireLocalBackendSharedAuth?: boolean;
  agentRuntimeIdentityToken?: string;
};

type AgentCallParams = {
  agentId?: string;
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
  };
};

type SessionsSendDetails = {
  status?: string;
  runId?: string;
  reply?: string;
  error?: string;
  sentBeforeError?: boolean;
  sessionKey?: string;
  watched?: boolean;
  delivery?: {
    status?: string;
    mode?: string;
  };
};

function projectedSessionsSendReplyHistory(params: {
  runId: string | undefined;
  text: string | undefined;
  seq?: number;
}): unknown[] {
  if (!params.runId || !params.text) {
    return [];
  }
  const seq = params.seq ?? 1;
  const idempotencyKey = `${params.runId}:user`;
  return [
    {
      role: "assistant",
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      content: [{ type: "text", text: "forwarded request" }],
      idempotencyKey,
      __openclaw: { idempotencyKey, seq },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: params.text }],
      timestamp: 20,
      __openclaw: { seq: seq + 1 },
    },
  ];
}

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
  beforeEach(() => {
    callGatewayMock.mockClear();
    runtimeIdentityMocks.mintRuntimeIdentity.mockClear();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    loadSessionEntryByKeyMock.mockReset();
    loadSessionEntryByKeyMock.mockReturnValue(undefined);
    installMessagingTestRegistry();
    agentStepTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsResolutionTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsSendA2ATesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
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
    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }
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

  it("sessions_send fails closed without ambient issued turn authority", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      config: TEST_CONFIG,
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });

    const result = await tool.execute("call-missing-authority", {
      sessionKey: "agent:target:main",
      message: "hello",
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "error",
      error: "sessions_send requires trusted turn authority",
    });
    expect(runtimeIdentityMocks.mintRuntimeIdentity).not.toHaveBeenCalled();
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string } | undefined)?.method === "agent",
      ),
    ).toBe(false);
  });

  it("sessions_send preserves both agent identities across global-session dispatch", async () => {
    let historyCallCount = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as GatewayCall;
      if (request.method === "sessions.resolve") {
        return { key: "global" };
      }
      if (request.method === "chat.history") {
        historyCallCount += 1;
        return {
          messages:
            historyCallCount === 1
              ? []
              : projectedSessionsSendReplyHistory({
                  runId: "run-global-target",
                  text: "[NO_REPLY]",
                }),
        };
      }
      if (request.method === "agent") {
        return { runId: "run-global-target", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-global-target", status: "ok" };
      }
      return {};
    });
    const globalConfig = {
      ...TEST_CONFIG,
      agents: {
        list: [{ id: "source", default: true }, { id: "target" }],
      },
      session: {
        ...TEST_CONFIG.session,
        scope: "global" as const,
        agentToAgent: { maxPingPongTurns: 0 },
      },
    } satisfies OpenClawConfig;
    const tool = createOpenClawTools({
      agentId: "source",
      agentSessionKey: "global",
      agentChannel: "discord",
      config: globalConfig,
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-global-target", {
      agentId: "target",
      message: "check target",
      timeoutSeconds: 1,
      watch: true,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "ok",
      reply: "[NO_REPLY]",
      watched: false,
    });
    const calls = callGatewayMock.mock.calls.map((call) => call[0] as GatewayCall);
    const agentCall = calls.find((call) => call.method === "agent");
    expect(agentParams(agentCall ?? {})).toMatchObject({
      sessionKey: "global",
      agentId: "target",
      lane: "nested:agent:target:global",
    });
    const historyCalls = calls.filter((call) => call.method === "chat.history");
    expect(historyCalls).toHaveLength(2);
    expect(historyCalls.every((call) => call.params?.agentId === "target")).toBe(true);
    expect(runtimeIdentityMocks.mintRuntimeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "source",
        sessionKey: "global",
        sessionsSendDelegation: expect.objectContaining({
          targetAgentId: "target",
          targetSessionKey: "global",
          request: expect.objectContaining({ sessionKey: "global", agentId: "target" }),
        }),
      }),
    );
  });

  it("sessions_send rejects synchronous self-send in one agent global session", async () => {
    const tool = createOpenClawTools({
      agentId: "source",
      agentSessionKey: "global",
      config: {
        ...TEST_CONFIG,
        agents: { list: [{ id: "source", default: true }] },
        session: { ...TEST_CONFIG.session, scope: "global" },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-global-self", {
      agentId: "source",
      message: "self",
      timeoutSeconds: 1,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "error",
      error: expect.stringContaining("cannot target the calling session"),
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("sessions_send scopes label lookup to the caller agent unless agentId is explicit", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as GatewayCall;
      if (request.method === "sessions.resolve") {
        expect(request.params).toMatchObject({ label: "maintenance", agentId: "source" });
        throw new Error("No session found with label: maintenance");
      }
      return {};
    });
    const tool = createOpenClawTools({
      agentId: "source",
      agentSessionKey: "global",
      config: {
        ...TEST_CONFIG,
        agents: { list: [{ id: "source", default: true }, { id: "target" }] },
        session: { ...TEST_CONFIG.session, scope: "global" },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-global-label", {
      label: "maintenance",
      message: "do not cross stores",
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "error",
      error: "No session found with label: maintenance",
    });
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as GatewayCall | undefined)?.method === "agent",
      ),
    ).toBe(false);
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

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

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

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

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
    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool?.prepareArguments) {
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
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "s-main",
              updatedAt: 10,
              lastChannel: "whatsapp",
              derivedTitle: "Main mailbox",
              lastMessagePreview: "Latest assistant update",
            },
            {
              key: "discord:group:dev",
              kind: "group",
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
              sessionId: "s-dashboard-child",
              updatedAt: 12,
              parentSessionKey: "agent:main:main",
            },
            {
              key: "agent:main:subagent:worker",
              kind: "direct",
              sessionId: "s-subagent-worker",
              updatedAt: 13,
              spawnedBy: "agent:main:main",
            },
            {
              key: "cron:job-1",
              kind: "direct",
              sessionId: "s-cron",
              updatedAt: 9,
            },
            { key: "global", kind: "global" },
            { key: "unknown", kind: "unknown" },
          ],
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_list");
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

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
        agentId: "main",
        archived: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        includeGlobal: true,
        includeUnknown: true,
        label: "mailbox",
        limit: undefined,
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
    const main = details.sessions?.find((s) => s.key === "main");
    expect(main?.agentId).toBe("main");
    expect(main?.channel).toBe("whatsapp");
    expect(main?.derivedTitle).toBe("Main mailbox");
    expect(main?.lastMessagePreview).toBe("Latest assistant update");
    expect(main?.messages?.length).toBe(1);
    expect(main?.messages?.[0]?.role).toBe("assistant");

    const group = details.sessions?.find((s) => s.key === "discord:group:dev");
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

  it("derives mailbox previews only after agent visibility filtering", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-list-preview-"));
    const storePath = path.join(tmpDir, "sessions.json");
    try {
      await upsertSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main", storePath },
        { sessionId: "visible", updatedAt: 20 },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionId: "visible", sessionKey: "agent:main:main", storePath },
        { cwd: tmpDir, message: { role: "user", content: "Visible project kickoff" } },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionId: "visible", sessionKey: "agent:main:main", storePath },
        { cwd: tmpDir, message: { role: "assistant", content: "Visible latest reply" } },
      );
      await upsertSessionEntry(
        { agentId: "other", sessionKey: "agent:other:main", storePath },
        { sessionId: "hidden", updatedAt: 21 },
      );
      await appendTranscriptMessage(
        { agentId: "other", sessionId: "hidden", sessionKey: "agent:other:main", storePath },
        { cwd: tmpDir, message: { role: "user", content: "Hidden cross-agent topic" } },
      );
      await appendTranscriptMessage(
        { agentId: "other", sessionId: "hidden", sessionKey: "agent:other:main", storePath },
        { cwd: tmpDir, message: { role: "assistant", content: "Hidden latest reply" } },
      );

      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: Record<string, unknown> };
        if (request.method === "sessions.list") {
          expect(request.params?.includeDerivedTitles).toBe(false);
          expect(request.params?.includeLastMessage).toBe(false);
          return {
            path: storePath,
            sessions: [
              {
                key: "agent:main:main",
                kind: "direct",
                sessionId: "visible",
                updatedAt: 20,
              },
              {
                key: "agent:other:main",
                kind: "direct",
                sessionId: "hidden",
                updatedAt: 21,
              },
            ],
          };
        }
        return {};
      });

      const tool = createOpenClawTools({
        agentSessionKey: "agent:main:main",
        config: {
          ...TEST_CONFIG,
          tools: {
            sessions: { visibility: "agent" },
            agentToAgent: { enabled: false },
          },
        } as OpenClawConfig,
      }).find((candidate) => candidate.name === "sessions_list");
      if (!tool) {
        throw new Error("missing sessions_list tool");
      }

      const result = await tool.execute("call-preview", {
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      const details = result.details as { sessions?: Array<Record<string, unknown>> };
      expect(details.sessions).toStrictEqual([
        {
          key: "agent:main:main",
          agentId: "main",
          kind: "other",
          channel: "unknown",
          archived: false,
          pinned: false,
          derivedTitle: "Visible project kickoff",
          lastMessagePreview: "Visible latest reply",
          updatedAt: 20,
        },
      ]);
      expect(JSON.stringify(details.sessions)).not.toContain("Hidden");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sessions_list omits transcript paths from model-facing rows", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "(multiple)",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              updatedAt: 12,
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_list");
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

    const result = await tool.execute("call2b", {});
    const details = result.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    const main = details.sessions?.find((session) => session.key === "main");
    expect(main).not.toHaveProperty("transcriptPath");
    expect(main).not.toHaveProperty("sessionId");
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

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

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

  it("sessions_history caps oversized payloads and strips heavy fields", async () => {
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
          thinkingSignature: "sig".repeat(4000),
          openclawReasoningReplay: {
            v: 1,
            source: "openai-responses",
            provider: "openai",
            api: "openai-chatgpt-responses",
            model: "gpt-5.5",
          },
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

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

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
            thinkingSignature?: string;
            openclawReasoningReplay?: unknown;
          }>;
        }
      | undefined;
    expect(first?.details).toBeUndefined();
    expect(first?.usage).toBeUndefined();
    const textBlock = first?.content?.find((block) => block.type === "text");
    expect(typeof textBlock?.text).toBe("string");
    expect((textBlock?.text ?? "").length <= 4015).toBe(true);
    const thinkingBlock = first?.content?.find((block) => block.type === "thinking");
    expect(thinkingBlock?.thinkingSignature).toBeUndefined();
    expect(thinkingBlock?.openclawReasoningReplay).toBeUndefined();
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

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

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
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Use sk-1234567890abcdef1234 to authenticate with the API." },
              ],
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

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

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

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

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

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

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call6", { sessionKey: sessionId });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toMatch(/Session not found|No session found/);
  });

  it("sessions_send supports fire-and-forget and wait", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let historyCallCount = 0;
    let waitCallCount = 0;
    let sendCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const canonicalRequesterKey = `agent:main:${requesterKey}`;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown; expectFinal?: boolean };
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
          ...(request.expectFinal ? { result: { payloads: [{ text: reply }] } } : {}),
        };
      }
      if (request.method === "agent.wait") {
        waitCallCount += 1;
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        historyCallCount += 1;
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: projectedSessionsSendReplyHistory({
            runId: lastWaitedRunId,
            text,
          }),
        };
      }
      if (request.method === "send") {
        sendCallCount += 1;
        return { messageId: "m1" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const fire = await tool.execute("call5", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });
    const fireDetails = sessionsSendDetails(fire.details);
    expect(fireDetails.status).toBe("accepted");
    expect(fireDetails.runId).toBe("run-1");
    expect(fireDetails.delivery?.status).toBe("pending");
    expect(fireDetails.delivery?.mode).toBe("announce");
    await waitForCalls(() => agentCallCount, 3);
    await waitForCalls(() => waitCallCount, 2);
    await waitForCalls(() => historyCallCount, 3);

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
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ error: string; runId: string; status: "error" | "forbidden"; sentBeforeError?: true; sessionKey?: string; watched?: boolean } | { delivery: { mode: "announce"; status: "pending" | "skipped" }; runId: string; sessionKey: string; status: "accepted"; watched?: boolean } | { error: string; runId: string; sentBeforeError: true; sessionKey: string; status: "timeout"; delivery?: { mode: "announce"; status: "pending" | "skipped" }; watched?: boolean } | { delivery: { mode: "announce"; status: "pending" | "skipped" }; runId: string; sessionKey: string; status: "ok"; reply?: string; watched?: boolean }',
    );
    await waitForCalls(() => agentCallCount, 6);
    await waitForCalls(() => waitCallCount, 4);
    await waitForCalls(() => historyCallCount, 6);

    const agentCalls = calls.filter((call) => call.method === "agent");
    const waitCalls = calls.filter((call) => call.method === "agent.wait");
    const historyOnlyCalls = calls.filter((call) => call.method === "chat.history");
    expect(agentCalls).toHaveLength(6);
    for (const call of agentCalls) {
      expectInterSessionAgentCall(call);
      expect(call).toMatchObject({
        clientName: "gateway-client",
        clientDisplayName: "agent",
        mode: "backend",
        scopes: ["operator.write"],
        requireLocalBackendSharedAuth: true,
      });
      expect((call as { agentRuntimeIdentityToken?: string }).agentRuntimeIdentityToken).toBe(
        runtimeIdentityMocks.runtimeIdentity,
      );
    }
    expect(runtimeIdentityMocks.mintRuntimeIdentity).toHaveBeenCalledTimes(6);
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
      sourceSessionKey: canonicalRequesterKey,
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
    expect(waitCalls).toHaveLength(4);
    expect(historyOnlyCalls).toHaveLength(6);
    expect(sendCallCount).toBe(0);
  });

  it("does not announce stale or concurrent replies after a message-tool-only run", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:discord:group:req";
    const targetKey = "agent:worker:discord:group:dev";
    let historyCallCount = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown; expectFinal?: boolean };
      calls.push(request);
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: targetKey, kind: "group" }],
        };
      }
      if (request.method === "chat.history") {
        historyCallCount += 1;
        return {
          messages:
            historyCallCount === 1
              ? [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "stale reply from an earlier run" }],
                    timestamp: 20,
                    __openclaw: { seq: 1 },
                  },
                ]
              : [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "stale reply from an earlier run" }],
                    timestamp: 20,
                    __openclaw: { seq: 1 },
                  },
                  {
                    role: "assistant",
                    provenance: { kind: "inter_session", sourceTool: "sessions_send" },
                    content: [{ type: "text", text: "message-tool-only request" }],
                    idempotencyKey: "run-message-tool-only:user",
                    __openclaw: {
                      idempotencyKey: "run-message-tool-only:user",
                      seq: 2,
                    },
                  },
                  {
                    role: "assistant",
                    provenance: { kind: "inter_session", sourceTool: "sessions_send" },
                    content: [{ type: "text", text: "concurrent request" }],
                    idempotencyKey: "run-concurrent:user",
                    __openclaw: { idempotencyKey: "run-concurrent:user", seq: 3 },
                  },
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "concurrent run reply" }],
                    timestamp: 21,
                    __openclaw: { seq: 4 },
                  },
                ],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-message-tool-only", status: "accepted", acceptedAt: 1234 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-message-tool-only", status: "ok" };
      }
      if (request.method === "send") {
        return { messageId: "unexpected-stale-announce" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-stale-fire-and-forget", {
      sessionKey: targetKey,
      message: "reply through the message tool",
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "accepted",
      delivery: { status: "pending", mode: "announce" },
    });
    await waitForCalls(() => historyCallCount, 2);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentParams(agentCalls[0] ?? {}).sessionKey).toBe(targetKey);
    expect(
      (agentCalls[0]?.params as { sourceReplyDeliveryMode?: string } | undefined)
        ?.sourceReplyDeliveryMode,
    ).toBe("message_tool_only");
    expect(calls.filter((call) => call.method === "send")).toHaveLength(0);
    expect(historyCallCount).toBe(2);
    expect(calls.findIndex((call) => call.method === "chat.history")).toBeLessThan(
      calls.findIndex((call) => call.method === "agent"),
    );
  });

  it("sessions_send returns pending agent error diagnostics on timeout", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown; expectFinal?: boolean };
      calls.push(request);
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      if (request.method === "agent") {
        return {
          runId: "run-pending-model-error",
          status: "accepted",
          acceptedAt: 1234,
        };
      }
      if (request.method === "agent.wait") {
        return {
          runId: "run-pending-model-error",
          status: "timeout",
          error: "429 RESOURCE_EXHAUSTED",
          pendingError: true,
        };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-pending-error", {
      sessionKey: "main",
      message: "check status",
      timeoutSeconds: 1,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("timeout");
    expect(details.error).toBe("429 RESOURCE_EXHAUSTED");
    expect(details.runId).toBe("run-pending-model-error");
    expect(details.sentBeforeError).toBe(true);
    expect(details.delivery?.status).toBe("pending");
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.method === "agent.wait").length).toBeGreaterThanOrEqual(2),
    );
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
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

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
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const targetKey = "discord:group:target";
    let sendParams: { to?: string; channel?: string; message?: string } = {};
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown; expectFinal?: boolean };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              message?: string;
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
          acceptedAt: 2000 + agentCallCount,
          ...(request.expectFinal ? { result: { payloads: [{ text: reply }] } } : {}),
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: projectedSessionsSendReplyHistory({
            runId: lastWaitedRunId,
            text,
          }),
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; channel?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          message: params?.message,
        };
        return { messageId: "m-announce" };
      }
      return {};
    });
    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call7", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("initial");
    await vi.waitFor(
      () => {
        expect(countMatching(calls, (call) => call.method === "agent")).toBe(4);
      },
      { timeout: 2_000, interval: 5 },
    );

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(4);
    for (const call of agentCalls) {
      const params = agentParams(call);
      expect(params.lane).toMatch(/^nested(?::|$)/);
      expect(params.channel).toBe("webchat");
      expect(params.inputProvenance?.kind).toBe("inter_session");
    }

    const replySteps = calls.filter(
      (call) =>
        call.method === "agent" &&
        typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
        (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
          "Agent-to-agent reply step",
        ),
    );
    expect(replySteps).toHaveLength(2);
    expect(sendParams.to).toBe("group:target");
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.message).toBe("announce now");
  });

  it("sessions_send keeps delayed requester replies alive after a wait timeout", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:main";
    const targetKey = "agent:director1:main";
    let targetWaitCount = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown; expectFinal?: boolean };
      calls.push(request);
      if (request.method === "agent") {
        const params = request.params as { sessionKey?: string } | undefined;
        if (params?.sessionKey === targetKey) {
          return { runId: "run-target", status: "accepted", acceptedAt: 2000 };
        }
        if (params?.sessionKey === requesterKey) {
          return { runId: "run-requester", status: "accepted", acceptedAt: 2001 };
        }
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        if (params?.runId === "run-target") {
          targetWaitCount += 1;
          return targetWaitCount === 1
            ? { runId: "run-target", status: "timeout" }
            : { runId: "run-target", status: "ok" };
        }
        if (params?.runId === "run-requester") {
          return { runId: "run-requester", status: "ok" };
        }
      }
      if (request.method === "chat.history") {
        const params = request.params as { sessionKey?: string } | undefined;
        if (params?.sessionKey === targetKey && targetWaitCount > 1) {
          return {
            messages: projectedSessionsSendReplyHistory({
              runId: "run-target",
              text: "late director reply",
            }),
          };
        }
        if (params?.sessionKey === requesterKey) {
          return {
            messages: projectedSessionsSendReplyHistory({
              runId: "run-requester",
              text: "requester saw director",
            }),
          };
        }
        return { messages: [] };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 1 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-delayed", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.sessionKey).toBe(targetKey);
    expect(details.delivery?.status).toBe("pending");
    expect(details.delivery?.mode).toBe("announce");

    await vi.waitFor(
      () => {
        const requesterReplyCall = calls.find(
          (call) =>
            call.method === "agent" &&
            (call.params as { sessionKey?: string } | undefined)?.sessionKey === requesterKey,
        );
        if (!requesterReplyCall) {
          throw new Error("expected requester reply call");
        }
      },
      { timeout: 2_000, interval: 5 },
    );

    const requesterReplyCall = calls.find(
      (call) =>
        call.method === "agent" &&
        (call.params as { sessionKey?: string } | undefined)?.sessionKey === requesterKey,
    );
    const replyParams = requesterReplyCall?.params as
      | {
          extraSystemPrompt?: string;
          inputProvenance?: { sourceSessionKey?: string };
          message?: string;
          sessionKey?: string;
        }
      | undefined;
    expect(replyParams?.sessionKey).toBe(requesterKey);
    expect(replyParams?.inputProvenance?.sourceSessionKey).toBe(targetKey);
    expect(replyParams?.message).toContain("late director reply");
    expect(replyParams?.extraSystemPrompt).toContain("Agent-to-agent reply step");
    expect(replyParams?.extraSystemPrompt).toContain("Current agent: Agent 1 (requester)");
    expect(calls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("sessions_send uses normal admission when the active run lacks attribution", async () => {
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

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.runId).toBe("fallback-run");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentParams(agentCalls[0] ?? {}).sessionKey).toBe(runScopedCallerKey);
  });

  it("sessions_send does not borrow delivery mode from an unattributed active run", async () => {
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

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.runId).toBe("fallback-run");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentParams(agentCalls[0] ?? {}).sessionKey).toBe(runScopedCallerKey);
  });

  it("sessions_send dispatches separately instead of borrowing active sender authority", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const runScopedCallerKey = "agent:molty:cron:maintenance:run:run-fast";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        steeringAuthorizationAffinity: createSteeringAuthorizationAffinity({
          turnAuthority: createTurnAuthoritySnapshot({
            principal: {
              kind: "sender",
              provider: "discord",
              accountId: "molty",
              senderId: "owner",
              senderIsOwner: true,
              isAuthorizedSender: true,
              roleIds: ["owner"],
            },
            agentId: "molty",
            sessionKey: runScopedCallerKey,
            conversationId: "maintenance",
            controllerKey: "sender:discord:molty:owner",
          }),
        }),
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "separate-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:clawsweeper:main",
      agentChannel: "discord",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-cross-authority", {
      sessionKey: runScopedCallerKey,
      message: "inspect the active owner run",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.runId).toBe("separate-run");
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentParams(agentCalls[0] ?? {}).sessionKey).toBe(runScopedCallerKey);
  });

  it("sessions_send queues a matching active run and safely retries transcript-wait support", async () => {
    const targetKey = "agent:molty:cron:maintenance:run:run-fast";
    const queueMessage = vi.fn(async (_text: string, _options?: unknown) => {});
    const targetAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "discord",
        senderId: "maintainer-test-sender",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      },
      agentId: "molty",
      sessionKey: targetKey,
      conversationId: "maintenance-test-channel",
      trigger: "sessions_send",
    });
    setActiveEmbeddedRun(
      "matching-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: false,
        sourceReplyDeliveryMode: "message_tool_only",
        steeringAuthorizationAffinity: createSteeringAuthorizationAffinity({
          turnAuthority: targetAuthority,
        }),
        abort: () => {},
      },
      targetKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      throw new Error(`unexpected Gateway call: ${request.method ?? "unknown"}`);
    });
    const tool = createOpenClawTools({
      agentSessionKey: "agent:source:main",
      agentChannel: "discord",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-matching-active", {
      sessionKey: targetKey,
      message: "continue the exact authorized run",
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "accepted",
      delivery: { status: "skipped", mode: "announce" },
    });
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(queueMessage.mock.calls[0]?.[1]).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      steeringAuthorizationAffinity: expect.any(Object),
    });
    expect(queueMessage.mock.calls[0]?.[1]).not.toHaveProperty("waitForTranscriptCommit");
    expect(runtimeIdentityMocks.mintRuntimeIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["sender", { senderId: "other-maintainer" }],
    ["roles", { roleIds: ["owners"] }],
    ["conversation", { conversationId: "other-channel" }],
    ["thread", { threadId: "other-thread" }],
    ["capability", { capability: "other-active-capability" }],
  ] as const)(
    "sessions_send never queues an active run with changed %s authority",
    async (_label, override) => {
      const targetKey = "agent:molty:cron:maintenance:run:run-fast";
      const queueMessage = vi.fn(async () => {});
      const authorityOverride = override as {
        senderId?: string;
        roleIds?: readonly string[];
        conversationId?: string;
        threadId?: string;
        capability?: string;
      };
      const targetAuthority = createTurnAuthoritySnapshot({
        principal: {
          kind: "sender",
          provider: "discord",
          senderId: authorityOverride.senderId ?? "maintainer-test-sender",
          senderIsOwner: false,
          isAuthorizedSender: true,
          roleIds: authorityOverride.roleIds ?? ["maintainers"],
        },
        agentId: "molty",
        sessionKey: targetKey,
        conversationId: authorityOverride.conversationId ?? "maintenance-test-channel",
        threadId: authorityOverride.threadId,
        capability: authorityOverride.capability,
        trigger: "channel",
      });
      setActiveEmbeddedRun(
        "mismatched-active-session",
        {
          queueMessage,
          isStreaming: () => true,
          isCompacting: () => false,
          supportsTranscriptCommitWait: true,
          sourceReplyDeliveryMode: "message_tool_only",
          steeringAuthorizationAffinity: createSteeringAuthorizationAffinity({
            turnAuthority: targetAuthority,
          }),
          abort: () => {},
        },
        targetKey,
      );
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "chat.history") {
          return { messages: [] };
        }
        if (request.method === "agent") {
          return { runId: "separate-authorized-run", status: "accepted" };
        }
        return {};
      });
      const tool = createOpenClawTools({
        agentSessionKey: "agent:source:main",
        agentChannel: "discord",
        config: {
          ...TEST_CONFIG,
          session: {
            ...TEST_CONFIG.session,
            agentToAgent: { maxPingPongTurns: 0 },
          },
        },
      }).find((candidate) => candidate.name === "sessions_send");
      if (!tool) {
        throw new Error("missing sessions_send tool");
      }

      const result = await tool.execute("call-mismatched-active", {
        sessionKey: targetKey,
        message: "do not borrow this run",
        timeoutSeconds: 0,
      });

      expect(sessionsSendDetails(result.details).status).toBe("accepted");
      expect(queueMessage).not.toHaveBeenCalled();
      expect(
        callGatewayMock.mock.calls.filter(
          (call) => (call[0] as { method?: string } | undefined)?.method === "agent",
        ),
      ).toHaveLength(1);
    },
  );

  it("sessions_send does not reroute an active-run delivery-mode rejection", async () => {
    const targetKey = "agent:molty:cron:maintenance:run:run-fast";
    const queueMessage = vi.fn(async () => {});
    const targetAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "discord",
        senderId: "maintainer-test-sender",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      },
      agentId: "molty",
      sessionKey: targetKey,
      conversationId: "maintenance-test-channel",
      trigger: "channel",
    });
    setActiveEmbeddedRun(
      "mode-mismatch-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "automatic",
        steeringAuthorizationAffinity: createSteeringAuthorizationAffinity({
          turnAuthority: targetAuthority,
        }),
        abort: () => {},
      },
      targetKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });
    const tool = createOpenClawTools({
      agentSessionKey: "agent:source:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-mode-mismatch", {
      sessionKey: targetKey,
      message: "must remain a separate delivery contract",
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "error",
      error: expect.stringContaining("source_reply_delivery_mode_mismatch"),
    });
    expect(queueMessage).not.toHaveBeenCalled();
    expect(runtimeIdentityMocks.mintRuntimeIdentity).not.toHaveBeenCalled();
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

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

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

  it("sessions_send falls back a stranded cron run key through signed parent admission", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:cron:source-job:run:source-run";
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
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
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "existing run reply" }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "agent") {
        return { runId: "durable-fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return { runId: "durable-fallback-run", status: "ok" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

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
    expect(params.sessionKey).toBe("agent:leasing-ops:cron:monthly-utility");
    expect(params.message).toContain("[Inter-session message]");
    expect(params.message).toContain("[TASK-COMPLETE] re-portal occupancy ready");
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
    expect(runtimeIdentityMocks.mintRuntimeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsSendDelegation: expect.objectContaining({
          targetAgentId: "leasing-ops",
          targetSessionKey: "agent:leasing-ops:cron:monthly-utility",
          request: expect.objectContaining({
            sessionKey: "agent:leasing-ops:cron:monthly-utility",
          }),
        }),
      }),
    );
  });

  it("sessions_send surfaces parent-policy denial for a stranded cron run", async () => {
    const targetKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    setActiveEmbeddedRun(
      "stranded-policy-session",
      {
        queueMessage: vi.fn(async () => {}),
        isStreaming: () => false,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      targetKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { sessionKey?: string } };
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      if (request.method === "agent") {
        expect(request.params?.sessionKey).toBe("agent:leasing-ops:cron:monthly-utility");
        throw new Error("parent target blocked by authorization policy");
      }
      return {};
    });
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:cron:source:run:source-run",
      agentChannel: "telegram",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-parent-policy-denied", {
      sessionKey: targetKey,
      message: "deliver only if parent policy passes",
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "error",
      error: "parent target blocked by authorization policy",
    });
    expect(runtimeIdentityMocks.mintRuntimeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsSendDelegation: expect.objectContaining({
          targetSessionKey: "agent:leasing-ops:cron:monthly-utility",
        }),
      }),
    );
  });

  it("sessions_send uses normal admission for non-cron run-looking keys", async () => {
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

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

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
    expect(agentParams(agentCalls[0] ?? {}).sessionKey).toBe(runScopedCallerKey);
  });

  it("sessions_send uses normal admission when an unattributed run lacks transcript wait", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "unattributed-fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.runId).toBe("unattributed-fallback-run");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentParams(agentCalls[0] ?? {}).sessionKey).toBe(runScopedCallerKey);
  });

  it("sessions_send reports normal-admission failure when the active run lacks attribution", async () => {
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

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(details.error).toContain("gateway request timeout for agent");
    expect(queueMessage).not.toHaveBeenCalled();
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string } | undefined)?.method === "agent",
      ),
    ).toBe(true);
  });

  it("sessions_send preserves terminal timeouts without starting A2A", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:main";
    const targetKey = "agent:director1:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-terminal", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return {
          runId: "run-terminal",
          status: "timeout",
          endedAt: 3000,
          stopReason: "timeout",
          error: "agent run timed out",
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-terminal", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("timeout");
    expect(details.error).toBe("agent run timed out");
    expect(details.sentBeforeError).toBe(true);
    expect(details.sessionKey).toBe(targetKey);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(countMatching(calls, (call) => call.method === "agent")).toBe(1);
  });

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
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

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

  it("sessions_send skips duplicate A2A delivery for waited parent-owned native subagents", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:discord:direct:parent";
    const targetKey = "agent:main:subagent:child";
    let historyCallCount = 0;
    loadSessionEntryByKeyMock.mockImplementation((sessionKey: string) =>
      sessionKey === targetKey
        ? {
            sessionId: "child-session",
            updatedAt: 1,
            spawnedBy: requesterKey,
            deliveryContext: {
              channel: "discord",
              to: "direct:parent",
            },
          }
        : undefined,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-child", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-child", status: "ok" };
      }
      if (request.method === "chat.history") {
        historyCallCount += 1;
        return {
          messages:
            historyCallCount === 1
              ? []
              : projectedSessionsSendReplyHistory({
                  runId: "run-child",
                  text: "child reply",
                }),
        };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call-parent-owned-native-subagent", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });

    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("child reply");
    expect(waitedDetails.delivery?.status).toBe("skipped");
    expect(waitedDetails.delivery?.mode).toBe("announce");
    expect(countMatching(calls, (call) => call.method === "agent")).toBe(1);
    const replyPromptAgentCalls = calls.filter(
      (call) =>
        call.method === "agent" &&
        typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
        (call.params as { extraSystemPrompt?: string }).extraSystemPrompt?.includes(
          "Agent-to-agent reply step",
        ),
    );
    expect(replyPromptAgentCalls).toStrictEqual([]);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send preserves threadId when announce target is hydrated via sessions.list", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
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
      const request = opts as { method?: string; params?: unknown; expectFinal?: boolean };
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
          ...(request.expectFinal ? { result: { payloads: [{ text: reply }] } } : {}),
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: projectedSessionsSendReplyHistory({
            runId: lastWaitedRunId,
            text,
          }),
        };
      }
      if (request.method === "sessions.list") {
        return {
          sessions: [
            {
              key: targetKey,
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
    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

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
