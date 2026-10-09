import { expect, it, vi } from "vitest";
import {
  buildDirectChatContext,
  buildGroupChatContext,
  buildGroupIntro,
} from "../../auto-reply/reply/groups.js";
import { buildInboundMetaSystemPrompt } from "../../auto-reply/reply/inbound-meta.js";
import type { TemplateContext } from "../../auto-reply/templating.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
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
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";
import { prepareCommandConversationContext } from "./conversation-context.js";
import { prepareEmbeddedSessionState } from "./session-preparation.js";

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
vi.mock("./attempt-execution.shared.js", () => ({ persistAgentSession: vi.fn() }));
vi.mock("./runtime-loaders.js", () => ({
  loadSkillsRuntime: async () => ({
    getRemoteSkillEligibility: () => ({}),
    resolveReusableWorkspaceSkillSnapshot: () => ({ snapshot: undefined, shouldRefresh: false }),
  }),
  loadExecDefaultsRuntime: async () => ({
    resolveNodeExecEligibility: () => ({ canExec: false }),
  }),
}));

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
      shared
        ? buildGroupChatContext({
            sessionCtx: ctx,
            silentReplyPolicy: "disallow",
            silentToken: "NO_REPLY",
          })
        : buildDirectChatContext({ sessionCtx: ctx }),
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
        [buildInboundMetaSystemPrompt(ctx, {}), buildDirectChatContext({ sessionCtx: ctx })].join(
          "\n\n",
        ),
      );
    }
  } finally {
    resetPluginRuntimeStateForTest();
  }
});
