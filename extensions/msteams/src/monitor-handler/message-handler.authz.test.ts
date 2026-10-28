import path from "node:path";
import { runPreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveAgentRoute as resolveProductionAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../../runtime-api.js";
import { resolveMSTeamsAccountConfig, withAccountScopedMSTeamsConfig } from "../accounts.js";
import type { GraphThreadMessage } from "../graph-thread.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import {
  keepConfiguredMSTeamsAllowlistActive,
  projectStableMSTeamsGroupAllowlist,
  projectStableMSTeamsTeamsConfig,
} from "../resolve-allowlist.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  channelConversationId,
  createMessageHandlerDeps,
  createTurnContext,
} from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
const graph = vi.hoisted(() => ({
  resolveTeamGroupId: vi.fn(
    async (params: { aadGroupId?: string }) => params.aadGroupId?.trim() || "group-1",
  ),
  fetchChannelMessage: vi.fn<typeof import("../graph-thread.js").fetchChannelMessage>(
    async () => undefined,
  ),
  fetchThreadReplies: vi.fn<() => Promise<GraphThreadMessage[]>>(async () => []),
  fetchChatMessageText: vi.fn<() => Promise<string | undefined>>(async () => undefined),
}));
vi.mock("../graph-thread.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../graph-thread.js")>()),
  fetchChannelMessage: graph.fetchChannelMessage,
  fetchThreadReplies: graph.fetchThreadReplies,
  fetchChatMessageText: graph.fetchChatMessageText,
}));
vi.mock("../team-identity.js", () => ({ resolveTeamGroupId: graph.resolveTeamGroupId }));

let sequence = 0;
let parentId: string;
const sender = { id: "alice-id", aadObjectId: "alice-aad", name: "Alice" };
const channelId = "19:channel@thread.tacv2";
const personal = (id: string) => ({ id, conversationType: "personal" });
const dmAccount: MSTeamsConfig = {
  appId: "test-app",
  dmPolicy: "allowlist",
  allowFrom: ["alice-aad"],
};
const openGroup: MSTeamsConfig = { groupPolicy: "open", requireMention: false };
function accountsConfig(support: MSTeamsConfig, sales = support): OpenClawConfig {
  return { channels: { msteams: { enabled: true, accounts: { support, sales } } } };
}
function accountHandler(cfg: OpenClawConfig, listenerAccount: string, peer: string) {
  const fixture = createMessageHandlerDeps(cfg, {
    accountId: listenerAccount,
    resolveAgentRoute: ({ accountId = "default" }) => ({
      sessionKey: `agent:main:msteams:${accountId}:${peer}`,
      agentId: "main",
      accountId,
    }),
  });
  return { ...fixture, handler: createMSTeamsMessageHandler(fixture.deps) };
}
function activity(overrides: Partial<MSTeamsTurnContext["activity"]> = {}): MSTeamsTurnContext {
  return createTurnContext({
    type: "message",
    id: "current-msg",
    text: "Current message",
    from: sender,
    recipient: { id: "bot-id", name: "Bot" },
    conversation: { id: channelId, conversationType: "channel" },
    channelData: {},
    attachments: [],
    ...overrides,
  });
}
function setup(
  config: MSTeamsConfig = openGroup,
  options: Parameters<typeof createMessageHandlerDeps>[1] = {},
  extra: OpenClawConfig = {},
) {
  const fixture = createMessageHandlerDeps(
    { ...extra, channels: { msteams: config } },
    { readAllowFromStore: vi.fn(async () => ["alice-aad"]), ...options },
  );
  const handler = createMSTeamsMessageHandler(fixture.deps);
  return {
    ...fixture,
    handler,
    handle: (input: Partial<MSTeamsTurnContext["activity"]> = {}) => handler(activity(input)),
  };
}
function context() {
  expect(dispatch).toHaveBeenCalledTimes(1);
  return dispatch.mock.calls[0]![0].ctx;
}
function expectBlocked(conversationStore: ReturnType<typeof setup>["conversationStore"]) {
  expect(conversationStore.upsert).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
}
function threadMessage(
  id: string,
  content: string,
  user: { id?: string; displayName: string } = { id: "alice-aad", displayName: "Alice" },
): GraphThreadMessage {
  return { id, from: { user }, body: { content, contentType: "text" } };
}
function threadActivity(attachments: MSTeamsTurnContext["activity"]["attachments"] = []) {
  return activity({
    replyToId: parentId,
    attachments,
    channelData: {
      team: { id: "team123", aadGroupId: "graph-team-123" },
      channel: { id: "19:graph-channel@thread.tacv2" },
    },
  });
}
function threadConfig(groupAllowFrom = ["alice-aad"]): MSTeamsConfig {
  return {
    groupPolicy: "allowlist",
    groupAllowFrom,
    contextVisibility: "allowlist",
    requireMention: false,
  };
}
function channelReply(id: string): MSTeamsTurnContext {
  return activity(
    buildChannelActivity({
      id,
      replyToId: "nested-reply",
      conversation: {
        id: `${channelConversationId};messageid=${parentId}`,
        conversationType: "channel",
      },
    }),
  );
}
const channelSessionKey = `agent:main:msteams:channel:${channelConversationId}`;
function quote(senderName = "Alice", body = "Quoted body", id = "") {
  return [
    {
      contentType: "text/html",
      content: `<blockquote itemtype="http://schema.skype.com/Reply" itemid="${id}"><strong itemprop="mri">${senderName}</strong><p itemprop="${id ? "preview" : "copy"}">${body}</p></blockquote>`,
    },
  ];
}

const group = "19:MiXeD-group@thread.tacv2";
function setupConversation(config: MSTeamsConfig = {}) {
  return setup({
    dmPolicy: "allowlist",
    allowFrom: [group],
    groupPolicy: "allowlist",
    groupAllowFrom: [group],
    requireMention: false,
    ...config,
  });
}
function expectThreadContext(
  messages: Array<{ message_id: string; sender: string; body: string }>,
) {
  expect(context().ChannelStructuredContext).toEqual([
    {
      label: "Thread history",
      source: "msteams",
      type: "chat_window",
      sessionTranscriptMode: "preserve",
      payload: { order: "chronological", messages },
    },
  ]);
}

describe("msteams message authorization and supplemental context", () => {
  beforeEach(() => {
    parentId = `auth-parent-${++sequence}`;
    dispatch.mockClear();
    graph.fetchChannelMessage.mockReset();
    graph.fetchThreadReplies.mockReset().mockResolvedValue([]);
    graph.fetchChatMessageText.mockReset();
  });
  afterEach(clearRuntimeConfigSnapshot);

  it.each(["revoked", "disabled", "removed"])(
    "rechecks a %s named account after reload without blocking a sibling",
    async (change) => {
      const cfg = accountsConfig(dmAccount);
      setRuntimeConfigSnapshot(cfg);
      const { handler: supportHandler } = accountHandler(cfg, "support", "direct:alice-aad");
      const { handler: salesHandler } = accountHandler(cfg, "sales", "direct:alice-aad");
      const incoming = () => activity({ conversation: personal("19:shared-dm") });
      await supportHandler(incoming());
      expect(dispatch.mock.calls.at(-1)?.[0].ctx.AccountId).toBe("support");
      dispatch.mockClear();
      const accounts = { ...cfg.channels?.msteams?.accounts };
      if (change === "removed") {
        delete accounts.support;
      } else {
        accounts.support =
          change === "disabled"
            ? { ...accounts.support, enabled: false }
            : { ...accounts.support, allowFrom: ["another-user"] };
      }
      setRuntimeConfigSnapshot({ channels: { msteams: { ...cfg.channels?.msteams, accounts } } });
      await supportHandler(incoming());
      expect(dispatch).not.toHaveBeenCalled();
      await salesHandler(incoming());
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0].ctx.AccountId).toBe("sales");
    },
  );

  it.each(["team", "channel"])(
    "rejects a %s revoked during thread preparation without blocking a sibling account",
    async (revoked) => {
      const account: MSTeamsConfig = {
        appId: "test-app",
        groupPolicy: "open",
        requireMention: false,
        teams: { team123: { channels: { [channelId]: {} } } },
      };
      const cfg = accountsConfig(account);
      setRuntimeConfigSnapshot(cfg);
      const support = accountHandler(cfg, "support", `channel:${channelId}`);
      const { handler: salesHandler } = accountHandler(cfg, "sales", `channel:${channelId}`);
      const started = createDeferred<void>();
      const replies = createDeferred<GraphThreadMessage[]>();
      graph.fetchThreadReplies.mockImplementationOnce(() => {
        started.resolve();
        return replies.promise;
      });
      const pending = support.handler(threadActivity());
      try {
        await started.promise;
        expect(support.conversationStore.upsert).toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        setRuntimeConfigSnapshot(
          accountsConfig(
            {
              ...account,
              teams:
                revoked === "team"
                  ? { anotherTeam: { channels: { [channelId]: {} } } }
                  : { team123: { channels: { "19:other-channel@thread.tacv2": {} } } },
            },
            account,
          ),
        );
        replies.resolve([]);
        await pending;
        expect(dispatch).not.toHaveBeenCalled();
        expect(support.deps.log.info).toHaveBeenCalledWith(
          "dropping message (dispatch-time account authorization changed)",
        );
        await salesHandler(threadActivity());
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0]?.[0].ctx.AccountId).toBe("sales");
      } finally {
        replies.resolve([]);
        await pending;
      }
    },
  );

  it.each(["team", "channel"])(
    "rejects a %s revoked during thread preparation while startup allowlists are retained",
    async (revoked) => {
      const account: MSTeamsConfig = {
        appId: "test-app",
        groupPolicy: "open",
        requireMention: false,
        teams: { team123: { channels: { [channelId]: {} } } },
      };
      const cfg = accountsConfig(account);
      setRuntimeConfigSnapshot(cfg);
      const fixture = createMessageHandlerDeps(cfg, {
        accountId: "support",
        resolveAgentRoute: ({ accountId = "default" }) => ({
          sessionKey: `agent:main:msteams:${accountId}:channel:${channelId}`,
          agentId: "main",
          accountId,
        }),
      });
      // Monitor wiring: the raw policy config plus the account-scoped startup projection.
      fixture.deps.accountPolicyCfg = cfg;
      fixture.deps.cfg = withAccountScopedMSTeamsConfig({
        cfg,
        accountId: "support",
        accountConfig: resolveMSTeamsAccountConfig(cfg, "support"),
      });
      const handler = createMSTeamsMessageHandler(fixture.deps);
      // An unrelated reload first, so admission reads the retained startup allowlists.
      setRuntimeConfigSnapshot({
        ...structuredClone(cfg),
        agents: { defaults: { userTimezone: "UTC" } },
      });
      const started = createDeferred<void>();
      const replies = createDeferred<GraphThreadMessage[]>();
      graph.fetchThreadReplies.mockImplementationOnce(() => {
        started.resolve();
        return replies.promise;
      });
      const pending = handler(threadActivity());
      try {
        await started.promise;
        expect(fixture.conversationStore.upsert).toHaveBeenCalled();
        setRuntimeConfigSnapshot(
          accountsConfig(
            {
              ...account,
              teams:
                revoked === "team"
                  ? { anotherTeam: { channels: { [channelId]: {} } } }
                  : { team123: { channels: { "19:other-channel@thread.tacv2": {} } } },
            },
            account,
          ),
        );
        replies.resolve([]);
        await pending;
        expect(dispatch).not.toHaveBeenCalled();
        expect(fixture.deps.log.info).toHaveBeenCalledWith(
          "dropping message (dispatch-time account authorization changed)",
        );
      } finally {
        replies.resolve([]);
        await pending;
      }
    },
  );

  it("does not dispatch one account's admitted sender through a denied sibling route", async () => {
    const cfg = accountsConfig(dmAccount, { ...dmAccount, allowFrom: ["another-user"] });
    const { deps } = createMessageHandlerDeps(cfg, {
      accountId: "support",
      resolveAgentRoute: () => ({
        sessionKey: "agent:main:msteams:sales:direct:alice-aad",
        agentId: "main",
        accountId: "sales",
      }),
    });
    await createMSTeamsMessageHandler(deps)(activity({ conversation: personal("19:shared-dm") }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps cached Graph parent access scoped to the bot credential (first can read: %s)",
    async (firstCanRead) => {
      const cfg = accountsConfig(
        { ...openGroup, appId: "support-app" },
        { ...openGroup, appId: "sales-app" },
      );
      setRuntimeConfigSnapshot(cfg);
      const botHandler = (accountId: "support" | "sales") => {
        const { deps } = createMessageHandlerDeps(cfg, {
          accountId,
          resolveAgentRoute: ({ accountId: routeAccountId = "default", peer }) => ({
            sessionKey: `agent:main:msteams:${routeAccountId}:${peer.kind}:${peer.id}`,
            agentId: "main",
            accountId: routeAccountId,
          }),
        });
        deps.appId = `${accountId}-app`;
        vi.mocked(deps.tokenProvider.getAccessToken).mockResolvedValue(
          `fixture-${accountId}-token`,
        );
        return createMSTeamsMessageHandler(deps);
      };
      const support = botHandler("support");
      const sales = botHandler("sales");
      graph.fetchChannelMessage.mockImplementation(async (token) => {
        if (token === "fixture-support-token") {
          return firstCanRead ? threadMessage(parentId, "Support-only parent") : undefined;
        }
        return firstCanRead ? undefined : threadMessage(parentId, "Sales-only parent");
      });

      await support(threadActivity());
      expect(dispatch.mock.calls.at(-1)?.[0].ctx.AccountId).toBe("support");
      for (let attempt = 0; attempt < 2; attempt++) {
        dispatch.mockClear();
        const input = threadActivity();
        input.activity.id = `sales-reply-${attempt}`;
        await sales(input);
        expect(dispatch.mock.calls.at(-1)?.[0].ctx.AccountId).toBe("sales");
        if (firstCanRead) {
          expect(context().ChannelStructuredContext).toBeUndefined();
        } else {
          expectThreadContext([
            { message_id: parentId, sender: "Alice", body: "Sales-only parent" },
          ]);
        }
      }
      expect(graph.fetchChannelMessage.mock.calls.map(([token]) => token)).toEqual([
        "fixture-support-token",
        "fixture-sales-token",
      ]);
    },
  );

  it("does not widen an empty group sender allowlist through pairing or route entries", async () => {
    const { handle, conversationStore, readAllowFromStore } = setup({
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      teams: {
        team123: { channels: { "19:channel@thread.tacv2": { requireMention: false } } },
      },
    });
    await handle({ channelData: { team: { id: "team123" } } });
    expect(readAllowFromStore).not.toHaveBeenCalled();
    expectBlocked(conversationStore);
  });

  it.each([
    {
      name: "name-keyed teams allowlist that did not resolve",
      raw: {
        groupPolicy: "open",
        requireMention: false,
        teams: { Engineering: {} },
      } as MSTeamsConfig,
    },
    {
      name: "name-only channels under a conversation-id team",
      raw: {
        groupPolicy: "open",
        requireMention: false,
        teams: { "19:product@thread.tacv2": { channels: { Roadmap: {} } } },
      } as MSTeamsConfig,
      // Probe an unlisted channel inside the configured team so the channel gate decides.
      probe: { teamId: "19:product@thread.tacv2", channelId: "19:product-random@thread.tacv2" },
    },
    {
      name: "name-only channels under a wildcard team",
      raw: {
        groupPolicy: "open",
        requireMention: false,
        teams: { "*": { channels: { Roadmap: {} } } },
      } as MSTeamsConfig,
    },
    {
      name: "names-only groupAllowFrom with open DMs",
      raw: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "allowlist",
        requireMention: false,
        groupAllowFrom: ["Bob Builder"],
      } as MSTeamsConfig,
    },
  ])("does not admit an unlisted channel for a $name", async ({ raw, probe }) => {
    // Same startup projection monitor.ts applies before the handler sees the config.
    const projected: MSTeamsConfig = {
      ...raw,
      teams: projectStableMSTeamsTeamsConfig(raw.teams),
      groupAllowFrom: keepConfiguredMSTeamsAllowlistActive(
        raw.groupAllowFrom,
        projectStableMSTeamsGroupAllowlist(raw.groupAllowFrom),
      ),
    };
    const { handle, conversationStore } = setup(projected);
    await handle({
      conversation: {
        id: probe?.channelId ?? "19:outsider-random@thread.tacv2",
        conversationType: "channel",
      },
      channelData: { team: { id: probe?.teamId ?? "19:outsider-general@thread.tacv2" } },
    });
    expectBlocked(conversationStore);
  });

  it("does not let an operator-defined access group grant a names-only groupAllowFrom", async () => {
    const raw: MSTeamsConfig = {
      dmPolicy: "allowlist",
      allowFrom: ["11111111-1111-1111-1111-111111111111"],
      groupPolicy: "allowlist",
      requireMention: false,
      groupAllowFrom: ["Bob Builder"],
    };
    const projected: MSTeamsConfig = {
      ...raw,
      groupAllowFrom: keepConfiguredMSTeamsAllowlistActive(
        raw.groupAllowFrom,
        projectStableMSTeamsGroupAllowlist(raw.groupAllowFrom),
      ),
    };
    // The names the earlier access-group placeholder used; a same-named group must not matter.
    const { handle, conversationStore } = setup(
      projected,
      {},
      {
        accessGroups: {
          "openclaw-msteams-unresolved-allowlist": {
            type: "message.senders",
            members: { msteams: ["22222222-2222-2222-2222-222222222222"] },
          },
        },
      },
    );
    await handle({
      from: {
        id: "29:second",
        aadObjectId: "22222222-2222-2222-2222-222222222222",
        name: "Second",
      },
      conversation: { id: "19:outsider-random@thread.tacv2", conversationType: "channel" },
      channelData: { team: { id: "19:outsider-general@thread.tacv2" } },
    });
    expectBlocked(conversationStore);
  });

  it("persists the reply reference for DM pairing without dispatching", async () => {
    const { handle, conversationStore, upsertPairingRequest, recordInboundSession } = setup({
      dmPolicy: "pairing",
      allowFrom: [],
    });
    await handle({
      id: "msg-pairing",
      from: { id: "new-id", aadObjectId: "new-aad", name: "New User" },
      conversation: { id: "a:personal-chat", conversationType: "personal", tenantId: "tenant-1" },
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      locale: "en-US",
      entities: [{ type: "clientInfo", timezone: "America/New_York" }],
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "msteams",
      accountId: "default",
      id: "new-aad",
      meta: { name: "New User" },
    });
    expect(conversationStore.upsert).toHaveBeenCalledWith("a:personal-chat", {
      activityId: "msg-pairing",
      user: { id: "new-id", aadObjectId: "new-aad", name: "New User" },
      agent: { id: "bot-id", name: "Bot" },
      conversation: { id: "a:personal-chat", conversationType: "personal", tenantId: "tenant-1" },
      tenantId: "tenant-1",
      aadObjectId: "new-aad",
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer",
      locale: "en-US",
      timezone: "America/New_York",
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("captures canonical tenant and sender IDs for proactive sends (#58774)", async () => {
    const { handle, conversationStore } = setup(threadConfig());
    await handle({
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      channelData: { tenant: { id: "tenant-from-channel-data" } },
    });
    expect(conversationStore.upsert).toHaveBeenCalledExactlyOnceWith(
      "19:channel@thread.tacv2",
      expect.objectContaining({
        tenantId: "tenant-from-channel-data",
        aadObjectId: "alice-aad",
        conversation: {
          id: "19:channel@thread.tacv2",
          conversationType: "channel",
          tenantId: "tenant-from-channel-data",
        },
      }),
    );
  });

  it("does not persist blocked service URL hosts", async () => {
    const { handle, conversationStore } = setup({
      dmPolicy: "allowlist",
      allowFrom: ["alice-aad"],
    });
    await handle({
      conversation: { id: "a:personal-chat", conversationType: "personal" },
      serviceUrl: "https://attacker.example.com/teams/",
    });
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(conversationStore.upsert.mock.calls[0]?.at(1)).not.toHaveProperty("serviceUrl");
  });

  it("fails closed for an unsupported sender access group", async () => {
    const { handle, conversationStore } = setup(
      {
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:operators"],
        requireMention: false,
      },
      {},
      {
        accessGroups: {
          operators: {
            type: "discord.channelAudience",
            guildId: "guild-1",
            channelId: "channel-1",
          },
        },
      },
    );
    await handle();
    expectBlocked(conversationStore);
  });

  it("blocks unauthorized text control commands", async () => {
    const { handle, conversationStore } = setup(openGroup, {
      hasControlCommand: vi.fn(() => true),
    });
    await handle({ text: "/config set foo bar" });
    expectBlocked(conversationStore);
  });

  it("keeps primary system events body-free and applies the sender timezone only to the turn", async () => {
    const { handle, deps, enqueueSystemEvent } = setup();
    await handle({
      text: "please check the build",
      entities: [{ type: "clientInfo", timezone: "America/New_York" }],
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Teams message in channel from Alice",
      expect.any(Object),
    );
    expect(context().BodyForAgent).toBe("please check the build");
    expect(dispatch.mock.calls[0]![0].cfg).not.toBe(deps.cfg);
    expect(dispatch.mock.calls[0]![0].cfg.agents).toEqual({
      defaults: { userTimezone: "America/New_York" },
    });
  });

  it("filters thread senders while keeping supplemental history out of command text", async () => {
    graph.fetchChannelMessage.mockResolvedValue(
      threadMessage(parentId, "injected instructions", {
        id: "mallory-aad",
        displayName: "Mallory",
      }),
    );
    graph.fetchThreadReplies.mockResolvedValue([
      threadMessage("alice-reply", "Allowed context /think high /status"),
      threadMessage("current-msg", "Current message"),
    ]);
    const { handler, enqueueSystemEvent } = setup(threadConfig());
    const input = threadActivity();
    input.activity.text = "Current /status message";
    await handler(input);
    expect(context()).toMatchObject({
      BodyForAgent: "Current /status message",
      commandText: "Current /status message",
      GroupSpace: "team123",
      NativeChannelId: "graph-team-123/19:graph-channel@thread.tacv2",
    });
    expectThreadContext([
      { message_id: "alice-reply", sender: "Alice", body: "Allowed context /think high /status" },
    ]);
    expect(enqueueSystemEvent.mock.calls.some(([text]) => text.startsWith("Replying to @"))).toBe(
      false,
    );
  });

  it("allows thread context by opted-in display name when its sender ID is missing", async () => {
    graph.fetchChannelMessage.mockResolvedValue(
      threadMessage(parentId, "Allowlisted by display name", { displayName: "Alice" }),
    );
    const { handler } = setup({ ...threadConfig(["alice"]), dangerouslyAllowNameMatching: true });
    await handler(threadActivity());
    expectThreadContext([
      { message_id: parentId, sender: "Alice", body: "Allowlisted by display name" },
    ]);
  });

  it.each([
    { parentSender: "alice-aad", body: "Quoted body", name: "Alice" },
    { parentSender: "mallory-aad", body: undefined, name: undefined },
  ])(
    "uses the authoritative parent sender for quote visibility: $parentSender",
    async ({ parentSender, body, name }) => {
      graph.fetchChannelMessage.mockResolvedValue(
        threadMessage(parentId, "Parent context", {
          id: parentSender,
          displayName: parentSender === "alice-aad" ? "Alice" : "Mallory",
        }),
      );
      const { handler } = setup(threadConfig());
      await handler(threadActivity(quote()));
      expect(context().ReplyToBody).toBe(body);
      expect(context().ReplyToSender).toBe(name);
      expect(context().BodyForAgent).toBe("Current message");
    },
  );

  it("does not fetch group-chat quotes with app-only Graph authority", async () => {
    const { handle } = setup();
    await handle({
      conversation: { id: "19:group@thread.tacv2", conversationType: "groupChat" },
      attachments: quote("Victim", "secret snippet…", "1783379480258"),
    });
    expect(context().ReplyToBody).toBe("secret snippet…");
    expect(graph.fetchChatMessageText).not.toHaveBeenCalled();
  });

  it("replaces a DM quote preview with the full Graph message", async () => {
    graph.fetchChatMessageText.mockResolvedValue("complete quoted message");
    const { handle, deps } = setup({ dmPolicy: "open", allowFrom: ["*"] });
    await handle({
      conversation: personal("19:dm@thread.v2"),
      attachments: quote("Bot", "truncated preview…", "message-1"),
    });
    expect(deps.tokenProvider.getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
    expect(graph.fetchChatMessageText).toHaveBeenCalledWith(
      "token",
      "19:dm@thread.v2",
      "message-1",
      expect.objectContaining({ label: "MS Teams inbound preprocessing", timeoutMs: 10_000 }),
    );
    expect(context()).toMatchObject({
      To: "user:alice-aad",
      OriginatingTo: "conversation:19:dm@thread.v2",
      ReplyToId: "message-1",
      ReplyToBody: "complete quoted message",
      ReplyToSender: "Bot",
    });
  });
  it.each([
    ["case-folded opaque ID", "groupChat", group.toLowerCase(), "Member", false],
    ["group ID in a personal conversation", "personal", group, "Member", false],
    ["display-name spoof", "groupChat", "19:other@thread.tacv2", group, true],
  ] as const)("rejects a %s", async (_name, conversationType, id, senderName, nameMatching) => {
    const { handler, conversationStore } = setupConversation({
      dangerouslyAllowNameMatching: nameMatching,
    });
    await handler(
      activity({
        conversation: { id, conversationType },
        from: { id: "member-id", aadObjectId: "member-aad", name: senderName },
      }),
    );
    expectBlocked(conversationStore);
  });
  it("rejects contradictory personal and team scope before routing", async () => {
    const { handler, conversationStore, resolveAgentRoute, enqueueSystemEvent } = setupConversation(
      { allowFrom: ["alice-aad"] },
    );
    await handler(
      activity({
        conversation: { id: "a:personal-chat", conversationType: "personal" },
        channelData: { team: { id: "unexpected-team" } },
      }),
    );
    expectBlocked(conversationStore);
    expect(resolveAgentRoute).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("hydrates the canonical root once across replies through production routing (#66771)", async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const { handler, enqueueSystemEvent } = setup(
      { groupPolicy: "open" },
      {
        resolveAgentRoute: ({ accountId, peer }) =>
          resolveProductionAgentRoute({
            cfg,
            channel: "msteams",
            accountId,
            peer: { kind: "channel", id: peer.id },
          }),
      },
      cfg,
    );
    graph.fetchChannelMessage.mockResolvedValue(
      threadMessage(parentId, "Original question", { displayName: "Alice" }),
    );
    await handler(channelReply("reply-1"));
    await handler(channelReply("reply-2"));
    expect(
      enqueueSystemEvent.mock.calls.filter(([text]) => text.startsWith("Replying to @")),
    ).toEqual([
      [
        "Replying to @Alice: Original question",
        {
          sessionKey: `${channelSessionKey}:thread:${parentId}`,
          contextKey: `msteams:thread-parent:${channelConversationId}:${parentId}`,
        },
      ],
    ]);
    expect(graph.fetchChannelMessage).toHaveBeenCalledExactlyOnceWith(
      "token",
      "group-1",
      channelConversationId,
      parentId,
      expect.objectContaining({ label: "MS Teams inbound preprocessing" }),
    );
    expect(graph.fetchThreadReplies).toHaveBeenCalledWith(
      "token",
      "group-1",
      channelConversationId,
      parentId,
      expect.objectContaining({ label: "MS Teams inbound preprocessing" }),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    for (const [params] of dispatch.mock.calls) {
      expect(params.ctx.SessionKey).toBe(`${channelSessionKey}:thread:${parentId}`);
    }
  });

  it("continues dispatch without a parent event after Graph failure", async () => {
    const { handler, enqueueSystemEvent } = setup({ groupPolicy: "open" });
    graph.fetchChannelMessage.mockRejectedValueOnce(new Error("graph down"));
    await handler(channelReply("reply-failure"));
    expect(
      enqueueSystemEvent.mock.calls.filter(([text]) => text.startsWith("Replying to @")),
    ).toEqual([]);
    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  describe("pending history", () => {
    const tempDirs = useAutoCleanupTempDirTracker(afterEach);
    function historyHandler(conversationType = "channel") {
      const tempDir = tempDirs.make("msteams-history-");
      const { handle } = setup(
        { groupPolicy: "open", requireMention: true, historyLimit: 10 },
        {
          runPrepared: runPreparedInboundReply,
          resolveStorePath: () => path.join(tempDir, "sessions.json"),
        },
      );
      return (text: string, root?: string, replyToId?: string, mentioned = false) =>
        handle(
          buildChannelActivity({
            id: text,
            text,
            conversation: {
              id: root ? `${channelConversationId};messageid=${root}` : channelConversationId,
              conversationType,
            },
            replyToId,
            channelData: {},
            ...(mentioned ? {} : { entities: [] }),
          }),
        );
    }

    it("isolates pending history and cleanup per channel thread", async () => {
      const send = historyHandler();
      await send("note in A", "root-a", "nested-a");
      await send("note in B", undefined, "root-b");
      expect(dispatch).not.toHaveBeenCalled();
      await send("question in B", undefined, "root-b", true);
      const inB = dispatch.mock.calls.at(-1)?.[0].ctx;
      expect(inB?.Body).toContain("note in B");
      expect(inB?.InboundHistory).toEqual([expect.objectContaining({ body: "note in B" })]);
      for (const field of [
        "Body",
        "BodyForAgent",
        "CommandBody",
        "BodyForCommands",
        "RawBody",
      ] as const) {
        expect(inB?.[field]).not.toContain("note in A");
      }
      expect(inB?.SessionKey).toContain("root-b");

      // Consuming B must leave A pending, then consume A exactly once.
      await send("question in A", "root-a", "other-a", true);
      const inA = dispatch.mock.calls.at(-1)?.[0].ctx;
      expect(inA?.Body).toContain("note in A");
      expect(inA?.Body).not.toContain("note in B");
      expect(inA?.InboundHistory).toEqual([expect.objectContaining({ body: "note in A" })]);
      await send("follow-up in A", "root-a", "last-a", true);
      expect(dispatch.mock.calls.at(-1)?.[0].ctx.Body).not.toContain("note in A");
      expect(dispatch.mock.calls.at(-1)?.[0].ctx.InboundHistory).toEqual([]);
      expect(dispatch).toHaveBeenCalledTimes(3);
    });

    it("keeps group-chat quotes in conversation-wide history", async () => {
      const send = historyHandler("groupChat");
      await send("earlier message", "quoted-a", "quoted-a");
      await send("question", undefined, undefined, true);
      const ctx = dispatch.mock.calls.at(-1)?.[0].ctx;
      expect(ctx?.Body).toContain("earlier message");
      expect(ctx?.InboundHistory).toEqual([expect.objectContaining({ body: "earlier message" })]);
      await send("next question", undefined, undefined, true);
      expect(dispatch.mock.calls.at(-1)?.[0].ctx.InboundHistory).toEqual([]);
    });
  });
});
