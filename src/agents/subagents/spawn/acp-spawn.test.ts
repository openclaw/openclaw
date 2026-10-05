import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/** Tests ACP spawn planning, policy gates, bindings, cleanup, and parent stream setup. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { markAcpTurnActive } from "../../../acp/control-plane/active-turns.js";
import type { AcpInitializeSessionInput } from "../../../acp/control-plane/manager.types.js";
import { testing as acpRuntimeRegistryTesting } from "../../../acp/runtime/registry.js";
import { createExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.shared.js";
import { getLoadedChannelPluginForRead } from "../../../channels/plugins/registry-loaded.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentity } from "../../../gateway/agent-runtime-identity-token.js";
import { readInProcessAgentRuntimeIdentity } from "../../../gateway/in-process-agent-runtime-identity.js";
import type { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingServiceTesting,
  type SessionBindingAdapter,
  type SessionBindingPlacement,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../../utils/delivery-context.shared.js";
import { createOperationalRunInstanceRef } from "../../admitted-run-context.js";
import { reserveChildAdmissionSlot } from "../../child-admission.js";
import { expectRecordFields } from "../../subagent-test-fixtures.test-helpers.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { registerAcpSpawnPolicyTests } from "./acp-spawn-policy.test-support.js";
import { withParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import {
  expectRegisteredSubagentRun,
  firstMockCall,
  latestMockCall,
} from "./subagent-spawn.test-helpers.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

function createDefaultSpawnConfig(): OpenClawConfig {
  return {
    acp: { enabled: true, backend: "acpx", allowedAgents: ["codex"] },
    agents: { defaults: { subagents: { allowAgents: ["codex"], maxSpawnDepth: 2 } } },
    session: {
      mainKey: "main",
      scope: "per-sender",
      threadBindings: { enabled: true, spawnSessions: true },
    },
  };
}

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  sessionBindingBindMock: vi.fn(),
  sessionBindingUnbindMock: vi.fn(),
  sessionBindingResolveByConversationMock: vi.fn(),
  sessionBindingListBySessionMock: vi.fn(),
  closeSessionMock: vi.fn(),
  initializeSessionMock: vi.fn(),
  getAcpSessionManagerMock: vi.fn(),
  startAcpSpawnParentStreamRelayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  readAcpResumeSessionOwnerMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
  areHeartbeatsEnabledMock: vi.fn(),
  cleanupFailedAcpSpawnMock: vi.fn(),
  closeRuntimeOnFailureMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  countActiveRunsForSessionMock: vi.fn(),
  getSubagentRunByChildSessionKeyMock: vi.fn(),
  upsertSessionEntryMock: vi.fn(),
  normalizeChannelIdMock: vi.fn((channelId: string) => channelId.trim().toLowerCase() || null),
  state: { cfg: createDefaultSpawnConfig() },
}));

vi.mock("../../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: hoisted.getAcpSessionManagerMock,
}));

vi.mock("../../../acp/control-plane/spawn.js", () => ({
  cleanupFailedAcpSpawn: hoisted.cleanupFailedAcpSpawnMock,
}));

vi.mock("../../../acp/runtime/session-meta-resume.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../acp/runtime/session-meta-resume.js")>()),
  readAcpResumeSessionOwner: (params: unknown) => hoisted.readAcpResumeSessionOwnerMock(params),
}));

vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) => getLoadedChannelPluginForRead(channelId),
  getLoadedChannelPlugin: (channelId: string) => getLoadedChannelPluginForRead(channelId),
  normalizeChannelId: hoisted.normalizeChannelIdMock,
}));

vi.mock("../../../channels/plugins/registry.js", () => ({
  getChannelPlugin: (channelId: string) => getLoadedChannelPluginForRead(channelId),
  getLoadedChannelPlugin: (channelId: string) => getLoadedChannelPluginForRead(channelId),
  normalizeChannelId: hoisted.normalizeChannelIdMock,
}));

vi.mock("../../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: hoisted.resolveStorePathMock,
}));

vi.mock("../../../config/sessions/session-accessor.js", async () => {
  const { createAcpSpawnStoreMocks } = await import("./acp-spawn-store.test-support.js");
  return createAcpSpawnStoreMocks(hoisted).accessor;
});

vi.mock("../../../config/sessions/session-entry-read-runtime.js", async () => {
  const { createAcpSpawnStoreMocks } = await import("./acp-spawn-store.test-support.js");
  return createAcpSpawnStoreMocks(hoisted).readRuntime;
});

vi.mock("../../../gateway/session-utils-store-worker.js", async () => {
  const { createAcpSpawnStoreMocks } = await import("./acp-spawn-store.test-support.js");
  return createAcpSpawnStoreMocks(hoisted).workerLookup;
});

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: () => hoisted.state.cfg,
}));

vi.mock("../../../gateway/call.js", () => ({
  callGateway: hoisted.callGatewayMock,
}));

vi.mock("../../../infra/heartbeat-wake.js", () => ({
  areHeartbeatsEnabled: hoisted.areHeartbeatsEnabledMock,
}));

vi.mock("./acp-spawn-parent-stream.js", () => ({
  startAcpSpawnParentStreamRelay: hoisted.startAcpSpawnParentStreamRelayMock,
}));

vi.mock("../registry/subagent-registry.js", () => ({
  countActiveRunsForSession: hoisted.countActiveRunsForSessionMock,
  // ACP registration deliberately moved behind the shared spawn pipeline.
  registerSubagentRun: hoisted.registerSubagentRunMock,
}));

vi.mock("../registry/subagent-registry-read.js", () => ({
  getSubagentRunByChildSessionKey: hoisted.getSubagentRunByChildSessionKeyMock,
}));

const { spawnAcpDirect } = await import("./acp-spawn.js");
type SpawnRequest = Parameters<typeof spawnAcpDirect>[0];
type SpawnContext = Parameters<typeof spawnAcpDirect>[1];
type SpawnResult = Awaited<ReturnType<typeof spawnAcpDirect>>;
type CrossAgentWorkspaceFixture = {
  workspaceRoot: string;
  mainWorkspace: string;
  targetWorkspace: string;
};

function replaceSpawnConfig(next: OpenClawConfig): void {
  const current = hoisted.state.cfg as Record<string, unknown>;
  for (const key of Object.keys(current)) {
    delete current[key];
  }
  Object.assign(current, next);
}

function configureSubagentDefaults(
  subagents: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["subagents"],
): void {
  const agents = (hoisted.state.cfg.agents ??= {});
  const defaults = (agents.defaults ??= {});
  Object.assign((defaults.subagents ??= {}), subagents);
}

function registerBindingAdapter(
  channel: string,
  accountId = "default",
  placements: SessionBindingPlacement[] = ["current", "child"],
): void {
  registerSessionBindingAdapter({
    channel,
    accountId,
    capabilities: { bindSupported: true, unbindSupported: true, placements },
    bind: async (input) => await hoisted.sessionBindingBindMock(input),
    listBySession: (targetSessionKey) => hoisted.sessionBindingListBySessionMock(targetSessionKey),
    resolveByConversation: (ref) => hoisted.sessionBindingResolveByConversationMock(ref),
    unbind: async (input) => await hoisted.sessionBindingUnbindMock(input),
  });
}

function gatewayResponse(method?: string) {
  if (method === "agent") {
    return { runId: "run-1" };
  }
  return method === "sessions.patch" || method === "sessions.delete" ? { ok: true } : {};
}

function createSessionBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:child-thread",
    targetSessionKey: "agent:codex:acp:s1",
    targetKind: "session",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "child-thread",
      parentConversationId: "parent-channel",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      agentId: "codex",
      boundBy: "system",
    },
    ...overrides,
  };
}

function mockConversationBinding(channel: string, agentId = "codex", parentRoom?: string): void {
  hoisted.sessionBindingBindMock.mockImplementationOnce(
    async (input: Parameters<NonNullable<SessionBindingAdapter["bind"]>>[0]) =>
      createSessionBinding({
        targetSessionKey: input.targetSessionKey,
        conversation: {
          ...input.conversation,
          channel,
          ...(parentRoom
            ? {
                conversationId: "child-thread",
                parentConversationId: input.conversation.parentConversationId ?? parentRoom,
              }
            : {}),
        },
        metadata: {
          boundBy: typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
          agentId,
          ...(parentRoom ? { webhookId: "wh-1" } : {}),
        },
      }),
  );
}

function createRelayHandle(disposal: Promise<void> = Promise.resolve()) {
  return { dispose: vi.fn(() => disposal), notifyStarted: vi.fn() };
}

function spawn(
  request: Partial<SpawnRequest> = {},
  context: SpawnContext = { agentSessionKey: "agent:main:main" },
) {
  return spawnAcpDirect({ task: "Investigate flaky tests", agentId: "codex", ...request }, context);
}

const requesterContext: SpawnContext = {
  agentSessionKey: "agent:main:telegram:direct:6098642967",
  agentChannel: "telegram",
  agentAccountId: "default",
  agentTo: "telegram:6098642967",
  agentThreadId: "1",
};

async function createCrossAgentWorkspaceFixture(options?: {
  createTargetWorkspace?: boolean;
}): Promise<CrossAgentWorkspaceFixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-spawn-"));
  const mainWorkspace = path.join(workspaceRoot, "main");
  const targetWorkspace = path.join(workspaceRoot, "claude-code");
  await fs.mkdir(mainWorkspace, { recursive: true });
  if (options?.createTargetWorkspace !== false) {
    await fs.mkdir(targetWorkspace, { recursive: true });
  }
  return {
    workspaceRoot,
    mainWorkspace,
    targetWorkspace,
  };
}

function configureCrossAgentWorkspaceSpawn(fixture: CrossAgentWorkspaceFixture): void {
  hoisted.state.cfg.acp = { ...hoisted.state.cfg.acp, allowedAgents: ["codex", "claude-code"] };
  hoisted.state.cfg.agents = {
    entries: {
      main: { workspace: fixture.mainWorkspace },
      "claude-code": { workspace: fixture.targetWorkspace },
    },
  };
}

function expectFailedSpawn(
  result: SpawnResult,
  status?: "error" | "forbidden",
): Extract<SpawnResult, { status: "error" | "forbidden" }> {
  if (status) {
    expect(result.status).toBe(status);
  } else {
    expect(result.status).not.toBe("accepted");
  }
  if (result.status === "accepted") {
    throw new Error("Expected ACP spawn to fail");
  }
  return result;
}

function expectAcceptedSpawn(result: SpawnResult): Extract<SpawnResult, { status: "accepted" }> {
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") {
    throw new Error("Expected ACP spawn to be accepted");
  }
  return result;
}

function latestBindingInput(): Record<string, unknown> {
  return expectRecordFields(latestMockCall(hoisted.sessionBindingBindMock, "session bind")[0], {});
}

function gatewayRequests(): Array<{ method?: string; params?: Record<string, unknown> }> {
  return hoisted.callGatewayMock.mock.calls.map(
    (call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> },
  );
}

function gatewayRequest(method: string): { method?: string; params?: Record<string, unknown> } {
  const request = gatewayRequests().find((candidate) => candidate.method === method);
  if (!request) {
    throw new Error(`Expected gateway request for ${method}`);
  }
  return request;
}

function expectGatewayMethodNotCalled(method: string): void {
  expect(gatewayRequests().some((request) => request.method === method)).toBe(false);
}

function expectInitializeSessionFields(expected: Record<string, unknown>): Record<string, unknown> {
  return expectRecordFields(
    firstMockCall(hoisted.initializeSessionMock, "session initialization")[0],
    expected,
  );
}

function expectBindingCallFields(expected: Record<string, unknown>): Record<string, unknown> {
  const input = latestBindingInput();
  expect(input).toMatchObject(expected);
  return input;
}

function expectRelayCallFields(expected: Record<string, unknown>, callIndex = 0): void {
  expectRecordFields(
    hoisted.startAcpSpawnParentStreamRelayMock.mock.calls[callIndex]?.[0],
    expected,
  );
}

function resolveMatrixRoomTargetForTest(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/^(?:matrix:)?(?:channel:|room:)/iu, "").trim();
  return normalized || undefined;
}

function configureChannelBindings(channel: string, accountId?: string, defaultAccount?: string) {
  const threadBindings = { enabled: true, spawnSessions: true };
  hoisted.state.cfg.channels = {
    ...hoisted.state.cfg.channels,
    [channel]: {
      threadBindings,
      ...(defaultAccount ? { defaultAccount } : {}),
      ...(accountId ? { accounts: { [accountId]: { threadBindings } } } : {}),
    },
  };
}

function enableMatrixAcpThreadBindings(): void {
  configureChannelBindings("matrix");
  const matrixPlugin = {
    ...createChannelTestPluginBase({ id: "matrix" }),
    conversationBindings: {
      defaultTopLevelPlacement: "child",
    },
    messaging: {
      resolveDeliveryTarget: ({
        conversationId,
        parentConversationId,
      }: {
        conversationId: string;
        parentConversationId?: string;
      }) => {
        const parent = resolveMatrixRoomTargetForTest(parentConversationId);
        const child = conversationId.trim();
        return parent ? { to: `room:${parent}`, threadId: child } : { to: `room:${child}` };
      },
      resolveInboundConversation: ({
        to,
        threadId,
      }: {
        to?: string;
        threadId?: string | number;
      }) => {
        const parent = resolveMatrixRoomTargetForTest(to);
        const thread = threadId != null ? String(threadId).trim() : "";
        return thread && parent
          ? { conversationId: thread, parentConversationId: parent }
          : parent
            ? { conversationId: parent }
            : undefined;
      },
    },
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "matrix", plugin: matrixPlugin, source: "test" }]),
  );
  registerBindingAdapter("matrix");
}

function enableLineCurrentConversationBindings(): void {
  configureChannelBindings("line");
  const linePlugin = {
    ...createChannelTestPluginBase({ id: "line" }),
    messaging: {
      resolveInboundConversation: ({
        conversationId,
        to,
      }: {
        conversationId?: string;
        to?: string;
      }) => {
        const source = (conversationId ?? to ?? "").trim();
        const normalized =
          source.match(/^line:(?:(?:user|group|room):)?(.+)$/i)?.[1]?.trim() ?? source;
        return normalized ? { conversationId: normalized } : undefined;
      },
    },
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "line", plugin: linePlugin, source: "test" }]),
  );
  registerBindingAdapter("line", "default", ["current"]);
}

function mockSessionStore(entries: Record<string, SessionEntry> = {}) {
  hoisted.loadSessionStoreMock.mockReset().mockImplementation(
    () =>
      new Proxy(entries, {
        get(target, prop) {
          if (typeof prop === "string" && prop.startsWith("agent:codex:acp:")) {
            return { sessionId: "sess-123", updatedAt: Date.now() };
          }
          return typeof prop === "string" ? target[prop] : undefined;
        },
      }),
  );
}

function configureHeartbeatParent(sessionKey: string, envelope: Partial<SessionEntry> = {}) {
  const cfg = hoisted.state.cfg;
  cfg.agents = {
    defaults: { ...cfg.agents?.defaults, heartbeat: { every: "30m", target: "last" } },
  };
  mockSessionStore({
    [sessionKey]: {
      sessionId: "parent-sess-1",
      updatedAt: Date.now(),
      ...envelope,
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "discord",
          to: "channel:parent-channel",
          accountId: "default",
        },
      }),
    },
  });
  return {
    agentSessionKey: sessionKey,
    agentChannel: "discord",
    agentAccountId: "default",
    agentTo: "channel:parent-channel",
  };
}

const activeAcpTurnReleases: Array<() => void> = [];

function trackActiveAcpTurn(sessionKey: string, ownerSessionKey: string) {
  activeAcpTurnReleases.push(
    expectDefined(
      markAcpTurnActive({ agentId: "codex", sessionKey, ownerSessionKey }),
      "active ACP fixture turn",
    ),
  );
}

describe("spawnAcpDirect", () => {
  registerAcpSpawnPolicyTests({
    spawn: spawnAcpDirect,
    state: hoisted.state,
    initializeSessionMock: hoisted.initializeSessionMock,
    upsertSessionEntryMock: hoisted.upsertSessionEntryMock,
    callGatewayMock: hoisted.callGatewayMock,
  });

  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry());
    acpRuntimeRegistryTesting.resetAcpRuntimeBackendsForTests();
    replaceSpawnConfig(createDefaultSpawnConfig());
    hoisted.areHeartbeatsEnabledMock.mockReset().mockReturnValue(true);
    hoisted.cleanupFailedAcpSpawnMock.mockReset().mockResolvedValue(undefined);
    hoisted.closeRuntimeOnFailureMock.mockReset().mockResolvedValue(undefined);
    hoisted.registerSubagentRunMock.mockReset().mockResolvedValue(undefined);
    hoisted.countActiveRunsForSessionMock.mockReset().mockReturnValue(0);
    hoisted.getSubagentRunByChildSessionKeyMock.mockReset().mockReturnValue(null);
    hoisted.upsertSessionEntryMock
      .mockReset()
      .mockImplementation(async (_scope: unknown, patch: Partial<SessionEntry>) => ({
        ...patch,
        sessionId: patch.sessionId ?? "sess-123",
        updatedAt: patch.updatedAt ?? Date.now(),
      }));

    hoisted.callGatewayMock
      .mockReset()
      .mockImplementation(async (args: { method?: string }) => gatewayResponse(args.method));

    hoisted.closeSessionMock.mockReset().mockResolvedValue({
      runtimeClosed: true,
      metaCleared: false,
    });
    hoisted.getAcpSessionManagerMock.mockReset().mockReturnValue({
      initializeSession: async (params: AcpInitializeSessionInput) =>
        await hoisted.initializeSessionMock(params),
      closeSession: async (params: unknown) => await hoisted.closeSessionMock(params),
    });
    hoisted.initializeSessionMock.mockReset().mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as AcpInitializeSessionInput;
      const runtimeSessionName = `${args.sessionKey}:runtime`;
      const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
      return {
        closeRuntimeOnFailure: hoisted.closeRuntimeOnFailureMock,
        runtime: {
          close: vi.fn().mockResolvedValue(undefined),
        },
        handle: {
          sessionKey: args.sessionKey,
          backend: "acpx",
          runtimeSessionName,
          ...(cwd ? { cwd } : {}),
          agentSessionId: "codex-inner-1",
          backendSessionId: "acpx-1",
        },
        meta: {
          backend: "acpx",
          agent: args.agent,
          runtimeSessionName,
          ...(cwd ? { runtimeOptions: { cwd }, cwd } : {}),
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-1",
            agentSessionId: "codex-inner-1",
            lastUpdatedAt: Date.now(),
          },
          mode: args.mode,
          state: "idle",
          lastActivityAt: Date.now(),
        },
      };
    });

    hoisted.sessionBindingBindMock
      .mockReset()
      .mockImplementation(
        async (input: {
          targetSessionKey: string;
          conversation: { accountId: string };
          metadata?: Record<string, unknown>;
        }) =>
          createSessionBinding({
            targetSessionKey: input.targetSessionKey,
            conversation: {
              channel: "discord",
              accountId: input.conversation.accountId,
              conversationId: "child-thread",
              parentConversationId: "parent-channel",
            },
            metadata: {
              boundBy:
                typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
              agentId: "codex",
              webhookId: "wh-1",
            },
          }),
      );
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);
    sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
    registerBindingAdapter("discord");
    hoisted.startAcpSpawnParentStreamRelayMock
      .mockReset()
      .mockImplementation(() => createRelayHandle());
    hoisted.resolveStorePathMock.mockReset().mockReturnValue("/tmp/codex-sessions.json");
    hoisted.readAcpResumeSessionOwnerMock.mockReset().mockReturnValue(undefined);
    mockSessionStore();
  });

  afterEach(() => {
    for (const release of activeAcpTurnReleases.splice(0)) {
      release();
    }
    setActivePluginRegistry(createTestRegistry());
    acpRuntimeRegistryTesting.resetAcpRuntimeBackendsForTests();
    sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
  });

  it("reconciles a transport-ambiguous ACP dispatch so an accepted run is surfaced instead of misreported as dispatch_failed", async () => {
    let agentDispatchAttempts = 0;
    // Model an accepted dispatch whose acknowledgement was lost.
    hoisted.callGatewayMock.mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as { method?: string };
      if (args.method === "agent") {
        agentDispatchAttempts += 1;
        if (agentDispatchAttempts === 1) {
          throw new Error("gateway timeout after 60000ms");
        }
        return { runId: "accepted-acp-run", status: "in_flight" };
      }
      return gatewayResponse(args.method);
    });

    const result = await spawn(
      {
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
        agentThreadId: "requester-thread",
      },
    );

    expect(agentDispatchAttempts).toBe(2);
    const accepted = expectAcceptedSpawn(result);
    expect(accepted.runId).toBe("accepted-acp-run");
    expect(accepted.childSessionKey).toMatch(/^agent:codex:acp:/);
  });

  it("forwards ACP lineage with unsupported external native actions and the exact parent token", async () => {
    const parentToken = createExecutionIdentityAdmissionToken("parent-run", {
      contextId: "parent-context",
      executionId: "parent-execution",
    });
    replaceSpawnConfig({
      ...createDefaultSpawnConfig(),
      logging: { audit: { enabled: true, executionIdentity: true } },
    });
    const operationalRunInstance = createOperationalRunInstanceRef("parent-run");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    let capturedIdentity: AgentRuntimeIdentity | undefined;
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: async <T>(
        _method: string,
        _params: Record<string, unknown>,
        options?: NonNullable<Parameters<typeof dispatchGatewayMethodInProcess>[2]>,
      ) => {
        capturedIdentity = readInProcessAgentRuntimeIdentity(options);
        return { runId: "acp-child-run" } as T;
      },
    });

    try {
      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:6098642967",
          operationalRunInstance,
          executionIdentityToken: parentToken,
        },
        () => spawn({ mode: "run" }, withParentExecutionIdentity(requesterContext, parentToken)),
      );

      expectAcceptedSpawn(result);
      expect(capturedIdentity?.executionIdentity).toBe(parentToken);
      expect(readAgentRuntimeExecutionLineage(capturedIdentity?.sessionSpawnContext)).toMatchObject(
        {
          relation: "sessions_spawn",
          requesterRef: "agent:main:telegram:direct:6098642967",
          controllerRef: "agent:main:telegram:direct:6098642967",
          externalNativeActions: "unsupported",
          runtimeAssuranceRefs: ["spawn-runtime:acp"],
        },
      );
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
      spawnTesting.setDepsForTest();
    }
  });

  it("resumes through the configured ACP owner and backend", async () => {
    hoisted.state.cfg.agents = {
      ...hoisted.state.cfg.agents,
      entries: {
        reviewer: { runtime: { type: "acp", acp: { agent: "codex", backend: "fallback" } } },
      },
    };
    const resumeSessionId = "fixture-resume";
    hoisted.readAcpResumeSessionOwnerMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:owned",
      entry: { sessionId: "sess-owned", updatedAt: 100, spawnedBy: "agent:main:main" },
    });
    const result = await spawn({ agentId: "reviewer", resumeSessionId });
    expectAcceptedSpawn(result);
    expect(hoisted.readAcpResumeSessionOwnerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "codex",
        backendId: "fallback",
        resumeSessionId,
      }),
    );
    expectInitializeSessionFields({ resumeSessionId, backendId: "fallback" });
  });

  it("refuses an unknown resume ID before creating a child", async () => {
    const result = await spawn({ resumeSessionId: "unknown" });
    expect(result).toMatchObject({ status: "forbidden", errorCode: "resume_forbidden" });
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("strips an inherited OpenClaw auth profile before ACP initialization", async () => {
    configureSubagentDefaults({ model: "openai/gpt-5.6-luna@openai:test-profile" });

    const result = await spawn({});

    expectAcceptedSpawn(result);
    const initInput = expectInitializeSessionFields({ agent: "codex" });
    expect(initInput.runtimeOptions).toEqual(
      expect.objectContaining({ model: "openai/gpt-5.6-luna" }),
    );
  });

  it("rejects an explicit OpenClaw auth profile for ACP runtimes", async () => {
    const result = await spawn(
      {
        model: "openai/gpt-5.6-luna@openai:test-profile",
      },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("error");
    expect(result).toHaveProperty(
      "error",
      "ACP model overrides cannot select OpenClaw auth profiles; configure credentials in the ACP runtime instead.",
    );
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    model?: string;
    subagentModel?: string;
    thinking?: ThinkLevel;
    inherited?: ThinkLevel;
    ownerThinking?: ThinkLevel;
    globalThinking?: ThinkLevel;
    modelThinking?: ThinkLevel;
    expectedModel?: string;
    expectedThinking?: ThinkLevel;
  }>([
    {
      name: "target-provider alias",
      model: "anthropic/claude-sonnet-4-6",
      subagentModel: "opus",
      inherited: "low",
      expectedModel: "anthropic/claude-opus-4-6",
      expectedThinking: "low",
    },
    { name: "explicit max", thinking: "max", inherited: "low", expectedThinking: "max" },
    {
      name: "inherited max",
      model: "openai/gpt-5.6-sol",
      inherited: "max",
      expectedModel: "openai/gpt-5.6-sol",
      expectedThinking: "max",
    },
    {
      name: "configured model with global thinking default",
      model: "anthropic/claude-sonnet-4-6",
      globalThinking: "off",
      expectedModel: "anthropic/claude-sonnet-4-6",
      expectedThinking: "off",
    },
    {
      name: "opaque harness model",
      model: "harness-only[context=272k,reasoning=medium,fast=false]",
      expectedModel: "harness-only[context=272k,reasoning=medium,fast=false]",
    },
    {
      name: "owner thinking before model and global defaults",
      model: "anthropic/claude-sonnet-4-6",
      ownerThinking: "off",
      modelThinking: "adaptive",
      globalThinking: "high",
      expectedModel: "anthropic/claude-sonnet-4-6",
      expectedThinking: "off",
    },
    {
      name: "owner thinking without model override",
      ownerThinking: "off",
      globalThinking: "high",
      expectedThinking: "off",
    },
    {
      name: "model-profile thinking default",
      model: "openai/gpt-5.4",
      modelThinking: "high",
      expectedModel: "openai/gpt-5.4",
      expectedThinking: "high",
    },
  ])(
    "resolves ACP runtime options: $name",
    async ({
      model,
      subagentModel,
      thinking,
      inherited,
      ownerThinking,
      globalThinking,
      modelThinking,
      expectedModel,
      expectedThinking,
    }) => {
      hoisted.state.cfg.agents = {
        entries: {
          "codex-acp": {
            runtime: { type: "acp", acp: { agent: "codex" } },
            model,
            thinkingDefault: ownerThinking,
            subagents: { model: subagentModel, thinking: subagentModel ? inherited : undefined },
          },
        },
        defaults: {
          model: "openai/gpt-5.4",
          thinkingDefault: globalThinking,
          models: {
            ...(subagentModel ? { "claude-opus-4-6": { alias: "opus" } } : {}),
            ...(model && modelThinking ? { [model]: { params: { thinking: modelThinking } } } : {}),
          },
          subagents: {
            allowAgents: ["codex"],
            maxSpawnDepth: 2,
            thinking: subagentModel ? undefined : inherited,
          },
        },
      };
      expectAcceptedSpawn(await spawn({ agentId: "codex-acp", thinking }));
      expectInitializeSessionFields({
        agent: "codex",
        backendId: "acpx",
        thinkingExplicit: thinking !== undefined,
        runtimeOptions: {
          ...(expectedModel ? { model: expectedModel } : {}),
          ...(expectedThinking ? { thinking: expectedThinking } : {}),
        },
      });
    },
  );

  it("caps configured ACP runtime timeout without shortening spawn tracking", async () => {
    configureSubagentDefaults({ runTimeoutSeconds: 172_800 });

    const result = await spawn({});

    expectAcceptedSpawn(result);
    expect(result).toHaveProperty("runTimeoutSeconds", 172_800);
    expectInitializeSessionFields({
      agent: "codex",
      runtimeOptions: {
        timeoutSeconds: 86_400,
      },
    });
    const agentCall = gatewayRequest("agent");
    expect(agentCall?.params?.timeout).toBe(172_800);
  });

  it("rejects OpenClaw config agent ids when runtime=acp targets a native agent", async () => {
    hoisted.state.cfg.agents = {
      entries: { pleres: {} },
      defaults: { subagents: { allowAgents: ["*"], maxSpawnDepth: 2 } },
    };

    const result = await spawn({
      agentId: "pleres",
    });

    expectRecordFields(result, {
      status: "error",
      errorCode: "runtime_agent_mismatch",
    });
    expect(result).toHaveProperty(
      "error",
      'agentId "pleres" is an OpenClaw config agent, not an ACP harness. Use runtime="subagent" or omit runtime for OpenClaw config agents. Use runtime="acp" only with external ACP harness ids such as codex, claude, droid, gemini, or opencode, or configure agents.entries.*.runtime.type="acp" with runtime.acp.agent.',
    );
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
    expectGatewayMethodNotCalled("agent");
  });

  it("forwards prepared image attachments through the gateway agent call", async () => {
    const imageBase64 = Buffer.from("png-bytes").toString("base64");
    const result = await spawn({
      attachments: [{ mediaType: "image/png", data: imageBase64 }],
    });

    expectAcceptedSpawn(result);
    const agentCall = gatewayRequest("agent");
    expect(agentCall?.params?.attachments).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: imageBase64 },
      },
    ]);
  });

  it("rejects ACP spawns that exceed subagent max depth", async () => {
    const result = await spawn(
      { mode: "run" },
      {
        ...requesterContext,
        agentSessionKey: "agent:main:subagent:parent:subagent:leaf",
      },
    );

    const failed = expectFailedSpawn(result, "forbidden");
    expect(failed.errorCode).toBe("subagent_policy");
    expect(failed.error).toContain("current depth: 2, max: 2");
  });

  it.each([1, 2])("counts a pending dispatch exactly once against cap %s", async (cap) => {
    configureSubagentDefaults({ maxChildrenPerAgent: cap });
    hoisted.countActiveRunsForSessionMock.mockImplementation(
      () => hoisted.registerSubagentRunMock.mock.calls.length,
    );
    if (cap === 2) {
      hoisted.getSubagentRunByChildSessionKeyMock.mockImplementation((childSessionKey: string) =>
        hoisted.registerSubagentRunMock.mock.calls.some(
          ([run]) => run.childSessionKey === childSessionKey,
        )
          ? { childSessionKey, execution: { status: "running" } }
          : null,
      );
    }
    const entered = createDeferred();
    const release = createDeferred();
    const context = {
      ...requesterContext,
      agentSessionKey: "agent:main:subagent:parent",
      ...(cap === 1 ? { completionOwnerKey: "agent:main:main" } : {}),
    };
    let dispatchedRuns = 0;
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: { sessionKey?: string } }) => {
        if (request.method !== "agent") {
          return {};
        }
        const runNumber = ++dispatchedRuns;
        if (cap === 2) {
          trackActiveAcpTurn(
            expectDefined(request.params?.sessionKey, "dispatched child"),
            context.agentSessionKey,
          );
        }
        if (runNumber === 1) {
          entered.resolve();
          await release.promise;
        }
        return { runId: `acp-run-${runNumber}` };
      },
    );
    const first = spawn({ mode: "run" }, context);
    try {
      await entered.promise;
      const second = await spawn({ mode: "run" }, context);
      if (cap === 1) {
        expect(expectFailedSpawn(second, "forbidden")).toMatchObject({
          errorCode: "subagent_policy",
          error: expect.stringContaining("max active children for this session (1/1"),
        });
      } else {
        expectAcceptedSpawn(second);
      }
    } finally {
      release.resolve();
    }
    expectAcceptedSpawn(await first);
    expect(dispatchedRuns).toBe(cap);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(cap);
  });

  it("counts unrelated active ACP turns separately from anonymous child reservations", async () => {
    configureSubagentDefaults({ maxChildrenPerAgent: 2 });
    trackActiveAcpTurn("agent:codex:acp:independent-task", "agent:main:subagent:parent");
    const controllerSessionKey = "agent:main:subagent:parent";
    const pendingNativeChild = reserveChildAdmissionSlot({
      controllerSessionKey,
      resolveAdmission: () => ({ ok: true as const }),
    });
    if (!pendingNativeChild.ok) {
      throw new Error("Expected native child reservation");
    }

    try {
      const rejected = await spawn(
        { mode: "run" },
        {
          ...requesterContext,
          agentSessionKey: controllerSessionKey,
        },
      );

      expect(expectFailedSpawn(rejected, "forbidden")).toMatchObject({
        errorCode: "subagent_policy",
        error: expect.stringContaining("max active children for this session (2/2"),
      });
      expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    } finally {
      pendingNativeChild.release();
    }
  });

  it("returns ACP child capacity after run registration fails", async () => {
    configureSubagentDefaults({ maxChildrenPerAgent: 1 });
    hoisted.registerSubagentRunMock.mockRejectedValueOnce(new Error("registry unavailable"));
    const context = {
      ...requesterContext,
      agentSessionKey: "agent:main:subagent:parent",
    };

    const failed = await spawn({ mode: "run" }, context);
    const replacement = await spawn({ mode: "run" }, context);

    expect(expectFailedSpawn(failed, "error")).toMatchObject({
      errorCode: "spawn_failed",
      error: expect.stringContaining("registry unavailable"),
    });
    expect(failed).toHaveProperty("runId", "run-1");
    expect(hoisted.cleanupFailedAcpSpawnMock).toHaveBeenCalledTimes(1);
    expectAcceptedSpawn(replacement);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "enforces the registry with wildcard allowlist (configured=%s)",
    async (configured) => {
      hoisted.state.cfg.acp = {
        ...hoisted.state.cfg.acp,
        allowedAgents: configured ? ["codex", "writer"] : [],
      };
      hoisted.state.cfg.agents = {
        ...hoisted.state.cfg.agents,
        entries: { main: { subagents: { allowAgents: ["*"] } } },
      };
      const result = await spawn(
        { mode: "run", agentId: "writer" },
        {
          ...requesterContext,
          agentSessionKey: "agent:main:subagent:parent",
        },
      );
      if (configured) {
        expectAcceptedSpawn(result);
      } else {
        expect(expectFailedSpawn(result, "forbidden")).toMatchObject({
          errorCode: "subagent_policy",
          error: 'agentId "writer" is not in the configured agent registry (allowed: main)',
        });
      }
    },
  );

  it("rejects explicit ACP self-targets when the subagent allowlist excludes the requester", async () => {
    hoisted.state.cfg.acp = { ...hoisted.state.cfg.acp, allowedAgents: ["codex", "writer"] };
    configureSubagentDefaults({ allowAgents: ["writer"] });

    const result = await spawn(
      { mode: "run", agentId: "codex" },
      {
        ...requesterContext,
        agentSessionKey: "agent:codex:subagent:parent",
      },
    );

    const failed = expectFailedSpawn(result, "forbidden");
    expect(failed.errorCode).toBe("subagent_policy");
    expect(failed.error).toContain("agentId is not allowed");
  });

  it("preserves Matrix parent room casing when binding from an existing thread", async () => {
    enableMatrixAcpThreadBindings();
    mockConversationBinding("matrix", "codex", "!Room:Example.org");

    const result = await spawn(
      {
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:matrix:channel:!room:example.org:thread:$thread-root",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: "room:!Room:Example.org",
        agentThreadId: "$thread-root",
        agentGroupId: "!room:example.org",
      },
    );

    expect(result.status, JSON.stringify(result)).toBe("accepted");
    expectBindingCallFields({
      placement: "child",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "$thread-root",
        parentConversationId: "!Room:Example.org",
      },
    });
    expect(gatewayRequest("agent").params).toMatchObject({
      deliver: true,
      channel: "matrix",
      to: "room:!Room:Example.org",
      threadId: "child-thread",
    });
  });

  it.each([true, false])("resolves the target workspace (exists=%s)", async (exists) => {
    const fixture = await createCrossAgentWorkspaceFixture({ createTargetWorkspace: exists });
    try {
      configureCrossAgentWorkspaceSpawn(fixture);
      expectAcceptedSpawn(await spawn({ agentId: "claude-code", mode: "run" }));
      expectInitializeSessionFields({
        agent: "claude-code",
        cwd: exists ? fixture.targetWorkspace : undefined,
        sessionKey: expect.stringMatching(/^agent:claude-code:acp:/),
      });
    } finally {
      await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  });

  it("surfaces non-missing target workspace access failures instead of silently dropping cwd", async () => {
    const fixture = await createCrossAgentWorkspaceFixture();
    const accessSpy = vi.spyOn(fs, "access");
    try {
      configureCrossAgentWorkspaceSpawn(fixture);

      accessSpy.mockRejectedValueOnce(
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
      );

      const result = await spawn(
        {
          agentId: "claude-code",
          mode: "run",
        },
        {
          agentSessionKey: "agent:main:main",
        },
      );

      expect(result).toEqual({
        status: "error",
        errorCode: "cwd_resolution_failed",
        error: "permission denied",
      });
      expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
    } finally {
      accessSpy.mockRestore();
      await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  });

  it("refuses to hand the current conversation to a spawned worker", async () => {
    enableLineCurrentConversationBindings();
    const result = await spawn(
      { mode: "session", thread: true },
      {
        agentSessionKey: "agent:main:line:direct:U1234567890abcdef1234567890abcdef",
        agentChannel: "line",
        agentAccountId: "default",
        agentTo: "U1234567890abcdef1234567890abcdef",
      },
    );
    expect(result).toMatchObject({ status: "error", errorCode: "thread_binding_invalid" });
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
    expectGatewayMethodNotCalled("agent");
  });

  it("binds ACP sessions through the configured default account when accountId is omitted", async () => {
    configureChannelBindings("custom", "work", "work");
    registerBindingAdapter("custom", "work", ["child"]);
    mockConversationBinding("custom");

    const result = await spawn(
      {
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:custom:channel:123456",
        agentChannel: "custom",
        agentTo: "channel:123456",
      },
    );

    expect(result.status).toBe("accepted");
    expectBindingCallFields({
      placement: "child",
      conversation: {
        channel: "custom",
        accountId: "work",
        conversationId: "123456",
      },
    });
    expect(gatewayRequest("agent").params).toMatchObject({
      deliver: true,
      channel: "custom",
      to: "channel:123456",
      threadId: undefined,
    });
    expect(gatewayRequest("agent")?.params?.accountId).toBe("work");
  });

  it("uses the target agent's bound account for cross-agent ACP thread spawns", async () => {
    const boundRoom = "!room:example.org";
    configureChannelBindings("matrix", "bot-alpha");
    hoisted.state.cfg.acp = { ...hoisted.state.cfg.acp, allowedAgents: ["codex", "bot-alpha"] };
    hoisted.state.cfg.bindings = [
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: boundRoom },
          accountId: "bot-alpha",
        },
      },
    ];
    registerBindingAdapter("matrix", "bot-alpha");
    mockConversationBinding("matrix", "bot-alpha");

    const result = await spawn(
      {
        agentId: "bot-alpha",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:matrix:room:requester",
        agentChannel: "matrix",
        agentAccountId: "bot-beta",
        agentTo: `room:${boundRoom}`,
      },
    );

    expect(result.status).toBe("accepted");
    expectBindingCallFields({
      placement: "child",
      conversation: {
        channel: "matrix",
        accountId: "bot-alpha",
        conversationId: boundRoom,
      },
    });
    expectRecordFields(gatewayRequest("agent").params, {
      deliver: true,
      channel: "matrix",
      accountId: "bot-alpha",
      to: `room:${boundRoom}`,
    });
    expectRegisteredSubagentRun(
      hoisted.registerSubagentRunMock,
      {
        requesterOrigin: expect.objectContaining({
          channel: "matrix",
          accountId: "bot-alpha",
          to: `room:${boundRoom}`,
        }),
      },
      { assertCurrent: undefined },
    );
  });

  it("rejects disallowed ACP agents", async () => {
    hoisted.state.cfg.acp = { enabled: true, backend: "acpx", allowedAgents: ["claudecode"] };

    const result = await spawn({});

    expectRecordFields(result, {
      status: "forbidden",
    });
  });

  it("implicitly streams mode=run ACP spawns for subagent requester sessions", async () => {
    const context = configureHeartbeatParent("agent:main:subagent:parent");
    const firstHandle = createRelayHandle(new Promise<void>(() => {}));
    const secondHandle = createRelayHandle();
    hoisted.startAcpSpawnParentStreamRelayMock
      .mockReset()
      .mockReturnValueOnce(firstHandle)
      .mockReturnValueOnce(secondHandle);
    const result = await spawn({}, context);

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    const agentCall = gatewayRequest("agent");
    expect(agentCall?.params?.deliver).toBe(false);
    expect(agentCall?.params?.channel).toBeUndefined();
    expect(agentCall?.params?.to).toBeUndefined();
    expect(agentCall?.params?.threadId).toBeUndefined();
    expectRelayCallFields({
      parentSessionKey: "agent:main:subagent:parent",
      agentId: "codex",
      childSessionId: "sess-123",
      deliveryContext: {
        channel: "discord",
        to: "channel:parent-channel",
        accountId: "default",
      },
    });
    const dispatchOrder = expectDefined(
      hoisted.callGatewayMock.mock.invocationCallOrder[0],
      "dispatch order",
    );
    expect(hoisted.startAcpSpawnParentStreamRelayMock.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchOrder,
    );
    expect(secondHandle.notifyStarted.mock.invocationCallOrder[0]).toBeGreaterThan(dispatchOrder);
    expect(firstHandle.notifyStarted).not.toHaveBeenCalled();
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(secondHandle.notifyStarted).toHaveBeenCalledTimes(1);
  });

  it("does not implicitly stream for ACP requester sessions inside a subagent envelope", async () => {
    const context = configureHeartbeatParent("agent:main:acp:child", {
      spawnedBy: "agent:main:subagent:parent",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
    });
    const result = await spawn({}, context);

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });

  it.each(["off", "all"] as const)(
    "preserves global requester ownership with sandbox mode %s",
    async (sandboxMode) => {
      replaceSpawnConfig({
        ...hoisted.state.cfg,
        agents: {
          ...hoisted.state.cfg.agents,
          ownership: "explicit",
          entries: {
            research: { sandbox: { mode: sandboxMode } },
            ops: {},
          },
        },
        session: {
          ...hoisted.state.cfg.session,
          scope: "global",
        },
      });

      const result = await spawn(
        {},
        {
          agentSessionKey: "global",
          requesterAgentIdOverride: "research",
        },
      );

      if (sandboxMode === "all") {
        expect(expectFailedSpawn(result, "forbidden").error).toContain(
          "Sandboxed sessions cannot spawn ACP sessions",
        );
        expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
        expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
        return;
      }
      expectAcceptedSpawn(result);
      expectRegisteredSubagentRun(
        hoisted.registerSubagentRunMock,
        {
          requesterSessionKey: "global",
          childSessionKey: expect.stringMatching(/^agent:codex:acp:/),
          agentId: "codex",
          requesterAgentId: "research",
        },
        { assertCurrent: undefined },
      );
    },
  );

  it("disposes pre-registered parent relay when initial ACP dispatch fails", async () => {
    const relayHandle = createRelayHandle();
    hoisted.startAcpSpawnParentStreamRelayMock.mockReturnValueOnce(relayHandle);
    hoisted.callGatewayMock.mockImplementation(async ({ method }: { method?: string }) => {
      if (method === "agent") {
        throw new Error("agent dispatch failed");
      }
      return gatewayResponse(method);
    });

    const result = await spawn({
      streamTo: "parent",
    });

    expect(expectFailedSpawn(result, "error").error).toContain("agent dispatch failed");
    expect(relayHandle.dispose).toHaveBeenCalledTimes(1);
    expect(relayHandle.notifyStarted).not.toHaveBeenCalled();
    expect(hoisted.cleanupFailedAcpSpawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({ sessionId: expect.any(String) }),
        closeRuntimeOnFailure: hoisted.closeRuntimeOnFailureMock,
      }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
