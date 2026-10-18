import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildSourceConversationContext, buildGroupIntro } from "../../auto-reply/reply/groups.js";
import { buildInboundMetaSystemPrompt } from "../../auto-reply/reply/inbound-meta.js";
import type { TemplateContext } from "../../auto-reply/templating.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import type { SessionEntry } from "../../config/sessions/types.js";
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
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";
import { prepareCommandConversationContext } from "./conversation-context.js";
import {
  prepareCommandSessionRecoveryEntry,
  prepareEmbeddedSessionState,
} from "./session-preparation.js";

vi.mock("../embedded-agent-runner/runs.js", () => ({
  resolveEmbeddedAgentSessionProgressState: () => undefined,
}));
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
      const runId = "prepare-metadata";
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
      if (testCase.current === "policy-cleared") {
        await replaceSessionEntry(scope, {
          sessionId: initial.sessionId,
          updatedAt: 2,
          sessionStartedAt: 1,
          label: "Renamed while preparing",
          sendPolicy: "deny",
        });
      } else if (testCase.current === "replaced") {
        await replaceSessionEntry(scope, {
          sessionId: "replacement-session",
          updatedAt: 2,
          label: "Replacement",
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
      try {
        const prepared = await prepareEmbeddedSessionState({
          cfg: {},
          opts: { message: "hello", skipInitialSessionTouch: testCase.skipTouch },
          sessionEntry: initial,
          sessionStore: store,
          sessionKey,
          sessionId: initial.sessionId,
          storePath: scope.storePath,
          sessionAgentId: "main",
          lifecycleGeneration: getAgentRunLifecycleGeneration(),
          runId,
          executionWorkspaceDir: state.workspaceDir,
          watchSkills: false,
          isNewSession: false,
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
      } finally {
        skillSnapshot.mockReturnValue({ snapshot: undefined, shouldRefresh: false });
        clearAgentRunContext(runId);
      }
    });
  },
);

it.each(["subagent_settle", "subagent_announce", "sessions_send"])(
  "retains original operator recovery custody only for the exact requester settle source: %s",
  (sourceTool) => {
    const runId = "announce:requester-settle:main:agent:main:main:child-run";
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "original-operator",
      scopes: ["operator.read"],
      assertCurrent() {},
      recoverySnapshot: {
        profileId: "original-operator",
        scopes: ["operator.read"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "original-grant",
          role: "operator",
          authMethod: "token",
        },
        controlUiAdmin: false,
        localOperator: false,
        sourceIngress: "control-ui",
      },
    });
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
        inputProvenance: {
          kind: "inter_session",
          sourceTool,
          sourceChannel: "internal",
          sourceSessionKey: "agent:main:subagent:child",
        },
      },
    });
    if (sourceTool !== "subagent_settle") {
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

it.each([
  { internal: false, coordination: false },
  { internal: true, coordination: false },
  { internal: false, coordination: true },
])(
  "projects command startup and capacity waits (internal=$internal, coordination=$coordination)",
  async ({ internal, coordination }) => {
    const runId = "command-activity";
    const sessionKey = "agent:main:command-activity";
    const sessionId = "command-activity-session";
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    const state = () =>
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
        agentId: "main",
      });

    let releaseWait: (() => void) | undefined;
    try {
      await prepareEmbeddedSessionState({
        cfg: {},
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
        storePath: "/unused/command.sqlite",
        sessionAgentId: "main",
        lifecycleGeneration,
        runId,
        executionWorkspaceDir: "/workspace",
        watchSkills: false,
        isNewSession: false,
        isSubagentLaneTurn: false,
        suppressVisibleSessionEffects: internal,
        sessionStateActor: { actorType: "human" },
      });
      const hidden = internal || coordination;
      const active = hidden ? { active: false, runIds: [] } : { active: true };
      expect(state()).toEqual(active);
      releaseWait = registerAgentRunCapacityWait(runId, lifecycleGeneration);
      expect(state()).toEqual(hidden ? active : { active: true, status: "queued" });
      releaseWait?.();
      expect(state()).toEqual(active);
    } finally {
      releaseWait?.();
      clearAgentRunContext(runId);
    }
    expect(state()).toEqual({ active: false, runIds: [] });
  },
);

it.each(["agent:main:cron:nightly:run:123", "agent:main:subagent:123"])(
  "retains the isolated task's prompt for %s",
  async (sessionKey) => {
    const opts = await prepareCommandConversationContext({
      cfg: {},
      opts: {
        message: "Child finished.",
        extraSystemPrompt: "Continue the isolated task.",
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
      },
      runContext: { messageChannel: "webchat" },
      sessionKey,
      sessionAgentId: "main",
      sessionEntry: {
        sessionId: "isolated-id",
        updatedAt: 1,
        chatType: "direct",
        delivery: { kind: "internal" },
      },
    });
    expect(opts.extraSystemPrompt).toBe("Continue the isolated task.");
    expect(opts.silentReplyPromptMode).toBeUndefined();
  },
);

it.each([
  { channel: "webchat", chatType: "direct", privateCompletion: undefined },
  { channel: "webchat", chatType: "direct", privateCompletion: true },
  { channel: "slack", chatType: "direct", privateCompletion: undefined },
  { channel: "slack", chatType: "channel", privateCompletion: undefined },
] as const)(
  "preserves the $channel $chatType system prompt on completion (private=$privateCompletion)",
  async ({ channel, chatType, privateCompletion }) => {
    const sessionKey = "agent:main:conversation";
    const runId = "announce:conversation";
    const shared = chatType === "channel";
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
    try {
      const prepared = await prepareEmbeddedSessionState({
        cfg: {},
        opts: {
          message: "Child finished.",
          channel,
          to: ctx.OriginatingTo,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          privateCompletion,
          inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        },
        sessionEntry: entry,
        sessionKey,
        sessionId: entry.sessionId,
        storePath: "/unused/command.sqlite",
        sessionAgentId: "main",
        lifecycleGeneration: getAgentRunLifecycleGeneration(),
        runId,
        executionWorkspaceDir: "/workspace",
        watchSkills: false,
        isNewSession: false,
        isSubagentLaneTurn: false,
        suppressVisibleSessionEffects: true,
        sessionStateActor: { actorType: "agent" },
      });
      const prompt = (extraSystemPrompt?: string) =>
        buildAgentSystemPrompt({
          workspaceDir: "/workspace",
          toolNames: ["sessions_spawn", "sessions_yield"],
          extraSystemPrompt,
          silentReplyPromptMode: "none",
        });
      expect(prompt(prepared.opts.extraSystemPrompt)).toBe(prompt(normalContext));
      expect(prepared.opts.privateCompletion).toBe(privateCompletion);
      expect(prepared.opts.silentReplyPromptMode).toBe("none");
      expect(prepared.opts.inputProvenance).toEqual({
        kind: "inter_session",
        sourceTool: "subagent_settle",
      });
    } finally {
      clearAgentRunContext(runId);
    }
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
  try {
    const ctx: TemplateContext = {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "1222",
      AccountId: "rich",
      ChatType: "direct",
    };
    const prepared = await prepareCommandConversationContext({
      cfg: {},
      opts: {
        message: "Child finished.",
        deliver: testCase.deliver,
        replyAccountId: testCase.replyAccountId,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
      },
      runContext: { messageChannel: "telegram", currentChannelId: "1222", accountId: "rich" },
      sessionKey: "agent:main:telegram:direct:1222",
      sessionAgentId: "main",
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
  } finally {
    resetPluginRuntimeStateForTest();
  }
});
