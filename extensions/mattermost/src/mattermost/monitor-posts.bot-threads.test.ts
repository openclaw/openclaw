import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import type { MattermostConfig } from "../types.js";
import { resolveMattermostAccount } from "./accounts.js";
import type { MattermostIngressPost } from "./monitor-ingress.js";
import { createMattermostPostHandler } from "./monitor-posts.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";

const dispatch = vi.hoisted(() => vi.fn());
const hasParticipation = vi.hoisted(() => vi.fn());
const body = "Continue the discussion";
const threadPolicy = (requireMentionInBotThreads: boolean) => ({ requireMentionInBotThreads });

vi.mock("./monitor-turn.js", () => ({ dispatchMattermostInboundTurn: dispatch }));
vi.mock("./thread-participation.js", () => ({
  hasMattermostThreadParticipationWithPersistence: hasParticipation,
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  resolveInboundSessionEnvelopeContextAsync: async () => ({ envelopeOptions: {} }),
}));

describe("Mattermost bot-owned thread mention policy", () => {
  beforeEach(() => {
    dispatch.mockReset();
    hasParticipation.mockReset().mockResolvedValue(false);
  });

  function setup(
    config: Partial<MattermostConfig> = {},
    botUsername = "bot",
    accountId = "default",
  ) {
    const mattermost: MattermostConfig = {
      enabled: true,
      requireMention: true,
      groupPolicy: "open",
      historyLimit: 0,
      ...config,
    };
    const cfg: OpenClawConfig = { channels: { mattermost } };
    const account = resolveMattermostAccount({ cfg, accountId });
    const core = createPluginRuntimeMock();
    core.channel.mentions.buildMentionRegexes = () => [];
    core.channel.groups.resolveRequireMention = resolveChannelGroupRequireMention;
    core.channel.routing.resolveAgentRoute = () => ({
      agentId: "main",
      channel: "mattermost",
      accountId,
      sessionKey: "agent:main:mattermost:channel:room",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    core.channel.commands.shouldHandleTextCommands = () => false;
    setMattermostRuntime(core);
    const root = { id: "root", channel_id: "room", user_id: "bot" };
    const request = vi.fn(async (endpoint: string) => {
      if (endpoint !== "/posts/root") {
        throw new Error(`Unexpected Mattermost request: ${endpoint}`);
      }
      return root;
    });
    const monitor = {
      cfg,
      account,
      core,
      client: { request },
      botUserId: "bot",
      botUsername,
      groupPolicy: account.config.groupPolicy ?? "open",
      pairing: { readAllowFromStore: async () => [] },
      resources: {
        resolveChannelInfo: async () => ({ id: "room", type: "O" }),
        resolveUserInfo: async (id: string) => ({ id, username: id }),
        resolveMattermostMedia: async () => [],
      },
      runtime: { log: vi.fn(), error: vi.fn() },
      logVerboseMessage: vi.fn(),
      logDebugMessage: vi.fn(),
    } as unknown as MattermostMonitorContext;
    const handler = createMattermostPostHandler(monitor);
    return {
      core,
      root,
      request,
      receive: (post: Partial<MattermostIngressPost> = {}) =>
        handler(
          {
            id: "follow-up",
            root_id: "root",
            channel_id: "room",
            user_id: "sender",
            message: body,
            create_at: 2,
            ...post,
          },
          { data: { sender_name: "sender" } },
        ),
    };
  }

  const policy = {
    implicitMentions: { threadParticipation: true },
    accounts: { work: { implicitMentions: { threadParticipation: false } } },
  };
  const relaxedThread = { ...threadPolicy(true), groups: { "*": threadPolicy(false) } };
  const threadReply = { BodyForAgent: body, MessageThreadId: "root" };
  it.each([
    ["default follow-up", {}, { BodyForAgent: body, WasMentioned: true }, "default", true],
    ["channel policy", policy, { AccountId: "default", WasMentioned: true }, "default", true],
    ["account participation override", policy, null, "work", true],
    ["wildcard bot-thread override", relaxedThread, threadReply, "default", false],
  ] satisfies Array<[string, Partial<MattermostConfig>, object | null, string, boolean]>)(
    "applies %s",
    async (_name, config, expected, accountId, engaged) => {
      const f = setup(config, "bot", accountId);
      hasParticipation.mockResolvedValue(engaged);
      await f.receive();
      expect(dispatch).toHaveBeenCalledTimes(expected ? 1 : 0);
      if (expected) {
        expect(dispatch.mock.calls[0]?.[1].ctxPayload).toMatchObject(expected);
      }
    },
  );

  const explicitOnly = {
    implicitMentions: { threadParticipation: false },
    groupAllowFrom: ["sender"],
  };
  const mention = "@bot continue the discussion";
  const mentioned = { BodyForAgent: "continue the discussion", WasMentioned: true };
  const commanded = {
    ...mentioned,
    BodyForAgent: "/reset",
    CommandAuthorized: true,
    CommandSource: "text",
  };
  const accountRequirement = { requireMention: false, ...threadPolicy(true) };
  const groupRequirement = {
    ...threadPolicy(false),
    groups: { "*": threadPolicy(false), room: threadPolicy(true) },
  };
  it.each([
    ["explicit mention", explicitOnly, mention, true, mentioned],
    ["authorized command", explicitOnly, "/reset", true, commanded],
    ["account bot-thread requirement", accountRequirement, mention, false, null],
    ["exact group bot-thread requirement", groupRequirement, mention, false, null],
  ] satisfies Array<[string, Partial<MattermostConfig>, string, boolean, object | null]>)(
    "requires activation despite participation: %s",
    async (_name, config, message, commands, expected) => {
      const f = setup(config);
      if (commands) {
        f.core.channel.commands.isControlCommandMessage = isControlCommandMessage;
        f.core.channel.commands.shouldHandleTextCommands = shouldHandleTextCommands;
      }
      hasParticipation.mockResolvedValue(true);
      await f.receive();
      expect(dispatch).not.toHaveBeenCalled();
      await f.receive({ id: "activated-follow-up", message });
      expect(dispatch).toHaveBeenCalledOnce();
      if (expected) {
        expect(dispatch.mock.calls[0]?.[1].ctxPayload).toMatchObject(expected);
      }
    },
  );

  it("handles missing mention detectors for another author's thread", async () => {
    const f = setup({ requireMentionInBotThreads: true }, "");
    f.root.user_id = "someone-else";

    await f.receive();

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("retains mention gating for an unreadable root", async () => {
    const f = setup({ requireMentionInBotThreads: false });
    f.request.mockRejectedValue(new Error("Mattermost API 403 Forbidden"));
    await f.receive();
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalled();
  });

  it.each([
    { groupPolicy: "disabled" as const },
    { groupPolicy: "allowlist" as const, groupAllowFrom: ["trusted"] },
  ])("retains $groupPolicy access restrictions in bot-owned threads", async (config) => {
    const f = setup({ ...config, requireMentionInBotThreads: false });

    await f.receive();

    expect(dispatch).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });
});
