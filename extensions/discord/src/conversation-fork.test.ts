import { ChannelFlags, ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveDiscordCommandConversation } from "./channel.conversation.js";
import { createThreadBindingManager } from "./monitor/thread-bindings.manager.js";
import { resetThreadBindingsForTests } from "./monitor/thread-bindings.test-support.js";
import { discordOutbound } from "./outbound-payload.js";
import { getDiscordRuntime } from "./runtime.js";
import { installDiscordIngressTestRuntime } from "./test-support/ingress-runtime.js";
import { discordConversationBindings } from "./thread-bindings-channel.js";

const GUILD = "100000000000000001";
const PARENT = "100000000000000002";
const SOURCE = "100000000000000003";
const CHILD = "100000000000000004";
const USER = "100000000000000005";
const BOT = "100000000000000006";
const SESSION = "agent:main:fork:synthetic";
const cfg = { channels: { discord: { token: "synthetic-token" } } };
const permissions = (
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.SendMessagesInThreads
).toString();
const sourceFixture = () => ({
  id: SOURCE,
  guild_id: GUILD,
  parent_id: PARENT,
  name: "Source",
  type: ChannelType.PublicThread,
  applied_tags: ["tag"],
});
const parentFixture = () => ({
  id: PARENT,
  guild_id: GUILD,
  type: ChannelType.GuildText,
  flags: 0,
  default_auto_archive_duration: 1440,
  available_tags: [{ id: "tag", name: "Topic", moderated: false }],
});
let source = sourceFixture();
let parent = parentFixture();
let current = true;
let memberAccess = true;
let sourceMemberAccess = true;
let requesterPrivilege = 0n;
let guildOwner = BOT;
let permissionFailure = false;
let historyAccess = true;
let createFailure = false;
let revokeOn: string | undefined;
let denied = false;
let requests: Array<{ method: string; path: string; body: unknown }>;

installDiscordIngressTestRuntime();
beforeEach(async () => {
  await resetThreadBindingsForTests();
  resetPluginStateStoreForTests();
  clearRuntimeConfigSnapshot();
  getDiscordRuntime().state.openKeyedStoreV2 = <T>(options: OpenAsyncKeyedStoreOptions) =>
    createPluginStateKeyedStoreV2ForTests<T>("discord", options, { assertCurrent() {} });
  source = sourceFixture();
  parent = parentFixture();
  current = true;
  memberAccess = true;
  sourceMemberAccess = true;
  requesterPrivilege = 0n;
  guildOwner = BOT;
  permissionFailure = false;
  historyAccess = true;
  createFailure = false;
  denied = false;
  revokeOn = undefined;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = decodeURIComponent(
        new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        ).pathname.replace("/api/v10", ""),
      );
      const method = init?.method ?? "GET";
      const body = init?.body;
      if (body != null && typeof body !== "string") {
        throw new Error("Expected a serialized Discord JSON request body");
      }
      requests.push({
        method,
        path,
        body: typeof body === "string" ? JSON.parse(body) : undefined,
      });
      if (revokeOn === path) {
        current = false;
      }
      if (method === "PUT" && path === "/channels/" + CHILD + "/thread-members/" + USER) {
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path === "/channels/" + PARENT + "/threads") {
        if (createFailure) {
          throw new Error("fetch failed");
        }
        return Response.json({ ...source, id: CHILD, thread_metadata: { invitable: false } });
      }
      if (method === "POST" && path.endsWith("/webhooks")) {
        return Response.json({ message: "Missing Permissions", code: 50013 }, { status: 403 });
      }
      if (method === "POST" && path.endsWith("/messages")) {
        return Response.json({ id: "recap", channel_id: CHILD });
      }
      if (path.endsWith("/thread-members/" + USER)) {
        return (path.includes(SOURCE) ? sourceMemberAccess : memberAccess)
          ? Response.json({ id: path.includes(SOURCE) ? SOURCE : CHILD, user_id: USER })
          : Response.json({ message: "Unknown Member", code: 10007 }, { status: 404 });
      }
      if (path === "/channels/" + SOURCE) {
        return Response.json(source);
      }
      if (path === "/channels/" + PARENT) {
        return Response.json(parent);
      }
      if (path === "/channels/" + CHILD) {
        return Response.json({ ...source, id: CHILD });
      }
      if (path === "/users/@me") {
        return Response.json({ id: BOT });
      }
      if (path === "/guilds/" + GUILD) {
        if (permissionFailure) {
          return Response.json({ message: "Missing Access", code: 50001 }, { status: 403 });
        }
        return Response.json({
          id: GUILD,
          owner_id: guildOwner,
          roles: [
            {
              id: GUILD,
              permissions: historyAccess
                ? permissions
                : (
                    PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessagesInThreads
                  ).toString(),
            },
            { id: "requester-role", permissions: requesterPrivilege.toString() },
            {
              id: "bot-role",
              permissions: denied ? "0" : PermissionFlagsBits.Administrator.toString(),
            },
          ],
        });
      }
      if (path.startsWith("/guilds/" + GUILD + "/members/")) {
        return Response.json({ roles: path.endsWith(BOT) ? ["bot-role"] : ["requester-role"] });
      }
      throw new Error("Unexpected Discord request: " + method + " " + path);
    }),
  );
  await createThreadBindingManager({ cfg, persist: false, enableSweeper: false });
});
afterEach(async () => {
  await resetThreadBindingsForTests();
  resetPluginStateStoreForTests();
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const assertCurrent = () => {
  if (!current) {
    throw new Error("Command revoked");
  }
};
const prepare = (
  overrides: Partial<
    Parameters<NonNullable<typeof discordConversationBindings.prepareFork>>[0]
  > = {},
) =>
  discordConversationBindings.prepareFork!({
    cfg,
    accountId: "default",
    source: resolveDiscordCommandConversation({ threadId: SOURCE, threadParentId: PARENT })!,
    isGroup: true,
    senderId: USER,
    assertCurrent,
    ...overrides,
  });
async function prepared(overrides: Parameters<typeof prepare>[0] = {}) {
  const result = await prepare(overrides);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result;
}
const writes = () => requests.filter(({ method }) => method !== "GET");

it("creates a sibling under the native parent and routes the committed child independently", async () => {
  const fork = await prepared({ title: "x".repeat(110) });
  expect(writes()).toEqual([]);
  expect(requests.filter(({ method }) => method === "GET")).toHaveLength(6);
  const result = await fork.create(SESSION);
  const createIndex = requests.findIndex(({ method }) => method === "POST");
  expect(requests.slice(0, createIndex)).toHaveLength(12);
  expect(writes()[0]).toEqual({
    method: "POST",
    path: "/channels/" + PARENT + "/threads",
    body: { name: "x".repeat(100), auto_archive_duration: 1440, type: ChannelType.PublicThread },
  });
  expect(result).toMatchObject({
    url: "https://discord.com/channels/" + GUILD + "/" + CHILD,
    binding: {
      targetKind: "session",
      targetSessionKey: SESSION,
      conversation: { conversationId: CHILD, parentConversationId: PARENT },
    },
  });
  expect(
    await getSessionBindingService().resolveByConversationAsync({
      channel: "discord",
      accountId: "default",
      conversationId: CHILD,
    }),
  ).toMatchObject({ targetSessionKey: SESSION });
  expect(
    await getSessionBindingService().resolveByConversationAsync({
      channel: "discord",
      accountId: "default",
      conversationId: SOURCE,
    }),
  ).toBeNull();
});

it("creates a forum sibling with reusable required tags and an inert starter", async () => {
  parent.type = ChannelType.GuildForum;
  parent.flags = ChannelFlags.RequireTag;
  const result = await (await prepared()).create(SESSION);
  expect(writes()[0]).toEqual({
    method: "POST",
    path: "/channels/" + PARENT + "/threads",
    body: {
      name: "Fork: Source",
      auto_archive_duration: 1440,
      applied_tags: ["tag"],
      message: {
        content: "Forked conversation. Context follows.",
        allowed_mentions: { parse: [] },
      },
    },
  });
  expect(result.binding.conversation.conversationId).toBe(CHILD);
});

it("keeps a private source private and confirms requester membership before publishing the binding", async () => {
  source.type = ChannelType.PrivateThread;
  const fork = await prepared();
  expect(requests.filter(({ method }) => method === "GET")).toHaveLength(7);
  const result = await fork.create(SESSION);
  expect(writes().slice(0, 2)).toEqual([
    {
      method: "POST",
      path: "/channels/" + PARENT + "/threads",
      body: {
        name: "Fork: Source",
        auto_archive_duration: 1440,
        type: ChannelType.PrivateThread,
        invitable: false,
      },
    },
    { method: "PUT", path: "/channels/" + CHILD + "/thread-members/" + USER, body: undefined },
  ]);
  expect(result.notice).toContain("other source members are not automatically included");
  expect(
    requests.some(
      ({ method, path }) =>
        method === "GET" && path === "/channels/" + CHILD + "/thread-members/" + USER,
    ),
  ).toBe(true);
  expect(writes().every(({ path }) => !path.includes("invite"))).toBe(true);
});

it("leaves a known private sibling unbound without a recap if requester access cannot be confirmed", async () => {
  source.type = ChannelType.PrivateThread;
  const fork = await prepared();
  memberAccess = false;
  await expect(fork.create(SESSION)).rejects.toThrow(
    "https://discord.com/channels/" + GUILD + "/" + CHILD,
  );
  expect(writes().map(({ method }) => method)).toEqual(["POST", "PUT"]);
  expect(
    await getSessionBindingService().resolveByConversationAsync({
      channel: "discord",
      accountId: "default",
      conversationId: CHILD,
    }),
  ).toBeNull();
});

it.each(["direct", "unthreaded", "media", "mismatch", "required-tag"])(
  "refuses %s before any native mutation",
  async (kind) => {
    if (kind === "unthreaded") {
      source.type = ChannelType.GuildText;
    }
    if (kind === "media") {
      parent.type = ChannelType.GuildMedia;
    }
    if (kind === "required-tag") {
      parent.type = ChannelType.GuildForum;
      parent.flags = ChannelFlags.RequireTag;
      source.applied_tags = [];
    }
    const result = await prepare({
      ...(kind === "direct" ? { isGroup: false } : {}),
      ...(kind === "mismatch"
        ? { source: { conversationId: SOURCE, parentConversationId: "999" } }
        : {}),
    });
    expect(result.ok).toBe(false);
    expect(writes()).toEqual([]);
  },
);

it.each(
  ["history", "private-membership", "bot-permissions", "api-failure"].flatMap((control) =>
    ["preparation", "pre-create"].map((phase) => ({ control, phase })),
  ),
)("independently refuses $control during $phase", async ({ control, phase }) => {
  source.type = ChannelType.PrivateThread;
  const fork = phase === "pre-create" ? await prepared() : undefined;
  historyAccess = control !== "history";
  sourceMemberAccess = control !== "private-membership";
  denied = control === "bot-permissions";
  permissionFailure = control === "api-failure";
  const reason =
    control === "bot-permissions"
      ? "bot needs"
      : control === "api-failure"
        ? ""
        : "confirm your access";
  if (fork) {
    await expect(fork.create(SESSION)).rejects.toThrow(reason);
  } else {
    expect(await prepare()).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  }
  expect(writes()).toEqual([]);
});

it.each(["owner", "administrator", "moderator"])(
  "preserves private-thread access for a requester who is a guild %s",
  async (privilege) => {
    source.type = ChannelType.PrivateThread;
    sourceMemberAccess = false;
    guildOwner = privilege === "owner" ? USER : BOT;
    historyAccess = privilege === "moderator";
    requesterPrivilege =
      privilege === "administrator"
        ? PermissionFlagsBits.Administrator
        : privilege === "moderator"
          ? PermissionFlagsBits.ManageThreads
          : 0n;
    expect((await prepare()).ok).toBe(true);
    expect(requests.some(({ path }) => path.includes("/thread-members/"))).toBe(false);
  },
);

it.each(["before-create", "permission-read", "after-create"])(
  "rechecks command authority at %s",
  async (phase) => {
    const fork = await prepared();
    if (phase === "before-create") {
      current = false;
    }
    if (phase === "permission-read") {
      revokeOn = "/guilds/" + GUILD;
    }
    if (phase === "after-create") {
      revokeOn = "/channels/" + PARENT + "/threads";
    }
    await expect(fork.create(SESSION)).rejects.toThrow(
      phase === "after-create" ? "No recap was sent" : "Command revoked",
    );
    expect(writes()).toHaveLength(phase === "after-create" ? 1 : 0);
    expect(
      await getSessionBindingService().resolveByConversationAsync({
        channel: "discord",
        accountId: "default",
        conversationId: CHILD,
      }),
    ).toBeNull();
  },
);

it("reports ambiguous creation without automatically retrying or allowing the captured operation to repeat", async () => {
  const fork = await prepared();
  createFailure = true;
  await expect(fork.create(SESSION)).rejects.toThrow("creation is uncertain");
  await expect(fork.create(SESSION)).rejects.toThrow("already attempted");
  expect(writes()).toHaveLength(1);
});

it("delivers copied text through the real outbound transport without activating Discord mentions", async () => {
  const fork = await prepared();
  const payload = fork.formatRecap!("@everyone @here <@123> <@!123> <@&456> <#789> </command:123>");
  await discordOutbound.sendPayload!({
    cfg,
    to: "channel:" + CHILD,
    text: payload.text ?? "",
    payload,
  });
  expect(writes()).toHaveLength(1);
  expect(writes()[0]).toMatchObject({
    method: "POST",
    path: "/channels/" + CHILD + "/messages",
    body: {
      flags: 4,
      allowed_mentions: { parse: [] },
      content:
        "```\n@\u200beveryone @\u200bhere ‹@\u200b123> ‹@\u200b!123> ‹@\u200b&456> ‹#789> ‹/command:123>\n```",
    },
  });
});

it("admits only one native create when the retained operation is called concurrently", async () => {
  const fork = await prepared();
  const results = await Promise.allSettled([fork.create(SESSION), fork.create(SESSION)]);
  expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
  expect(writes().filter(({ path }) => path.endsWith("/threads"))).toHaveLength(1);
});

it.each(["disabled", "removed", "rotated", "policy"])(
  "refuses immutable runtime account replacement: %s",
  async (change) => {
    const initial = { channels: { discord: { token: "synthetic-token", enabled: true } } };
    setRuntimeConfigSnapshot(initial, initial);
    const fork = await prepared({ cfg: initial });
    const replacement =
      change === "removed"
        ? { channels: {} }
        : {
            channels: {
              discord: {
                token: change === "rotated" ? "synthetic-replacement" : "synthetic-token",
                enabled: change !== "disabled",
                ...(change === "policy" ? { allowFrom: ["different-requester"] } : {}),
              },
            },
          };
    setRuntimeConfigSnapshot(replacement, replacement);
    await expect(fork.create(SESSION)).rejects.toThrow("account changed");
    expect(writes()).toEqual([]);
  },
);
