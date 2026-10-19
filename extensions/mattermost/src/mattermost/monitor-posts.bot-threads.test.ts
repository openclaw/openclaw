import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import type { MattermostConfig } from "../types.js";
import { resolveMattermostAccount } from "./accounts.js";
import type { MattermostPost } from "./client.js";
import type { MattermostIngressPost } from "./monitor-ingress.js";
import { createMattermostPostHandler } from "./monitor-posts.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";

const dispatch = vi.hoisted(() => vi.fn());
const hasParticipation = vi.hoisted(() => vi.fn());

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
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          requireMention: true,
          groupPolicy: "open",
          historyLimit: 0,
          ...config,
        },
      },
    };
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
    const root: MattermostPost = {
      id: "root",
      channel_id: "room",
      user_id: "bot",
      message: "Discussion started by the bot",
      create_at: 1,
    };
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
            message: "Continue the discussion",
            create_at: 2,
            ...post,
          },
          { data: { sender_name: "sender" } },
        ),
    };
  }

  it("keeps participated-thread follow-ups enabled by default", async () => {
    const f = setup();
    hasParticipation.mockResolvedValue(true);

    await f.receive();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[1].ctxPayload).toMatchObject({
      BodyForAgent: "Continue the discussion",
      WasMentioned: true,
    });
  });

  it.each([
    { accountId: "default", admitted: true },
    { accountId: "work", admitted: false },
  ])(
    "applies account implicit-mention policy before channel policy for $accountId",
    async ({ accountId, admitted }) => {
      const f = setup(
        {
          implicitMentions: { threadParticipation: true },
          accounts: { work: { implicitMentions: { threadParticipation: false } } },
        },
        "bot",
        accountId,
      );
      hasParticipation.mockResolvedValue(true);

      await f.receive();

      expect(dispatch).toHaveBeenCalledTimes(admitted ? 1 : 0);
      if (admitted) {
        expect(dispatch.mock.calls[0]?.[1].ctxPayload).toMatchObject({
          AccountId: "default",
          WasMentioned: true,
        });
      }
    },
  );

  it.each([
    {
      activation: "explicit mentions",
      message: "@bot continue the discussion",
      expected: { BodyForAgent: "continue the discussion", WasMentioned: true },
    },
    {
      activation: "authorized commands",
      message: "/reset",
      expected: {
        BodyForAgent: "/reset",
        WasMentioned: true,
        CommandAuthorized: true,
        CommandSource: "text",
      },
    },
  ])(
    "keeps $activation independent from disabled implicit mentions",
    async ({ message, expected }) => {
      const f = setup({
        implicitMentions: { threadParticipation: false },
        groupAllowFrom: ["sender"],
      });
      f.core.channel.commands.isControlCommandMessage = isControlCommandMessage;
      f.core.channel.commands.shouldHandleTextCommands = shouldHandleTextCommands;
      hasParticipation.mockResolvedValue(true);

      await f.receive();
      expect(dispatch).not.toHaveBeenCalled();

      await f.receive({ id: "activated-follow-up", message });

      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[1].ctxPayload).toMatchObject(expected);
    },
  );

  it.each([
    {
      scope: "wildcard group",
      config: {
        requireMentionInBotThreads: true,
        groups: { "*": { requireMentionInBotThreads: false } },
      },
    },
  ])("admits an unmentioned bot-thread reply configured at $scope scope", async ({ config }) => {
    const f = setup(config);

    await f.receive();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[1].ctxPayload).toMatchObject({
      BodyForAgent: "Continue the discussion",
      MessageThreadId: "root",
    });
  });

  it.each([
    {
      scope: "account",
      config: { requireMention: false, requireMentionInBotThreads: true },
    },
    {
      scope: "exact group",
      config: {
        requireMentionInBotThreads: false,
        groups: {
          "*": { requireMentionInBotThreads: false },
          room: { requireMentionInBotThreads: true },
        },
      },
    },
  ])("requires a mention at $scope scope even after prior participation", async ({ config }) => {
    const f = setup(config);
    hasParticipation.mockResolvedValue(true);

    await f.receive();
    expect(dispatch).not.toHaveBeenCalled();

    await f.receive({ id: "mentioned-follow-up", message: "@bot continue the discussion" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "another author's thread", setting: true, owner: "someone-else", admitted: true },
  ])("handles missing mention detectors for $name", async ({ setting, owner, admitted }) => {
    const f = setup({ requireMentionInBotThreads: setting }, "");
    f.root.user_id = owner;

    await f.receive();

    expect(dispatch).toHaveBeenCalledTimes(admitted ? 1 : 0);
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
