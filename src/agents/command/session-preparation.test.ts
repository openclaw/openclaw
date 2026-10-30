import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildSourceConversationContext, buildGroupIntro } from "../../auto-reply/reply/groups.js";
import { buildInboundMetaSystemPrompt } from "../../auto-reply/reply/inbound-meta.js";
import type { TemplateContext } from "../../auto-reply/templating.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import { resolveVisibleActiveSessionRunState } from "../../gateway/server-methods/session-active-runs.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { splitExtraSystemPrompt } from "../internal-runtime-context.js";
import { createOperatorRecoveryAuthority } from "../operator-recovery.test-support.js";
import {
  prepareCommandSessionRecoveryEntry,
  prepareEmbeddedSessionState,
} from "./session-preparation.js";

vi.mock("../subagents/registry/subagent-registry-read.js", () => ({
  getLatestLiveSubagentRunByChildSessionKey: () => undefined,
  isSubagentRunQueued: () => false,
}));
vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionHumanDirectMessage: vi.fn(),
}));
vi.mock("../../skills/discovery/agent-filter.js", () => ({
  resolveEffectiveAgentSkillFilter: () => undefined,
}));
// mock-isolation: Session-preparation tests own their skill snapshot and exec eligibility without host storage.
vi.mock("./runtime-loaders.js", () => ({
  loadSkillsRuntime: async () => ({
    getRemoteSkillEligibility: () => ({}),
    resolveReusableWorkspaceSkillSnapshot: skillSnapshot,
  }),
  loadExecDefaultsRuntime: async () => ({
    resolveNodeExecEligibilityAsync: () => ({ canExec: false }),
  }),
}));

const { skillSnapshot } = vi.hoisted(() => ({
  skillSnapshot: vi.fn(() => ({
    snapshot: undefined as SessionEntry["skillsSnapshot"],
    shouldRefresh: false,
  })),
}));

type Prepare = Parameters<typeof prepareEmbeddedSessionState>[0];
const preparedRunId = "command-session-test";
function prepare(params: Pick<Prepare, "opts"> & Partial<Prepare>) {
  return prepareEmbeddedSessionState({
    runId: preparedRunId,
    cfg: {},
    sessionAgentId: "main",
    sessionId: "conversation-id",
    storePath: "/unused/command.sqlite",
    lifecycleGeneration: getAgentRunLifecycleGeneration(),
    executionWorkspaceDir: "/workspace",
    watchSkills: false,
    isNewSession: false,
    isSubagentLaneTurn: false,
    suppressVisibleSessionEffects: true,
    sessionStateActor: { actorType: "agent" },
    ...params,
  });
}
afterEach(() => {
  clearAgentRunContext(preparedRunId);
  skillSnapshot.mockReturnValue({ snapshot: undefined, shouldRefresh: false });
  resetPluginRuntimeStateForTest();
});

it.each([
  { refresh: true, skipTouch: false, current: "original" },
  { refresh: true, skipTouch: true, current: "original" },
  { refresh: false, skipTouch: false, current: "original" },
  { refresh: false, skipTouch: true, current: "original" },
  { refresh: true, skipTouch: false, current: "policy-cleared" },
  { refresh: true, skipTouch: false, current: "deleted" },
  { refresh: true, skipTouch: false, current: "replaced" },
])(
  "prepares session metadata against the current row (refresh=$refresh, skipTouch=$skipTouch, current=$current)",
  async (testCase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:prepare-metadata";
      const scope = {
        agentId: "main",
        sessionKey,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const initial = (await replaceSessionEntry(scope, {
        sessionId: "metadata-session",
        updatedAt: 1,
        sessionStartedAt: 1,
        lastInteractionAt: 1,
        agentStatus: { note: "busy", expiresAt: 10 },
        elevatedLevel: "full",
        inheritedToolAllow: ["exec"],
        sendPolicy: "allow",
      }))!;
      const snapshot = { prompt: "skill instructions", skills: [], version: 1 };
      const store: Record<string, SessionEntry> = { [sessionKey]: initial };
      if (testCase.current === "policy-cleared" || testCase.current === "replaced") {
        const replaced = testCase.current === "replaced";
        await replaceSessionEntry(scope, {
          sessionId: replaced ? "replacement-session" : initial.sessionId,
          updatedAt: 2,
          label: replaced ? "Replacement" : "Renamed while preparing",
          ...(replaced ? {} : { sessionStartedAt: 1, sendPolicy: "deny" as const }),
        });
      } else if (testCase.current === "deleted") {
        await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
      }
      const before = loadSessionEntry({ ...scope, readConsistency: "latest" });
      if (testCase.current === "deleted") {
        expect(before).toBeUndefined();
      } else if (testCase.current === "replaced") {
        expect(before?.sessionId).toBe("replacement-session");
      }
      skillSnapshot.mockReturnValue({
        snapshot: testCase.refresh ? snapshot : undefined,
        shouldRefresh: testCase.refresh,
      });
      const prepared = await prepare({
        opts: { message: "hello", skipInitialSessionTouch: testCase.skipTouch },
        sessionEntry: initial,
        sessionStore: store,
        sessionKey,
        sessionId: initial.sessionId,
        storePath: scope.storePath,
        executionWorkspaceDir: state.workspaceDir,
        isSubagentLaneTurn: true,
        suppressVisibleSessionEffects: false,
        sessionStateActor: { actorType: "human" },
      });
      const persisted = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(persisted).toEqual(prepared.sessionEntry);
      expect(store[sessionKey]).toEqual(prepared.sessionEntry);
      if (testCase.current === "deleted" || testCase.current === "replaced") {
        expect(prepared.sessionEntry).toEqual(before);
        return;
      }
      expect(prepared.sessionEntry).toMatchObject({
        sessionId: "metadata-session",
        sessionStartedAt: 1,
        lastInteractionAt: testCase.skipTouch ? 1 : expect.any(Number),
      });
      expect(prepared.sessionEntry?.skillsSnapshot).toEqual(
        testCase.refresh ? snapshot : undefined,
      );
      expect(prepared.sessionEntry?.agentStatus).toEqual(
        testCase.skipTouch ? { note: "busy", expiresAt: 10 } : undefined,
      );
      if (testCase.current === "policy-cleared") {
        expect(prepared.sessionEntry).toMatchObject({
          label: "Renamed while preparing",
          sendPolicy: "deny",
        });
        expect(prepared.sessionEntry?.elevatedLevel).toBeUndefined();
        expect(prepared.sessionEntry?.inheritedToolAllow).toBeUndefined();
      }
    });
  },
);

it.each([
  { sourceTool: "subagent_settle", requesterProfileId: undefined, retained: true },
  { sourceTool: "subagent_announce", requesterProfileId: undefined, retained: false },
  { sourceTool: "sessions_send", requesterProfileId: undefined, retained: false },
  { sourceTool: "subagent_settle", requesterProfileId: "another-operator", retained: false },
  { sourceTool: "sessions_send", requesterProfileId: "original-operator", retained: true },
])(
  "binds operator recovery custody for $sourceTool from $requesterProfileId",
  ({ sourceTool, requesterProfileId, retained }) => {
    const runId = "announce:requester-settle:main:agent:main:main:child-run";
    const operatorAuthority = createOperatorRecoveryAuthority(
      "original-operator",
      "original-grant",
    );
    const { nextEntry } = prepareCommandSessionRecoveryEntry({
      entry: {
        sessionId: "requester-session",
        lifecycleRevision: "requester-revision",
        updatedAt: 1,
      },
      sessionId: "requester-session",
      sessionKey: "agent:main:main",
      agentId: "main",
      runId,
      now: 2,
      lifecycleGeneration: "current-generation",
      isSessionRollover: false,
      opts: {
        message: "Child completed",
        operatorAuthority,
        requesterOrigin: requesterProfileId
          ? { sessionKey: "agent:main:main", operatorProfileId: requesterProfileId }
          : undefined,
        inputProvenance: {
          kind: "inter_session",
          sourceTool,
          sourceChannel: sourceTool === "sessions_send" ? "webchat" : "internal",
          sourceSessionKey: "agent:main:subagent:child",
        },
      },
    });
    if (!retained) {
      expect(nextEntry.restartRecoveryOperatorSource).toBeUndefined();
      return;
    }
    expect(nextEntry).toMatchObject({
      restartRecoveryDeliverySourceRunId: runId,
      restartRecoverySourceIngress: "internal",
      restartRecoveryOperatorSource: {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "requester-session",
        lifecycleRevision: "requester-revision",
        sourceRunId: runId,
        snapshot: {
          profileId: "original-operator",
          scopes: ["operator.read"],
          controlUiAdmin: false,
        },
      },
    });
  },
);

it.each(["channel", "delegate", "generated-media", "recovery"] as const)(
  "binds requester facts to the existing %s command recovery claim",
  (kind) => {
    const requesterOrigin = {
      sessionKey: "agent:research:telegram:group:requesters",
      messageProvider: "telegram",
      senderId: "bob",
    };
    const entry: InternalSessionEntry = {
      sessionId: "destination-session",
      lifecycleRevision: "destination-lifecycle",
      updatedAt: 1,
      ...(kind === "recovery"
        ? {
            restartRecoveryDeliveryRunId: "current-run",
            restartRecoveryDeliverySourceRunId: "original-run",
            restartRecoverySourceIngress: "internal" as const,
            restartRecoveryRequesterSource: {
              agentId: "main",
              sessionKey: "agent:main:destination",
              sessionId: "destination-session",
              lifecycleRevision: "destination-lifecycle",
              sourceRunId: "original-run",
              requesterOrigin: { ...requesterOrigin, senderId: "original-requester" },
            },
          }
        : {}),
    };
    const prepared = prepareCommandSessionRecoveryEntry({
      agentId: "main",
      sessionKey: "agent:main:destination",
      sessionId: entry.sessionId,
      entry,
      runId: "current-run",
      now: 2,
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      isSessionRollover: false,
      opts: {
        message: "continue accepted work",
        requesterOrigin,
        inputProvenance:
          kind === "channel"
            ? undefined
            : {
                kind: "inter_session",
                sourceTool: kind === "generated-media" ? "subagent_settle" : "sessions_send",
              },
        ...(kind === "generated-media"
          ? { internalDeliveryMediaUrls: ["/synthetic/result.png"] }
          : {}),
      },
    });
    requesterOrigin.senderId = "replacement";
    expect(prepared.nextEntry).toMatchObject({
      restartRecoveryDeliveryRunId: "current-run",
      restartRecoveryDeliverySourceRunId: kind === "recovery" ? "original-run" : "current-run",
      restartRecoverySourceIngress: kind === "channel" ? "channel" : "internal",
      restartRecoveryRequesterSource: {
        agentId: "main",
        sessionKey: "agent:main:destination",
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        sourceRunId: kind === "recovery" ? "original-run" : "current-run",
        requesterOrigin: { senderId: kind === "recovery" ? "original-requester" : "bob" },
      },
    });
  },
);

it.each([
  { internal: false, coordination: false },
  { internal: true, coordination: false },
  { internal: false, coordination: true },
])(
  "projects command startup and capacity waits (internal=$internal, coordination=$coordination)",
  async ({ internal, coordination }) => {
    const sessionKey = "agent:main:command-activity";
    const sessionId = "command-activity-session";
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    const state = () =>
      resolveVisibleActiveSessionRunState({
        storePath: "/unused/command.sqlite",
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
        agentId: "main",
      });

    let releaseWait: (() => void) | undefined;
    try {
      await prepare({
        opts: {
          message: "hello",
          ...(coordination
            ? {
                inputProvenance: {
                  kind: "inter_session" as const,
                  sourceTool: "sessions_send",
                  sourceRole: "subagent" as const,
                },
              }
            : {}),
        },
        sessionKey,
        sessionId,
        lifecycleGeneration,
        suppressVisibleSessionEffects: internal,
        sessionStateActor: { actorType: "human" },
      });
      const hidden = internal || coordination;
      const active = hidden ? { active: false, runIds: [] } : { active: true };
      expect(state()).toEqual(active);
      releaseWait = registerAgentRunCapacityWait(preparedRunId, lifecycleGeneration);
      expect(state()).toEqual(hidden ? active : { active: true, status: "queued" });
      releaseWait?.();
      expect(state()).toEqual(active);
    } finally {
      releaseWait?.();
      clearAgentRunContext(preparedRunId);
    }
    expect(state()).toEqual({ active: false, runIds: [] });
  },
);

it.each([
  ["subagent_settle", "persistent"],
  ["sessions_send", "persistent"],
  ["sessions_send", "turn"],
  ["subagent_announce", "turn"],
  ["sessions_send", "span"],
])("keeps %s instructions in their %s scope", async (sourceTool, placement) => {
  const prompt = "Turn instructions.\n\nPersistent policy.";
  for (const sessionKey of ["agent:main:cron:nightly:run:123", "agent:main:subagent:123"]) {
    const completion = placement !== "persistent";
    const { opts } = await prepare({
      opts: {
        message: "Child finished.",
        extraSystemPrompt: prompt,
        inputProvenance: { kind: "inter_session", sourceTool },
        runContext: { messageChannel: "webchat" },
        replyExpectation: completion && sourceTool === "sessions_send" ? "optional" : undefined,
        privateCompletion: completion && sourceTool === "subagent_announce" ? true : undefined,
        extraSystemPromptTurnContext:
          placement === "span" ? { start: 0, text: "Turn instructions." } : undefined,
      },
      sessionKey,
      isSubagentLaneTurn: sessionKey.includes(":subagent:"),
      sessionEntry: {
        sessionId: "conversation-id",
        updatedAt: 1,
        chatType: "direct",
        delivery: { kind: "internal" },
      },
    });
    expect(opts.extraSystemPrompt).toBe(prompt);
    expect(opts.silentReplyPromptMode).toBeUndefined();
    expect(splitExtraSystemPrompt(opts)).toEqual({
      persistent: placement === "turn" ? "" : placement === "span" ? "Persistent policy." : prompt,
      turn: placement === "turn" ? prompt : placement === "span" ? "Turn instructions." : undefined,
    });
  }
});

it.each([
  ["webchat", "direct", undefined, false],
  ["webchat", "direct", true, false],
  ["slack", "direct", undefined, false],
  ["slack", "channel", undefined, false],
  ["webchat", "direct", undefined, true],
] as const)(
  "preserves %s %s completion context (private=%s, returned=%s)",
  async (channel, chatType, privateCompletion, returned) => {
    const sessionKey = "agent:main:conversation";
    const shared = chatType === "channel";
    const sourceTool = returned ? "sessions_send" : "subagent_settle";
    const guidance = returned ? "Consume this returned result once." : undefined;
    const ctx: TemplateContext = {
      Provider: channel,
      Surface: channel,
      OriginatingChannel: channel,
      ChatType: chatType,
      ...(channel === "slack"
        ? { AccountId: "work", OriginatingTo: "C123", MessageThreadId: "42" }
        : {}),
    };
    const entry: SessionEntry = {
      sessionId: "conversation-id",
      updatedAt: 1,
      chatType,
      groupActivation: shared ? "always" : undefined,
      delivery:
        channel === "webchat"
          ? { kind: "internal" }
          : normalizeSessionDeliveryState({
              context: { channel, to: "C123", accountId: "work", threadId: "42" },
              origin: { provider: channel, surface: channel, chatType },
            }),
    };
    const normalContext = [
      buildInboundMetaSystemPrompt(ctx, {}),
      buildSourceConversationContext({ sessionCtx: ctx }),
      shared && buildGroupIntro({ activation: "always", defaultActivation: "mention" }),
    ]
      .filter(Boolean)
      .join("\n\n");
    const prepared = await prepare({
      opts: {
        message: "Child finished.",
        channel,
        to: ctx.OriginatingTo,
        accountId: ctx.AccountId,
        threadId: ctx.MessageThreadId,
        privateCompletion,
        replyExpectation: returned ? "optional" : undefined,
        extraSystemPrompt: guidance,
        inputProvenance: { kind: "inter_session", sourceTool },
      },
      sessionEntry: entry,
      sessionKey,
    });
    const turn = returned ? `${normalContext}\n\n${guidance}` : normalContext;
    expect(prepared.opts.extraSystemPrompt).toBe(turn);
    expect(splitExtraSystemPrompt(prepared.opts)).toEqual({ persistent: "", turn });
    expect(prepared.opts.privateCompletion).toBe(privateCompletion);
    expect(prepared.opts.silentReplyPromptMode).toBe("none");
    expect(prepared.opts.inputProvenance).toEqual({ kind: "inter_session", sourceTool });
  },
);

it.each([
  { deliver: true, replyAccountId: "rich", markup: "markdown_telegram_rich" },
  { deliver: true, replyAccountId: "plain", markup: "markdown" },
  { deliver: false, replyAccountId: undefined, markup: undefined },
])("uses the delivering account's format once ($deliver, $replyAccountId)", async (testCase) => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "telegram",
            outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
          }),
          agentPrompt: {
            inboundFormattingHints: ({ accountId }) => ({
              text_markup: accountId === "rich" ? "markdown_telegram_rich" : "markdown",
              rules: [],
            }),
          },
        } satisfies ChannelPlugin,
      },
    ]),
  );
  const ctx: TemplateContext = {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "1222",
    AccountId: "rich",
    ChatType: "direct",
  };
  const { opts: prepared } = await prepare({
    opts: {
      message: "Child finished.",
      deliver: testCase.deliver,
      replyAccountId: testCase.replyAccountId,
      inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
      runContext: { messageChannel: "telegram", currentChannelId: "1222", accountId: "rich" },
    },
    sessionKey: "agent:main:telegram:direct:1222",
    sessionEntry: {
      sessionId: "conversation-id",
      updatedAt: 1,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "1222", accountId: "rich" },
        origin: { provider: "telegram", surface: "telegram", chatType: "direct" },
      }),
    },
  });
  const prompt = prepared.extraSystemPrompt ?? "";
  expect(prompt).toContain('"account_id": "rich"');
  expect(prompt.split("### Delivery Format")).toHaveLength(testCase.deliver ? 2 : 1);
  if (testCase.markup) {
    expect(prompt).toContain(`"text_markup": "${testCase.markup}"`);
  }
  if (testCase.replyAccountId === "rich") {
    expect(prompt).toBe(
      [
        buildInboundMetaSystemPrompt(ctx, {}),
        buildSourceConversationContext({ sessionCtx: ctx }),
      ].join("\n\n"),
    );
  }
});
