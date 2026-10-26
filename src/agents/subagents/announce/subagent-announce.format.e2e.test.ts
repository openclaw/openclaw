import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../../config/config.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import * as gatewayCall from "../../../gateway/call.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { normalizeLegacySessionEntryDelivery } from "../../../infra/state-migrations.legacy-session-store.js";
import * as hookRunnerGlobal from "../../../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../../../plugins/hooks.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import * as sessionNativeRuntime from "../../../sessions/session-controller.native-runtime.js";
import * as sessionQueries from "../../../sessions/session-controller.queries.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { expectText } from "../../../test-utils/text-assertions.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import { buildAgentInternalEventContext, type AgentInternalEvent } from "../../internal-events.js";
import {
  projectRuntimeContextFragments,
  RUNTIME_EVENT_USER_PROMPT,
} from "../../internal-runtime-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { testing as deliveryTesting } from "./subagent-announce-delivery.test-support.js";
import { testing as outputTesting } from "./subagent-announce-output.test-support.js";
import { announceTesting } from "./subagent-announce-overrides.test-support.js";
import { runSubagentAnnounceFlow } from "./subagent-announce.js";
import {
  visibleAgentResponse,
  publishAnnounceRunFixture,
  type MockSubagentRun,
  expectInputProvenance,
  expectAgentCallFields,
  type AgentCallRequest,
} from "./subagent-announce.test-support.js";

type RequesterResolution = {
  requesterSessionKey: string;
  requesterOrigin?: Record<string, unknown>;
} | null;
type SessionEntryFixture = Partial<SessionEntry> & {
  lastChannel?: string;
  lastTo?: string;
  lastThreadId?: string | number;
};

const childKey = "agent:main:subagent:test";
const requesterKey = "agent:main:main";
const parentKey = "agent:main:subagent:parent";
const orchestratorKey = "agent:main:subagent:orchestrator";
const discordOrigin = { channel: "discord", to: "channel:12345", accountId: "acct-1" };
const whatsappOrigin = { channel: "whatsapp", accountId: "acct-123", to: "+1555" };
const minimalUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
type AnnounceParams = Partial<
  Parameters<typeof import("./subagent-announce.js").runSubagentAnnounceFlow>[0]
>;
function session(sessionId: string, fields: SessionEntryFixture = {}): SessionEntryFixture {
  return { sessionId, ...fields };
}

function prepareTerminal(rawText: string) {
  return prepareAgentRunTerminalReply({ rawText }).terminalReply;
}

function getAgentCall(index = 0): AgentCallRequest {
  const call = agentSpy.mock.calls[index]?.[0];
  expect(call, `agent call ${index}`).toBeDefined();
  return call!;
}

function getAgentCallContext(call = getAgentCall()): string {
  const events = call.params?.internalEvents as AgentInternalEvent[] | undefined;
  return events?.length
    ? projectRuntimeContextFragments(buildAgentInternalEventContext(events))
    : (call.params?.message ?? "");
}

const agentSpy = vi.fn(async (_req: AgentCallRequest) => visibleAgentResponse());
const sendSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "send-main", status: "ok" }));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const callGatewaySpy = vi.spyOn(gatewayCall, "callGateway");
const getGlobalHookRunnerSpy = vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner");
const isEmbeddedAgentRunActiveSpy = vi.spyOn(sessionQueries, "isSessionRunActive");
const waitForEmbeddedAgentRunEndSpy = vi.spyOn(sessionNativeRuntime, "waitForSessionRunEnd");
const { registry } = vi.hoisted(() => ({
  registry: {
    isSubagentSessionRunActive: vi.fn(() => true),
    shouldIgnorePostCompletionAnnounceForSession: vi.fn(
      (_sessionKey: string, _childAgentId?: string) => false,
    ),
    countPendingDescendantRuns: vi.fn((_sessionKey: string) => 0),
    listSubagentRunsForRequester: vi.fn(
      (_sessionKey: string, _scope?: { requesterRunId?: string }): MockSubagentRun[] => [],
    ),
    replaceSubagentRunAfterSteerCore: vi.fn(
      (_params: { previousRunId: string; nextRunId: string; lifecycleGeneration?: string }) => true,
    ),
    resolveRequesterForChildSession: vi.fn(
      (_sessionKey: string, _childAgentId?: string): RequesterResolution => null,
    ),
  },
}));
const deliveryTarget = vi.fn<HookRunner["runSubagentDeliveryTarget"]>();
let hasDeliveryTarget = false;
const hookRunnerMock: HookRunner = {
  ...createHookRunner(createTestRegistry()),
  hasHooks: (name: string) => name === "subagent_delivery_target" && hasDeliveryTarget,
  runSubagentDeliveryTarget: deliveryTarget,
};
let sessionStore: Record<string, SessionEntryFixture | undefined> = {};
let transcriptEvents: unknown[] = [];

function assistantEvent(runId: string, text: string, final?: boolean) {
  return {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
      __openclaw: { runId },
      openclawDeliveryMirror:
        final === undefined ? undefined : { kind: "message-tool-source-reply", final },
    },
  };
}

const sessionConfig = { store: "/tmp/sessions.json" };
let configOverride: OpenClawConfig = { session: sessionConfig };
const defaultOutcomeAnnounce = {
  childRunId: "run-default",
  childSessionKey: childKey,
  requesterSessionKey: requesterKey,
  task: "do thing",
  timeoutMs: 10,
  cleanup: "keep" as const,
  startedAt: 10,
  endedAt: 20,
  roundOneReply: "raw subagent reply",
  outcome: { status: "ok" } as const,
};

function makeChildCompletion(
  requesterSessionKey: string,
  child: string,
  resultText: string,
  overrides: Partial<MockSubagentRun> = {},
): MockSubagentRun {
  const createdAt = overrides.createdAt ?? 10;
  const endedAt = createdAt + 1;
  const childRun: MockSubagentRun = {
    runId: `run-${child}`,
    childSessionKey: `${requesterSessionKey}:subagent:${child}`,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: `child ${child}`,
    cleanup: "keep",
    createdAt,
    execution: { endedAt, outcome: { status: "ok" } },
    cleanupCompletedAt: endedAt + 1,
    completion: {
      required: true,
      resultText,
      terminalReply: prepareTerminal(resultText),
    },
    ...overrides,
  };
  sessionStore[childRun.childSessionKey] = { sessionId: `session-${childRun.runId}` };
  transcriptEvents.push(assistantEvent(childRun.runId, resultText));
  return childRun;
}
function childCompletions(
  requesterSessionKey: string,
  ...rows: [child: string, result: string, overrides?: Parameters<typeof makeChildCompletion>[3]][]
) {
  return rows.map(([child, result, overrides]) =>
    makeChildCompletion(requesterSessionKey, child, result, overrides),
  );
}

function setCompletionSessions() {
  sessionStore = {
    [childKey]: session("child-session"),
    [requesterKey]: session("requester-session"),
  };
}
function setRequesterSession(fields: SessionEntryFixture = {}) {
  sessionStore = { [requesterKey]: session("requester-session", fields) };
}
function parentChildren(
  children: MockSubagentRun[],
  requesterRunId?: string,
  otherTurn: MockSubagentRun[] = [],
) {
  sessionStore[parentKey] = session("session-parent");
  registry.listSubagentRunsForRequester.mockImplementation((key, scope) =>
    key !== parentKey
      ? []
      : requesterRunId && scope?.requesterRunId !== requesterRunId
        ? otherTurn
        : children,
  );
}

function binding(
  channel: string,
  conversationId: string,
  parentConversationId?: string,
  targetSessionKey = childKey,
) {
  return {
    bindingId: `${channel}:acct-1:${conversationId}`,
    targetSessionKey,
    targetKind: "subagent" as const,
    status: "active" as const,
    boundAt: 1,
    conversation: {
      channel,
      accountId: "acct-1",
      conversationId,
      ...(parentConversationId === undefined ? {} : { parentConversationId }),
    },
  };
}
function registerBoundSubagent(...bindings: SessionBindingRecord[]): void {
  const first = bindings[0]!;
  registerSessionBindingAdapter({
    channel: first.conversation.channel,
    accountId: first.conversation.accountId,
    listBySession: (key) => bindings.filter((row) => row.targetSessionKey === key),
    resolveByConversation: () => null,
  });
}

const announceFormatChannelPlugins = [
  ...(["discord", "telegram", "whatsapp", "imessage", "webchat"] as const).map((id) => ({
    pluginId: id,
    plugin: createChannelTestPluginBase({ id, label: id }),
    source: "test",
  })),
  {
    pluginId: "slack",
    plugin: {
      ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
      messaging: {
        resolveDeliveryTarget: (params: {
          conversationId: string;
          parentConversationId?: string;
        }) => ({
          to: `channel:${params.parentConversationId || params.conversationId}`,
          ...(params.parentConversationId ? { threadId: params.conversationId } : {}),
        }),
      },
    },
    source: "test",
  },
];

function setConfigOverride(next: OpenClawConfig): void {
  configOverride = next;
  setRuntimeConfigSnapshot(configOverride);
}

function readSessionFixture(sessionKey: string): SessionEntry | undefined {
  const entry: SessionEntryFixture | undefined =
    !(sessionKey in sessionStore) && sessionKey.includes(":subagent:")
      ? minimalUsage
      : sessionStore[sessionKey];
  return entry
    ? normalizeLegacySessionEntryDelivery({
        ...entry,
        sessionId: entry.sessionId ?? sessionKey,
        updatedAt: entry.updatedAt ?? Date.now(),
      } as SessionEntry)
    : undefined;
}

function createRegistryDiscoveryFixture() {
  return {
    ...registry,
    buildLatestSubagentSessionListReadIndex: () => ({ getLatestSubagentRun: () => null }),
    listSubagentRunsForRequester(sessionKey: string, scope?: { requesterRunId?: string }) {
      return registry
        .listSubagentRunsForRequester(sessionKey, scope)
        .map(publishAnnounceRunFixture);
    },
  };
}

vi.mock("../registry/subagent-registry.js", () => createRegistryDiscoveryFixture());
vi.mock("../registry/subagent-registry-read.js", () => createRegistryDiscoveryFixture());

const gatewayDeps = {
  callGateway: async <T = Record<string, unknown>>(
    req: Parameters<typeof gatewayCall.callGateway>[0],
  ) => (await callGatewaySpy(req)) as T,
  getRuntimeConfig: () => configOverride,
};

const deliveryDeps = {
  ...gatewayDeps,
  loadSessionEntry: (scope) => readSessionFixture(scope.sessionKey),
  loadSessionEntryByKey: async (sessionKey) => readSessionFixture(sessionKey),
  getRequesterSessionActivity: (requesterSessionKey: string, requester) => {
    const entry = readSessionFixture(requesterSessionKey);
    const sessionId = entry?.sessionId;
    return {
      sessionId,
      target: captureSessionTarget({
        storeScope: requester.storePath ?? sessionConfig.store,
        sessionKey: requester.canonicalKey,
        aliases: [requesterSessionKey],
        agentId: requester.agentId,
        incarnation: sessionId,
      }),
      isActive: Boolean(sessionId && isEmbeddedAgentRunActiveSpy(sessionId)),
    };
  },
} satisfies Parameters<typeof deliveryTesting.setDepsForTest>[0];

function expectParentAnnounce() {
  expect(sendSpy).not.toHaveBeenCalled();
  expect(agentSpy).toHaveBeenCalledTimes(1);
  return getAgentCall();
}

describe("subagent announce formatting", () => {
  function announceWithDefaults(params: AnnounceParams = {}) {
    return runSubagentAnnounceFlow({
      ...defaultOutcomeAnnounce,
      ...params,
      terminalReply:
        params.terminalReply ??
        prepareTerminal(params.roundOneReply ?? defaultOutcomeAnnounce.roundOneReply),
    });
  }
  async function expectAnnouncement(params: AnnounceParams, outcome = "delivered") {
    expect(await announceWithDefaults(params)).toBe(outcome);
    return expectParentAnnounce();
  }
  function announceCompletion(params: AnnounceParams = {}) {
    return announceWithDefaults({
      childRunId: "run-completion",
      requesterOrigin: discordOrigin,
      expectsCompletionMessage: true,
      ...params,
    });
  }

  async function deliverCompletion(params: AnnounceParams) {
    expect(await announceCompletion(params)).toBe("delivered");
    return expectParentAnnounce();
  }

  function announceWake(childSessionKey: string, childRunId: string, params: AnnounceParams = {}) {
    return announceWithDefaults({
      childSessionKey,
      childRunId,
      expectsCompletionMessage: true,
      wakeOnDescendantSettle: true,
      ...params,
    });
  }

  afterAll(() => {
    announceTesting.setDepsForTest();
    outputTesting.setDepsForTest();
    deliveryTesting.setDepsForTest();
    clearRuntimeConfigSnapshot();
    subagentRuns.clear();
  });

  beforeEach(() => {
    subagentRuns.clear();
    agentSpy.mockReset();
    sendSpy.mockClear();
    sessionsDeleteSpy.mockClear();
    callGatewaySpy.mockReset().mockImplementation(async (req: unknown) => {
      const typed = req as { method?: string; params?: { message?: string; sessionKey?: string } };
      if (typed.method === "agent") {
        return await agentSpy(typed);
      }
      if (typed.method === "send") {
        return await sendSpy(typed);
      }
      if (typed.method === "sessions.delete") {
        sessionsDeleteSpy(typed);
        return {};
      }
      return {};
    });
    deliveryTesting.setDepsForTest(deliveryDeps);
    announceTesting.setDepsForTest(gatewayDeps);
    transcriptEvents = [];
    outputTesting.setDepsForTest({
      findTranscriptEvent: async (_scope, match) => {
        const event = transcriptEvents.findLast((candidate) =>
          matchesTranscriptEvent(candidate, match),
        );
        return event === undefined ? undefined : { event };
      },
      ...gatewayDeps,
      readSubagentSessionEntry: (_storePath, sessionKey) => readSessionFixture(sessionKey),
      resolveSessionStorePathCore: () => "/tmp/sessions.json",
    });
    getGlobalHookRunnerSpy
      .mockReset()
      .mockImplementation(
        () => hookRunnerMock as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>,
      );
    isEmbeddedAgentRunActiveSpy.mockReset().mockReturnValue(false);
    waitForEmbeddedAgentRunEndSpy.mockReset().mockResolvedValue(true);
    registry.isSubagentSessionRunActive.mockClear().mockReturnValue(true);
    registry.shouldIgnorePostCompletionAnnounceForSession.mockClear().mockReturnValue(false);
    registry.countPendingDescendantRuns.mockReset().mockReturnValue(0);
    registry.listSubagentRunsForRequester.mockClear().mockReturnValue([]);
    registry.replaceSubagentRunAfterSteerCore.mockClear().mockReturnValue(true);
    registry.resolveRequesterForChildSession.mockClear().mockReturnValue(null);
    hasDeliveryTarget = false;
    deliveryTarget.mockReset().mockResolvedValue(undefined);
    sessionStore = {};
    sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(createTestRegistry(announceFormatChannelPlugins));
    setConfigOverride({ session: sessionConfig });
  });

  it.each(["local parent", "extension channel", "nested parent"] as const)(
    "preserves a producer route fact for a %s",
    async (name) => {
      const external = name === "extension channel";
      const nested = name === "nested parent";
      const origin = external ? { ...discordOrigin, channel: "imessage" } : undefined;
      const childSessionKey = nested ? `${orchestratorKey}:subagent:worker` : childKey;
      const requesterSessionKey = nested ? orchestratorKey : requesterKey;
      const modelRouteChange = "Model route changed: requested/model → actual/model.";
      const call = await expectAnnouncement({
        childSessionKey,
        requesterSessionKey,
        requesterOrigin: nested ? whatsappOrigin : origin,
        expectsCompletionMessage: external || nested,
        terminalReply: { disposition: "visible", text: "child result", modelRouteChange },
      });
      expect(call.params).toMatchObject(
        external
          ? { ...origin, deliver: true }
          : {
              sessionKey: requesterSessionKey,
              deliver: false,
              channel: undefined,
              to: undefined,
            },
      );
      expect(call.params?.internalEvents?.[0]?.result).toBe("child result");
      const message = getAgentCallContext(call);
      expect(message).toContain("completed; ready for parent review");
      expect(message).toContain(modelRouteChange);
      expect(message).toContain(
        name === "extension channel"
          ? "Keep runtime-authored model-route change notices internal on this shared surface."
          : "Preserve any runtime-authored model-route change notice in your update.",
      );
      if (nested) {
        expect(call.params?.role).toBeUndefined();
        expectInputProvenance(call.params, childSessionKey);
        expect(message).toContain(
          "Convert the reviewed outcome into a concise internal orchestration update for your parent agent",
        );
      }
    },
  );

  async function expectRealStoreUsage(
    entryPatch: Record<string, unknown>,
    expected: string,
    excluded: string,
  ): Promise<void> {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "announce-real-store-")),
    );
    const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
    try {
      await patchSessionEntryCore(
        { agentId: "main", sessionKey: childKey, storePath },
        () => ({ sessionId: "child-session-real-store", ...entryPatch }),
        {
          fallbackEntry: { sessionId: "child-session-real-store", updatedAt: Date.now() },
          skipMaintenance: true,
        },
      );
      // Drop both read overrides so the real announce reader reaches the session worker.
      deliveryTesting.setDepsForTest({
        ...deliveryDeps,
        loadSessionEntry: undefined,
      });
      outputTesting.setDepsForTest({
        ...gatewayDeps,
        resolveSessionStorePathCore: () => storePath,
      });
      await announceWithDefaults();
      expectText(getAgentCallContext(), ["Stats:", expected], [excluded]);
    } finally {
      await closeOpenClawAgentDatabasesAsync(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it.each([
    [{}, "tokens unknown", "tokens 0 (in 0 / out 0)"],
    [{ inputTokens: 0, outputTokens: 0 }, "tokens 0 (in 0 / out 0)", "tokens unknown"],
  ] as const)("announces real session-store usage %j", expectRealStoreUsage);

  it.each([true, false])("replays durable silence (completion required=%s)", async (required) => {
    expect(
      await announceCompletion({
        requesterOrigin: { channel: "slack", to: "channel:C123", accountId: "acct-1" },
        expectsCompletionMessage: required,
        terminalReply: { disposition: "silent" },
        roundOneReply: undefined,
      }),
    ).toBe("delivered");
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(required ? 1 : 0);
    if (required) {
      expect(getAgentCallContext()).toContain("(no output)");
    }
  });

  it("sends complete failure findings and usage privately without waiting for siblings", async () => {
    setConfigOverride({
      session: sessionConfig,
      messages: { groupChat: { visibleReplies: "message_tool" } },
    });
    registry.countPendingDescendantRuns.mockImplementation((key) => (key === requesterKey ? 1 : 0));
    const findings = `${"finding ".repeat(200)}complete-tail`;
    const outcome = { status: "error", error: "boom" } as const;
    const child = publishAnnounceRunFixture(
      makeChildCompletion(requesterKey, "test", findings, {
        runId: "run-direct-completion",
        childSessionKey: childKey,
        execution: { endedAt: 20, outcome },
      }),
    );
    setCompletionSessions();
    sessionStore[childKey] = session("child-session", {
      inputTokens: 12,
      outputTokens: 1000,
      totalTokens: 197000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    });
    const call = await deliverCompletion({
      childRunId: "run-direct-completion",
      roundOneReply: undefined,
      terminalReply: child.completion?.terminalReply,
      outcome,
    });
    expect(call.params).toMatchObject({
      channel: "discord",
      to: "channel:12345",
      sessionKey: requesterKey,
      deliver: false,
      sourceReplyDeliveryMode: "message_tool_only",
      message: RUNTIME_EVENT_USER_PROMPT,
    });
    expect(call.params?.internalEvents?.[0]).toMatchObject({
      type: "task_completion",
      childSessionId: "child-session",
      taskLabel: "do thing",
      statusLabel: "failed: boom",
      result: findings,
      statsLine: expect.stringMatching(
        /tokens 1\.0k \(in 12 \/ out 1\.0k\).*prompt\/cache 197\.0k/,
      ),
    });
    expectInputProvenance(call.params, childKey);
    expectText(
      getAgentCallContext(call),
      [findings, "Keep this internal context private"],
      [SILENT_REPLY_TOKEN, "✅ Subagent", "There are still", "wait for the remaining results"],
    );
  });

  it("does not duplicate to main channel when two active bound sessions complete from the same requester channel", async () => {
    sessionStore = {
      "agent:main:subagent:child-a": session("child-session-a"),
      "agent:main:subagent:child-b": session("child-session-b"),
      [requesterKey]: session("requester-session-main"),
    };

    registry.countPendingDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === requesterKey ? 2 : 0,
    );
    registerBoundSubagent(
      ...["a", "b"].map((child) =>
        binding(
          "discord",
          `thread-child-${child}`,
          "main-parent-channel",
          `agent:main:subagent:child-${child}`,
        ),
      ),
    );

    await Promise.all(
      ["a", "b"].map((child) =>
        announceCompletion({
          childSessionKey: `agent:main:subagent:child-${child}`,
          childRunId: `run-child-${child}`,
          requesterOrigin: {
            channel: "discord",
            to: "channel:main-parent-channel",
            accountId: "acct-1",
          },
          spawnMode: "session",
        }),
      ),
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(2);

    expect(
      agentSpy.mock.calls
        .map(([call]) => call.params?.to)
        .toSorted((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(["channel:thread-child-a", "channel:thread-child-b"]);
  });

  it.each([
    [{ status: "timeout" }, "timed out"],
    [
      { status: "timeout", error: "child run failed before completing" },
      "timed out: child run failed before completing",
    ],
  ] as const)("includes completion status details: %s", async (outcome, expectedStatus) => {
    setCompletionSessions();
    await deliverCompletion({ roundOneReply: "child details", outcome });
    expectText(getAgentCallContext(), [expectedStatus, "child details"], ["✅ Subagent"]);
  });

  const telegramRoute = { channel: "telegram", to: "telegram:123" };
  const telegramSession = { lastChannel: "telegram", lastTo: "telegram:123", lastThreadId: 42 };
  const slackRoute = { channel: "slack", to: "channel:C123", accountId: "acct-1" };
  type RouteCase = [
    name: string,
    origin: AnnounceParams["requesterOrigin"],
    expected: Record<string, unknown>,
    setup: () => void,
    completion?: boolean,
  ];
  const hookTarget = (origin?: AnnounceParams["requesterOrigin"]) => () => {
    hasDeliveryTarget = true;
    deliveryTarget.mockResolvedValueOnce(origin ? { origin } : undefined);
  };
  it.each<RouteCase>([
    [
      "missing requester conversation",
      { channel: "discord", accountId: "acct-1" },
      { deliver: false, to: undefined, threadId: undefined },
      () => registerBoundSubagent(binding("discord", "thread-bound-1", "parent-main")),
    ],
    [
      "stale stored thread",
      discordOrigin,
      { channel: "discord", to: "channel:12345", threadId: undefined },
      () =>
        setRequesterSession({ lastChannel: "discord", lastTo: "channel:stale", lastThreadId: 42 }),
    ],
    [
      "bound Slack channel",
      slackRoute,
      { ...slackRoute, threadId: undefined },
      () => registerBoundSubagent(binding("slack", "C123")),
    ],
    [
      "bound Slack thread",
      { ...slackRoute, threadId: "171.1" },
      { ...slackRoute, threadId: "171.1" },
      () => registerBoundSubagent(binding("slack", "171.1", "C123")),
    ],
    [
      "hook override",
      { ...discordOrigin, threadId: "999" },
      { channel: "discord", to: "channel:777", threadId: "777" },
      hookTarget({ channel: "discord", accountId: "acct-1", to: "channel:777", threadId: "777" }),
    ],
    ["no hook override", discordOrigin, { ...discordOrigin, threadId: undefined }, hookTarget()],
    [
      "internal hook override",
      discordOrigin,
      { ...discordOrigin, threadId: undefined },
      hookTarget({ channel: "webchat", to: "conversation:123" }),
    ],
    [
      "stored thread",
      undefined,
      { ...telegramRoute, threadId: "42" },
      () => setRequesterSession(telegramSession),
      false,
    ],
    [
      "explicit thread over stored thread",
      { ...telegramRoute, threadId: 99 },
      { ...telegramRoute, threadId: "99" },
      () => setRequesterSession(telegramSession),
      false,
    ],
  ])(
    "routes an announcement using %s",
    async (_name, origin, expected, setup, completion = true) => {
      setCompletionSessions();
      setup();
      const call = await deliverCompletion({
        requesterOrigin: origin,
        expectsCompletionMessage: completion,
        spawnMode: completion ? "session" : undefined,
      });
      expect(call.params).toMatchObject(expected);
      expect(call).toMatchObject({ expectFinal: true });
    },
  );

  it("keeps direct announce idempotency unique for same-ms distinct child runs", async () => {
    setRequesterSession({
      lastChannel: "whatsapp",
      lastTo: "+1555",
      queueMode: "collect",
      queueDebounceMs: 0,
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    onTestFinished(() => nowSpy.mockRestore());
    for (const childRunId of ["run-1", "run-2"]) {
      await announceWithDefaults({
        childSessionKey: childKey,
        childRunId,
        requesterSessionKey: "main",
        requesterOrigin: { accountId: `acct-${childRunId}` },
      });
    }
    expect(agentSpy.mock.calls.map(([call]) => call.params?.idempotencyKey)).toEqual([
      `announce:v1:${childKey}:run-1`,
      `announce:v1:${childKey}:run-2`,
    ]);
    expect(agentSpy.mock.calls.map(([call]) => call.params?.accountId)).toEqual([
      "acct-run-1",
      "acct-run-2",
    ]);
  });

  it.each([true, false])(
    "settles an active child before delivery (settled=%s)",
    async (settled) => {
      isEmbeddedAgentRunActiveSpy.mockReturnValueOnce(true).mockReturnValue(!settled);
      waitForEmbeddedAgentRunEndSpy.mockResolvedValue(settled);
      sessionStore = { [childKey]: session("child-session-1", minimalUsage) };
      expect(
        await announceWithDefaults({ timeoutMs: 1000, expectsCompletionMessage: !settled }),
      ).toBe(settled ? "delivered" : "retryable");
      if (settled) {
        expect(waitForEmbeddedAgentRunEndSpy).toHaveBeenCalledWith("child-session-1", 1000);
        expectText(getAgentCallContext(), ["raw subagent reply"], ["(no output)"]);
      } else {
        expect(agentSpy).not.toHaveBeenCalled();
        expect(sendSpy).not.toHaveBeenCalled();
      }
    },
  );

  it.each([600, undefined])(
    "wakes an ended orchestrator with current child results and its %s-second budget before upward announce",
    async (runTimeoutSeconds) => {
      const parentRunId = "run-parent-phase-1";
      parentChildren(
        childCompletions(
          parentKey,
          ["a", "obsolete-A", { runId: "old-a", createdAt: 9 }],
          ["a", "current-A", { runId: "new-a" }],
          ["b", "current-B", { runId: "new-b", createdAt: 11 }],
        ),
        parentRunId,
        childCompletions(parentKey, ["old-turn", "obsolete-turn", { createdAt: 1 }]),
      );
      transcriptEvents.push(assistantEvent("new-a", "late-progress", false));
      agentSpy.mockResolvedValueOnce(visibleAgentResponse("run-parent-phase-2:wake"));
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      registry.countPendingDescendantRuns.mockReturnValueOnce(1);
      expect(await announceWake(parentKey, parentRunId)).toBe("retryable");
      expect(agentSpy).not.toHaveBeenCalled();
      const didAnnounce = await announceWake(parentKey, parentRunId, {
        runTimeoutSeconds,
        roundOneReply: "placeholder waiting text that should be ignored",
      });

      expect(didAnnounce).toBe("delivered");
      expect(registry.listSubagentRunsForRequester).toHaveBeenCalledWith(parentKey, {
        requesterRunId: parentRunId,
      });
      expect(agentSpy).toHaveBeenCalledTimes(1);
      const call = getAgentCall();
      expect(call.params).toMatchObject({ sessionKey: parentKey, timeout: runTimeoutSeconds ?? 0 });
      const message = getAgentCallContext(call);
      expectText(
        message,
        ["current-A", "current-B"],
        [
          "obsolete-A",
          "obsolete-turn",
          "placeholder waiting text that should be ignored",
          "late-progress",
        ],
      );
      expect(message.match(/current-A/g)).toHaveLength(1);
      expect(registry.replaceSubagentRunAfterSteerCore).toHaveBeenCalledWith({
        previousRunId: parentRunId,
        nextRunId: "run-parent-phase-2:wake",
        lifecycleGeneration,
        preserveFrozenResultFallback: true,
        task: expect.stringContaining("All pending descendants for that run have now settled"),
      });
      registry.replaceSubagentRunAfterSteerCore.mockClear();
      parentChildren(childCompletions(parentKey, ["a", "current-A"]));
      expect(
        await announceWake(parentKey, "run-parent-phase-2:wake", {
          roundOneReply: "own synthesized answer",
        }),
      ).toBe("delivered");
      expect(registry.replaceSubagentRunAfterSteerCore).not.toHaveBeenCalled();
      expect(agentSpy).toHaveBeenCalledTimes(2);
      expect(getAgentCall(1).params?.sessionKey).toBe(requesterKey);
      expectText(
        getAgentCallContext(getAgentCall(1)),
        ["own synthesized answer"],
        ["current-A", "current-B", "All pending descendants"],
      );
    },
  );

  it.each([
    ["existing parent", "alive", parentKey],
    ["deleted parent", undefined, requesterKey],
    ["blank parent sessionId", " ", requesterKey],
    ["completed parent", "completed", undefined],
    ["missing fallback", undefined, undefined],
  ] as const)("routes ended parent: %s", async (mode, parentId, destination) => {
    registry.isSubagentSessionRunActive.mockReturnValue(false);
    sessionStore = { [parentKey]: parentId === undefined ? undefined : session(parentId) };
    registry.shouldIgnorePostCompletionAnnounceForSession.mockReturnValue(
      mode === "completed parent",
    );
    registry.countPendingDescendantRuns.mockReturnValue(mode === "completed parent" ? 2 : 0);
    if (destination) {
      registry.resolveRequesterForChildSession.mockReturnValue({
        requesterSessionKey: destination,
        requesterOrigin: { channel: "discord", accountId: "jaris-account" },
      });
    }
    expect(
      await announceWithDefaults({
        childRunId: mode,
        requesterSessionKey: parentKey,
        cleanup: mode === "missing fallback" ? "delete" : "keep",
      }),
    ).toBe(mode === "missing fallback" ? "retryable" : "delivered");
    if (destination) {
      expectAgentCallFields(getAgentCall(), { sessionKey: destination, deliver: false });
      expect(getAgentCall().params?.channel).toBe(
        destination === requesterKey ? "discord" : undefined,
      );
    } else {
      expect(agentSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(sessionsDeleteSpy).not.toHaveBeenCalled();
    }
  });
});
