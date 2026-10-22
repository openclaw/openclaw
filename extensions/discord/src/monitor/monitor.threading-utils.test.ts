import type { GatewayPresenceUpdate } from "discord-api-types/v10";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "../internal/discord.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import { resolveDiscordMemberAllowed, resolveDiscordOwnerAllowFrom } from "./allow-list.js";
import {
  clearGateways,
  getGateway,
  registerGateway,
  unregisterGateway,
} from "./gateway-registry.js";
import { clearPresences, getPresence, presenceCacheSize, setPresence } from "./presence-cache.js";
import {
  maybeCreateDiscordAutoThread,
  resolveDiscordAutoThreadContext,
  resolveDiscordAutoThreadReplyPlan,
  resolveDiscordReplyDeliveryPlan,
} from "./threading.js";

const sessionKey = (id: string) =>
  buildAgentSessionKey({
    agentId: "agent",
    channel: "discord",
    peer: { kind: "channel", id },
  });

describe("resolveDiscordOwnerAllowFrom", () => {
  it("skips wildcard matches for owner allowFrom", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["*"] } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toBeUndefined();
  });

  it("returns the normalized name slug for name matches only when enabled", () => {
    const defaultResult = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["Some User"] } as DiscordChannelConfigResolved,
      sender: { id: "999", name: "Some User" },
    });
    expect(defaultResult).toBeUndefined();

    const enabledResult = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["Some User"] } as DiscordChannelConfigResolved,
      sender: { id: "999", name: "Some User" },
      allowNameMatching: true,
    });

    expect(enabledResult).toEqual(["some-user"]);
  });
});

it("resolveDiscordMemberAllowed: does not match non-ID role entries", () => {
  const allowed = resolveDiscordMemberAllowed({
    userAllowList: [],
    userId: "unmatched-user",
    roleAllowList: ["Admin"],
    memberRoleIds: ["Admin"],
  });

  expect(allowed).toBe(false);
});

it("resolveDiscordMemberAllowed: denies when user and role allowlists do not match", () => {
  const allowed = resolveDiscordMemberAllowed({
    userAllowList: ["u2"],
    roleAllowList: ["role-2"],
    memberRoleIds: ["role-1"],
    userId: "u1",
  });

  expect(allowed).toBe(false);
});

describe("gateway-registry", () => {
  type GatewayPlugin = { isConnected: boolean };

  function fakeGateway(props: Partial<GatewayPlugin> = {}): GatewayPlugin {
    return { isConnected: true, ...props };
  }

  beforeEach(() => {
    clearGateways();
  });

  it("uses collision-safe key when accountId is undefined", () => {
    const gateway = fakeGateway();
    registerGateway(undefined, gateway as never);
    expect(getGateway(undefined)).toBe(gateway);
    expect(getGateway("default")).toBeUndefined();
  });

  it("unregisters a gateway", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway as never);
    unregisterGateway("account-a");
    expect(getGateway("account-a")).toBeUndefined();
  });
});

describe("presence-cache", () => {
  beforeEach(() => {
    clearPresences();
  });

  it("clears presence per account", () => {
    const presence = { status: "dnd" } as GatewayPresenceUpdate;

    setPresence("account-a", "user-1", presence);
    setPresence("account-b", "user-2", presence);

    clearPresences("account-a");

    expect(getPresence("account-a", "user-1")).toBeUndefined();
    expect(getPresence("account-b", "user-2")).toBe(presence);
    expect(presenceCacheSize()).toBe(1);
  });
});

it("resolveDiscordAutoThreadContext: returns null without a created thread and re-keys context when present", () => {
  const threadContext = {
    createdThreadId: "thread",
    To: "channel:thread",
    From: "discord:channel:thread",
    OriginatingTo: "channel:thread",
    SessionKey: sessionKey("thread"),
    ModelParentSessionKey: sessionKey("parent"),
  };
  const cases = [
    [{}, null],
    [{ createdThreadId: "thread", parentInheritanceEnabled: false }, threadContext],
    [
      { createdThreadId: "thread", parentInheritanceEnabled: true },
      { ...threadContext, ParentSessionKey: sessionKey("parent") },
    ],
    [
      {
        createdThreadId: "thread",
        groupScope: "main",
        parentSessionKey: "agent:agent:work",
        parentInheritanceEnabled: true,
      },
      {
        createdThreadId: "thread",
        To: "channel:thread",
        From: "discord:channel:thread",
        OriginatingTo: "channel:thread",
        SessionKey: "agent:agent:work",
      },
    ],
  ] as const;
  for (const [input, expected] of cases) {
    const context = resolveDiscordAutoThreadContext({
      agentId: "agent",
      channel: "discord",
      parentSessionKey: sessionKey("parent"),
      ...input,
    });
    expect(context).toEqual(expected);
  }
});

it("resolveDiscordReplyDeliveryPlan: applies delivery targets and reply reference behavior across thread modes", () => {
  const cases = [
    ["original target", "parent", "all", null, null, "parent", ["1001"]],
    ["created thread", "parent", "all", null, "thread", "thread", [undefined]],
    ["thread + off", "thread", "off", { id: "thread" }, null, "thread", [undefined]],
    ["thread + all", "thread", "all", { id: "thread" }, null, "thread", ["1001", "1001"]],
    ["thread + first", "thread", "first", { id: "thread" }, null, "thread", ["1001", undefined]],
  ] as const;
  for (const [
    name,
    target,
    replyToMode,
    threadChannel,
    createdThreadId,
    delivered,
    refs,
  ] of cases) {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: `channel:${target}`,
      replyToMode,
      threadChannel,
      createdThreadId,
      messageId: "1001",
    });
    expect(plan.deliverTarget, name).toBe(`channel:${delivered}`);
    expect(plan.replyTarget, name).toBe(`channel:${delivered}`);
    for (const expected of refs) {
      expect(plan.replyReference.use(), name).toBe(expected);
    }
  }
});

function createAutoThreadParams(client: Client) {
  return {
    client,
    channel: "discord",
    agentId: "agent",
    message: {
      id: "1001",
      channelId: "parent",
    } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
    isGuildMessage: true,
    channelConfig: {
      autoThread: true,
    } as unknown as DiscordChannelConfigResolved,
    threadChannel: null,
    baseText: "hello",
    combinedBody: "hello",
    cfg: EMPTY_DISCORD_TEST_CONFIG,
  };
}

it("maybeCreateDiscordAutoThread: reuses existing threads and handles creation failures", async () => {
  const cases = [
    {
      name: "returns existing thread from the initial lookup",
      postError: "A thread has already been created on this message",
      getResponse: { thread: { id: "existing-thread" } },
      expected: "existing-thread",
    },
    {
      name: "other error returns undefined",
      postError: "Some other error",
      getResponse: { thread: null },
      expected: undefined,
    },
  ] as const;

  for (const testCase of cases) {
    const client = {
      rest: {
        post: async () => {
          throw new Error(testCase.postError);
        },
        get: async () => testCase.getResponse,
      },
    } as unknown as Client;

    const result = await maybeCreateDiscordAutoThread(createAutoThreadParams(client));
    expect(result, testCase.name).toBe(testCase.expected);
  }
});

function createAutoThreadPlanParams(overrides?: {
  client?: Client;
  channelConfig?: DiscordChannelConfigResolved;
  threadChannel?: { id: string } | null;
  threadParentInheritanceEnabled?: boolean;
}) {
  const base = createAutoThreadParams(
    overrides?.client ?? ({ rest: { post: async () => ({ id: "thread" }) } } as unknown as Client),
  );
  return {
    ...base,
    channelConfig: overrides?.channelConfig ?? base.channelConfig,
    threadChannel: overrides?.threadChannel ?? null,
    replyToMode: "all" as const,
    agentId: "agent",
    channel: "discord" as const,
    parentSessionKey: sessionKey("parent"),
    threadParentInheritanceEnabled: overrides?.threadParentInheritanceEnabled,
  };
}

it("resolveDiscordAutoThreadReplyPlan: applies auto-thread reply planning across created, existing, and disabled modes", async () => {
  const cases = [
    [undefined, "channel:thread", undefined, sessionKey("thread"), undefined, sessionKey("parent")],
    [
      { threadParentInheritanceEnabled: true },
      "channel:thread",
      undefined,
      sessionKey("thread"),
      sessionKey("parent"),
      sessionKey("parent"),
    ],
    [{ threadChannel: { id: "thread" } }, "channel:thread", "1001", null, undefined, undefined],
    [
      { channelConfig: { autoThread: false } as unknown as DiscordChannelConfigResolved },
      "channel:parent",
      "1001",
      null,
      undefined,
      undefined,
    ],
  ] as const;
  for (const [params, target, reference, session, parent, modelParent] of cases) {
    const plan = await resolveDiscordAutoThreadReplyPlan(createAutoThreadPlanParams(params));
    expect(plan.deliverTarget).toBe(target);
    expect(plan.replyReference.use()).toBe(reference);
    if (session === null) {
      expect(plan.autoThreadContext).toBeNull();
    } else {
      expect(plan.autoThreadContext).toMatchObject({
        SessionKey: session,
      });
      expect(plan.autoThreadContext?.ParentSessionKey).toBe(parent);
      expect(plan.autoThreadContext?.ModelParentSessionKey).toBe(modelParent);
    }
  }
});
