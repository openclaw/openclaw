import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentSessionKey } from "../../../../src/routing/resolve-route.js";
import {
  clearDiscordComponentEntries,
  registerDiscordComponentEntries,
  resolveDiscordComponentEntry,
  resolveDiscordModalEntry
} from "../components-registry.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  createDiscordComponentButton,
  createDiscordComponentModal
} from "./agent-components.js";
import {
  resolveDiscordMemberAllowed,
  resolveDiscordOwnerAllowFrom,
  resolveDiscordRoleAllowed
} from "./allow-list.js";
import {
  clearGateways,
  getGateway,
  registerGateway,
  unregisterGateway
} from "./gateway-registry.js";
import { clearPresences, getPresence, presenceCacheSize, setPresence } from "./presence-cache.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";
import {
  maybeCreateDiscordAutoThread,
  resolveDiscordAutoThreadContext,
  resolveDiscordAutoThreadReplyPlan,
  resolveDiscordReplyDeliveryPlan
} from "./threading.js";
const readAllowFromStoreMock = vi.hoisted(() => vi.fn());
const upsertPairingRequestMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const dispatchReplyMock = vi.hoisted(() => vi.fn());
const deliverDiscordReplyMock = vi.hoisted(() => vi.fn());
const recordInboundSessionMock = vi.hoisted(() => vi.fn());
const readSessionUpdatedAtMock = vi.hoisted(() => vi.fn());
const resolveStorePathMock = vi.hoisted(() => vi.fn());
let lastDispatchCtx;
vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args) => upsertPairingRequestMock(...args)
}));
vi.mock("../../../../src/infra/system-events.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enqueueSystemEvent: (...args) => enqueueSystemEventMock(...args)
  };
});
vi.mock("../../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: (...args) => dispatchReplyMock(...args)
}));
vi.mock("./reply-delivery.js", () => ({
  deliverDiscordReply: (...args) => deliverDiscordReplyMock(...args)
}));
vi.mock("../../../../src/channels/session.js", () => ({
  recordInboundSession: (...args) => recordInboundSessionMock(...args)
}));
vi.mock("../../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readSessionUpdatedAt: (...args) => readSessionUpdatedAtMock(...args),
    resolveStorePath: (...args) => resolveStorePathMock(...args)
  };
});
describe("agent components", () => {
  const createCfg = () => ({});
  const createBaseDmInteraction = (overrides = {}) => {
    const reply = vi.fn().mockResolvedValue(void 0);
    const defer = vi.fn().mockResolvedValue(void 0);
    const interaction = {
      rawData: { channel_id: "dm-channel" },
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      defer,
      reply,
      ...overrides
    };
    return { interaction, defer, reply };
  };
  const createDmButtonInteraction = (overrides = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction(
      overrides
    );
    return {
      interaction,
      defer,
      reply
    };
  };
  const createDmSelectInteraction = (overrides = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction({
      values: ["alpha"],
      ...overrides
    });
    return {
      interaction,
      defer,
      reply
    };
  };
  beforeEach(() => {
    readAllowFromStoreMock.mockClear().mockResolvedValue([]);
    upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
    enqueueSystemEventMock.mockClear();
  });
  it("sends pairing reply when DM sender is not allowlisted", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "pairing"
    });
    const { interaction, defer, reply } = createDmButtonInteraction();
    await button.run(interaction, { componentId: "hello" });
    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]?.content).toContain("Pairing code: PAIRCODE");
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
  it("blocks DM interactions when only pairing store entries match in allowlist mode", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist"
    });
    const { interaction, defer, reply } = createDmButtonInteraction();
    await button.run(interaction, { componentId: "hello" });
    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledWith({ content: "You are not authorized to use this button." });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });
  it("matches tag-based allowlist entries for DM select menus", async () => {
    const select = createAgentSelectMenu({
      cfg: createCfg(),
      accountId: "default",
      discordConfig: { dangerouslyAllowNameMatching: true },
      dmPolicy: "allowlist",
      allowFrom: ["Alice#1234"]
    });
    const { interaction, defer, reply } = createDmSelectInteraction();
    await select.run(interaction, { componentId: "hello" });
    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledWith({ content: "\u2713" });
    expect(enqueueSystemEventMock).toHaveBeenCalled();
  });
  it("accepts cid payloads for agent button interactions", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"]
    });
    const { interaction, defer, reply } = createDmButtonInteraction();
    await button.run(interaction, { cid: "hello_cid" });
    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledWith({ content: "\u2713" });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("hello_cid"),
      expect.any(Object)
    );
  });
  it("keeps malformed percent cid values without throwing", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"]
    });
    const { interaction, defer, reply } = createDmButtonInteraction();
    await button.run(interaction, { cid: "hello%2G" });
    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledWith({ content: "\u2713" });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("hello%2G"),
      expect.any(Object)
    );
  });
});
describe("discord component interactions", () => {
  const createCfg = () => ({
    channels: {
      discord: {
        replyToMode: "first"
      }
    }
  });
  const createDiscordConfig = (overrides) => ({
    replyToMode: "first",
    ...overrides
  });
  const createComponentContext = (overrides) => ({
    cfg: createCfg(),
    accountId: "default",
    dmPolicy: "allowlist",
    allowFrom: ["123456789"],
    discordConfig: createDiscordConfig(),
    token: "token",
    ...overrides
  });
  const createComponentButtonInteraction = (overrides = {}) => {
    const reply = vi.fn().mockResolvedValue(void 0);
    const defer = vi.fn().mockResolvedValue(void 0);
    const interaction = {
      rawData: { channel_id: "dm-channel", id: "interaction-1" },
      user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
      customId: "occomp:cid=btn_1",
      message: { id: "msg-1" },
      client: { rest: {} },
      defer,
      reply,
      ...overrides
    };
    return { interaction, defer, reply };
  };
  const createModalInteraction = (overrides = {}) => {
    const reply = vi.fn().mockResolvedValue(void 0);
    const acknowledge = vi.fn().mockResolvedValue(void 0);
    const fields = {
      getText: (key) => key === "fld_1" ? "Casey" : void 0,
      getStringSelect: (_key) => void 0,
      getRoleSelect: (_key) => [],
      getUserSelect: (_key) => []
    };
    const interaction = {
      rawData: { channel_id: "dm-channel", id: "interaction-2" },
      user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
      customId: "ocmodal:mid=mdl_1",
      fields,
      acknowledge,
      reply,
      client: { rest: {} },
      ...overrides
    };
    return { interaction, acknowledge, reply };
  };
  const createButtonEntry = (overrides = {}) => ({
    id: "btn_1",
    kind: "button",
    label: "Approve",
    messageId: "msg-1",
    sessionKey: "session-1",
    agentId: "agent-1",
    accountId: "default",
    ...overrides
  });
  const createModalEntry = (overrides = {}) => ({
    id: "mdl_1",
    title: "Details",
    messageId: "msg-2",
    sessionKey: "session-2",
    agentId: "agent-2",
    accountId: "default",
    fields: [
      {
        id: "fld_1",
        name: "name",
        label: "Name",
        type: "text"
      }
    ],
    ...overrides
  });
  beforeEach(() => {
    clearDiscordComponentEntries();
    lastDispatchCtx = void 0;
    readAllowFromStoreMock.mockClear().mockResolvedValue([]);
    upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
    enqueueSystemEventMock.mockClear();
    dispatchReplyMock.mockClear().mockImplementation(async (params) => {
      lastDispatchCtx = params.ctx;
      await params.dispatcherOptions.deliver({ text: "ok" });
    });
    deliverDiscordReplyMock.mockClear();
    recordInboundSessionMock.mockClear().mockResolvedValue(void 0);
    readSessionUpdatedAtMock.mockClear().mockReturnValue(void 0);
    resolveStorePathMock.mockClear().mockReturnValue("/tmp/openclaw-sessions-test.json");
  });
  it("routes button clicks with reply references", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: []
    });
    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();
    await button.run(interaction, { cid: "btn_1" });
    expect(reply).toHaveBeenCalledWith({ content: "\u2713" });
    expect(lastDispatchCtx?.BodyForAgent).toBe('Clicked "Approve".');
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock.mock.calls[0]?.[0]?.replyToId).toBe("msg-1");
    expect(resolveDiscordComponentEntry({ id: "btn_1" })).toBeNull();
  });
  it("keeps reusable buttons active after use", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ reusable: true })],
      modals: []
    });
    const button = createDiscordComponentButton(createComponentContext());
    const { interaction } = createComponentButtonInteraction();
    await button.run(interaction, { cid: "btn_1" });
    const { interaction: secondInteraction } = createComponentButtonInteraction({
      rawData: {
        channel_id: "dm-channel",
        id: "interaction-2"
      }
    });
    await button.run(secondInteraction, { cid: "btn_1" });
    expect(dispatchReplyMock).toHaveBeenCalledTimes(2);
    expect(resolveDiscordComponentEntry({ id: "btn_1", consume: false })).not.toBeNull();
  });
  it("blocks buttons when allowedUsers does not match", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ allowedUsers: ["999"] })],
      modals: []
    });
    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();
    await button.run(interaction, { cid: "btn_1" });
    expect(reply).toHaveBeenCalledWith({ content: "You are not authorized to use this button." });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
    expect(resolveDiscordComponentEntry({ id: "btn_1", consume: false })).not.toBeNull();
  });
  async function runModalSubmission(params) {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry({ reusable: params?.reusable ?? false })]
    });
    const modal = createDiscordComponentModal(
      createComponentContext({
        discordConfig: createDiscordConfig({ replyToMode: "all" })
      })
    );
    const { interaction, acknowledge } = createModalInteraction();
    await modal.run(interaction, { mid: "mdl_1" });
    return { acknowledge };
  }
  it("routes modal submissions with field values", async () => {
    const { acknowledge } = await runModalSubmission();
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.BodyForAgent).toContain('Form "Details" submitted.');
    expect(lastDispatchCtx?.BodyForAgent).toContain("- Name: Casey");
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock.mock.calls[0]?.[0]?.replyToId).toBe("msg-2");
    expect(resolveDiscordModalEntry({ id: "mdl_1" })).toBeNull();
  });
  it("does not mark guild modal events as command-authorized for non-allowlisted users", async () => {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry()]
    });
    const modal = createDiscordComponentModal(
      createComponentContext({
        cfg: {
          commands: { useAccessGroups: true },
          channels: { discord: { replyToMode: "first" } }
        },
        allowFrom: ["owner-1"]
      })
    );
    const { interaction, acknowledge } = createModalInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: "interaction-guild-1",
        member: { roles: [] }
      },
      guild: { id: "guild-1", name: "Test Guild" }
    });
    await modal.run(interaction, { mid: "mdl_1" });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.CommandAuthorized).toBe(false);
  });
  it("marks guild modal events as command-authorized for allowlisted users", async () => {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry()]
    });
    const modal = createDiscordComponentModal(
      createComponentContext({
        cfg: {
          commands: { useAccessGroups: true },
          channels: { discord: { replyToMode: "first" } }
        },
        allowFrom: ["123456789"]
      })
    );
    const { interaction, acknowledge } = createModalInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: "interaction-guild-2",
        member: { roles: [] }
      },
      guild: { id: "guild-1", name: "Test Guild" }
    });
    await modal.run(interaction, { mid: "mdl_1" });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.CommandAuthorized).toBe(true);
  });
  it("keeps reusable modal entries active after submission", async () => {
    const { acknowledge } = await runModalSubmission({ reusable: true });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(resolveDiscordModalEntry({ id: "mdl_1", consume: false })).not.toBeNull();
  });
});
describe("resolveDiscordOwnerAllowFrom", () => {
  it("returns undefined when no allowlist is configured", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true },
      sender: { id: "123" }
    });
    expect(result).toBeUndefined();
  });
  it("skips wildcard matches for owner allowFrom", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["*"] },
      sender: { id: "123" }
    });
    expect(result).toBeUndefined();
  });
  it("returns a matching user id entry", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["123"] },
      sender: { id: "123" }
    });
    expect(result).toEqual(["123"]);
  });
  it("returns the normalized name slug for name matches only when enabled", () => {
    const defaultResult = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["Some User"] },
      sender: { id: "999", name: "Some User" }
    });
    expect(defaultResult).toBeUndefined();
    const enabledResult = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["Some User"] },
      sender: { id: "999", name: "Some User" },
      allowNameMatching: true
    });
    expect(enabledResult).toEqual(["some-user"]);
  });
});
describe("resolveDiscordRoleAllowed", () => {
  it("allows when no role allowlist is configured", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: void 0,
      memberRoleIds: ["role-1"]
    });
    expect(allowed).toBe(true);
  });
  it("matches role IDs only", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["123"],
      memberRoleIds: ["123", "456"]
    });
    expect(allowed).toBe(true);
  });
  it("does not match non-ID role entries", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["Admin"],
      memberRoleIds: ["Admin"]
    });
    expect(allowed).toBe(false);
  });
  it("returns false when no matching role IDs", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["456"],
      memberRoleIds: ["123"]
    });
    expect(allowed).toBe(false);
  });
});
describe("resolveDiscordMemberAllowed", () => {
  it("allows when no user or role allowlists are configured", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: void 0,
      roleAllowList: void 0,
      memberRoleIds: [],
      userId: "u1"
    });
    expect(allowed).toBe(true);
  });
  it("allows when user allowlist matches", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: ["123"],
      roleAllowList: ["456"],
      memberRoleIds: ["999"],
      userId: "123"
    });
    expect(allowed).toBe(true);
  });
  it("allows when role allowlist matches", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: ["999"],
      roleAllowList: ["456"],
      memberRoleIds: ["456"],
      userId: "123"
    });
    expect(allowed).toBe(true);
  });
  it("denies when user and role allowlists do not match", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: ["u2"],
      roleAllowList: ["role-2"],
      memberRoleIds: ["role-1"],
      userId: "u1"
    });
    expect(allowed).toBe(false);
  });
});
describe("gateway-registry", () => {
  function fakeGateway(props = {}) {
    return { isConnected: true, ...props };
  }
  beforeEach(() => {
    clearGateways();
  });
  it("stores and retrieves a gateway by account", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway);
    expect(getGateway("account-a")).toBe(gateway);
    expect(getGateway("account-b")).toBeUndefined();
  });
  it("uses collision-safe key when accountId is undefined", () => {
    const gateway = fakeGateway();
    registerGateway(void 0, gateway);
    expect(getGateway(void 0)).toBe(gateway);
    expect(getGateway("default")).toBeUndefined();
  });
  it("unregisters a gateway", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway);
    unregisterGateway("account-a");
    expect(getGateway("account-a")).toBeUndefined();
  });
  it("clears all gateways", () => {
    registerGateway("a", fakeGateway());
    registerGateway("b", fakeGateway());
    clearGateways();
    expect(getGateway("a")).toBeUndefined();
    expect(getGateway("b")).toBeUndefined();
  });
  it("overwrites existing entry for same account", () => {
    const gateway1 = fakeGateway({ isConnected: true });
    const gateway2 = fakeGateway({ isConnected: false });
    registerGateway("account-a", gateway1);
    registerGateway("account-a", gateway2);
    expect(getGateway("account-a")).toBe(gateway2);
  });
});
describe("presence-cache", () => {
  beforeEach(() => {
    clearPresences();
  });
  it("scopes presence entries by account", () => {
    const presenceA = { status: "online" };
    const presenceB = { status: "idle" };
    setPresence("account-a", "user-1", presenceA);
    setPresence("account-b", "user-1", presenceB);
    expect(getPresence("account-a", "user-1")).toBe(presenceA);
    expect(getPresence("account-b", "user-1")).toBe(presenceB);
    expect(getPresence("account-a", "user-2")).toBeUndefined();
  });
  it("clears presence per account", () => {
    const presence = { status: "dnd" };
    setPresence("account-a", "user-1", presence);
    setPresence("account-b", "user-2", presence);
    clearPresences("account-a");
    expect(getPresence("account-a", "user-1")).toBeUndefined();
    expect(getPresence("account-b", "user-2")).toBe(presence);
    expect(presenceCacheSize()).toBe(1);
  });
});
describe("resolveDiscordPresenceUpdate", () => {
  it("returns default online presence when no presence config provided", () => {
    expect(resolveDiscordPresenceUpdate({})).toEqual({
      status: "online",
      activities: [],
      since: null,
      afk: false
    });
  });
  it("returns status-only presence when activity is omitted", () => {
    const presence = resolveDiscordPresenceUpdate({ status: "dnd" });
    expect(presence).not.toBeNull();
    expect(presence?.status).toBe("dnd");
    expect(presence?.activities).toEqual([]);
  });
  it("defaults to custom activity type when activity is set without type", () => {
    const presence = resolveDiscordPresenceUpdate({ activity: "Focus time" });
    expect(presence).not.toBeNull();
    expect(presence?.status).toBe("online");
    expect(presence?.activities).toHaveLength(1);
    expect(presence?.activities[0]).toMatchObject({
      type: 4,
      name: "Custom Status",
      state: "Focus time"
    });
  });
  it("includes streaming url when activityType is streaming", () => {
    const presence = resolveDiscordPresenceUpdate({
      activity: "Live",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw"
    });
    expect(presence).not.toBeNull();
    expect(presence?.activities).toHaveLength(1);
    expect(presence?.activities[0]).toMatchObject({
      type: 1,
      name: "Live",
      url: "https://twitch.tv/openclaw"
    });
  });
});
describe("resolveDiscordAutoThreadContext", () => {
  it("returns null without a created thread and re-keys context when present", () => {
    const cases = [
      {
        name: "no created thread",
        createdThreadId: void 0,
        expectedNull: true
      },
      {
        name: "created thread",
        createdThreadId: "thread",
        expectedNull: false
      }
    ];
    for (const testCase of cases) {
      const context = resolveDiscordAutoThreadContext({
        agentId: "agent",
        channel: "discord",
        messageChannelId: "parent",
        createdThreadId: testCase.createdThreadId
      });
      if (testCase.expectedNull) {
        expect(context, testCase.name).toBeNull();
        continue;
      }
      expect(context, testCase.name).not.toBeNull();
      expect(context?.To, testCase.name).toBe("channel:thread");
      expect(context?.From, testCase.name).toBe("discord:channel:thread");
      expect(context?.OriginatingTo, testCase.name).toBe("channel:thread");
      expect(context?.SessionKey, testCase.name).toBe(
        buildAgentSessionKey({
          agentId: "agent",
          channel: "discord",
          peer: { kind: "channel", id: "thread" }
        })
      );
      expect(context?.ParentSessionKey, testCase.name).toBe(
        buildAgentSessionKey({
          agentId: "agent",
          channel: "discord",
          peer: { kind: "channel", id: "parent" }
        })
      );
    }
  });
});
describe("resolveDiscordReplyDeliveryPlan", () => {
  it("applies delivery targets and reply reference behavior across thread modes", () => {
    const cases = [
      {
        name: "original target with reply references",
        input: {
          replyTarget: "channel:parent",
          replyToMode: "all",
          messageId: "m1",
          threadChannel: null,
          createdThreadId: null
        },
        expectedDeliverTarget: "channel:parent",
        expectedReplyTarget: "channel:parent",
        expectedReplyReferenceCalls: ["m1"]
      },
      {
        name: "created thread disables reply references",
        input: {
          replyTarget: "channel:parent",
          replyToMode: "all",
          messageId: "m1",
          threadChannel: null,
          createdThreadId: "thread"
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyTarget: "channel:thread",
        expectedReplyReferenceCalls: [void 0]
      },
      {
        name: "thread + off mode",
        input: {
          replyTarget: "channel:thread",
          replyToMode: "off",
          messageId: "m1",
          threadChannel: { id: "thread" },
          createdThreadId: null
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyTarget: "channel:thread",
        expectedReplyReferenceCalls: [void 0]
      },
      {
        name: "thread + all mode",
        input: {
          replyTarget: "channel:thread",
          replyToMode: "all",
          messageId: "m1",
          threadChannel: { id: "thread" },
          createdThreadId: null
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyTarget: "channel:thread",
        expectedReplyReferenceCalls: ["m1", "m1"]
      },
      {
        name: "thread + first mode",
        input: {
          replyTarget: "channel:thread",
          replyToMode: "first",
          messageId: "m1",
          threadChannel: { id: "thread" },
          createdThreadId: null
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyTarget: "channel:thread",
        expectedReplyReferenceCalls: ["m1", void 0]
      }
    ];
    for (const testCase of cases) {
      const plan = resolveDiscordReplyDeliveryPlan(testCase.input);
      expect(plan.deliverTarget, testCase.name).toBe(testCase.expectedDeliverTarget);
      expect(plan.replyTarget, testCase.name).toBe(testCase.expectedReplyTarget);
      for (const expected of testCase.expectedReplyReferenceCalls) {
        expect(plan.replyReference.use(), testCase.name).toBe(expected);
      }
    }
  });
});
describe("maybeCreateDiscordAutoThread", () => {
  function createAutoThreadParams(client) {
    return {
      client,
      message: {
        id: "m1",
        channelId: "parent"
      },
      isGuildMessage: true,
      channelConfig: {
        autoThread: true
      },
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello"
    };
  }
  it("handles create-thread failures with and without an existing thread", async () => {
    const cases = [
      {
        name: "race condition returns existing thread",
        postError: "A thread has already been created on this message",
        getResponse: { thread: { id: "existing-thread" } },
        expected: "existing-thread"
      },
      {
        name: "other error returns undefined",
        postError: "Some other error",
        getResponse: { thread: null },
        expected: void 0
      }
    ];
    for (const testCase of cases) {
      const client = {
        rest: {
          post: async () => {
            throw new Error(testCase.postError);
          },
          get: async () => testCase.getResponse
        }
      };
      const result = await maybeCreateDiscordAutoThread(createAutoThreadParams(client));
      expect(result, testCase.name).toBe(testCase.expected);
    }
  });
});
describe("resolveDiscordAutoThreadReplyPlan", () => {
  function createAutoThreadPlanParams(overrides) {
    return {
      client: overrides?.client ?? { rest: { post: async () => ({ id: "thread" }) } },
      message: {
        id: "m1",
        channelId: "parent"
      },
      isGuildMessage: true,
      channelConfig: overrides?.channelConfig ?? { autoThread: true },
      threadChannel: overrides?.threadChannel ?? null,
      baseText: "hello",
      combinedBody: "hello",
      replyToMode: "all",
      agentId: "agent",
      channel: "discord"
    };
  }
  it("applies auto-thread reply planning across created, existing, and disabled modes", async () => {
    const cases = [
      {
        name: "created thread",
        params: void 0,
        expectedDeliverTarget: "channel:thread",
        expectedReplyReference: void 0,
        expectedSessionKey: buildAgentSessionKey({
          agentId: "agent",
          channel: "discord",
          peer: { kind: "channel", id: "thread" }
        })
      },
      {
        name: "existing thread channel",
        params: {
          threadChannel: { id: "thread" }
        },
        expectedDeliverTarget: "channel:thread",
        expectedReplyReference: "m1",
        expectedSessionKey: null
      },
      {
        name: "autoThread disabled",
        params: {
          channelConfig: { autoThread: false }
        },
        expectedDeliverTarget: "channel:parent",
        expectedReplyReference: "m1",
        expectedSessionKey: null
      }
    ];
    for (const testCase of cases) {
      const plan = await resolveDiscordAutoThreadReplyPlan(
        createAutoThreadPlanParams(testCase.params)
      );
      expect(plan.deliverTarget, testCase.name).toBe(testCase.expectedDeliverTarget);
      expect(plan.replyReference.use(), testCase.name).toBe(testCase.expectedReplyReference);
      if (testCase.expectedSessionKey == null) {
        expect(plan.autoThreadContext, testCase.name).toBeNull();
      } else {
        expect(plan.autoThreadContext?.SessionKey, testCase.name).toBe(testCase.expectedSessionKey);
      }
    }
  });
});
