import { isDeepStrictEqual } from "node:util";
import { ChannelFlags, ChannelType, Routes, type APIThreadChannel } from "discord-api-types/v10";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  isDiscordAccountEnabledForRuntime,
  listDiscordAccountIds,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { createDiscordRestClient } from "./client.js";
import { createThread, getChannel, getThreadMember } from "./internal/api.messages.js";
import { withDiscordRequestAuthority } from "./internal/request-authority.js";
import { classifyDiscordDeliveryFailure } from "./retry.js";
import {
  canViewDiscordGuildChannel,
  fetchThreadForkPermissionsDiscord,
} from "./send.permissions.js";
import { resolveDiscordChannelId } from "./target-parsing.js";

type PrepareFork = NonNullable<
  NonNullable<ChannelPlugin<ResolvedDiscordAccount>["conversationBindings"]>["prepareFork"]
>;

/** Native placement only: core owns transcript copying and excerpt selection. */
export const prepareDiscordConversationFork: PrepareFork = async (params) => {
  const sourceId = params.source.conversationId;
  const senderId = params.senderId;
  if (!params.isGroup || !/^\d+$/u.test(sourceId) || !senderId || !/^\d+$/u.test(senderId)) {
    return {
      ok: false,
      reason:
        "Discord /fork requires an existing server thread or forum post and an identified requester.",
    };
  }
  if (params.source.threadId && params.source.threadId !== sourceId) {
    return { ok: false, reason: "Discord fork source does not match the current native thread." };
  }
  let expectedParentId: string | undefined;
  try {
    expectedParentId = params.source.parentConversationId
      ? resolveDiscordChannelId(params.source.parentConversationId)
      : undefined;
  } catch {
    return { ok: false, reason: "Discord fork parent channel is invalid." };
  }
  const readConfig = createRuntimeConfigReader(params.cfg);
  const cfg = readConfig();
  const account = resolveDiscordAccount({ cfg, accountId: params.accountId });
  if (
    !listDiscordAccountIds(cfg).includes(account.accountId) ||
    !isDiscordAccountEnabledForRuntime(account, cfg) ||
    !account.token
  ) {
    return { ok: false, reason: "The selected Discord bot account is disabled or unavailable." };
  }
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    const currentCfg = readConfig();
    const current = resolveDiscordAccount({ cfg: currentCfg, accountId: account.accountId });
    if (
      !listDiscordAccountIds(currentCfg).includes(account.accountId) ||
      !isDiscordAccountEnabledForRuntime(current, currentCfg) ||
      current.token !== account.token ||
      !isDeepStrictEqual(current.config, account.config)
    ) {
      throw new Error("Discord fork account changed. Run /fork again with the current account.");
    }
  };
  const opts = { cfg: params.cfg, accountId: account.accountId, signal: params.signal };
  const rest = createDiscordRestClient(opts).rest;
  const service = getSessionBindingService();
  const assertBindingSupported = () => {
    assertCurrent();
    const capabilities = service.getCapabilities({
      channel: "discord",
      accountId: account.accountId,
    });
    if (
      !capabilities.adapterAvailable ||
      !capabilities.bindSupported ||
      !capabilities.placements.includes("current")
    ) {
      throw new Error(
        "Discord thread bindings are unavailable. Enable thread bindings for this bot account before using /fork.",
      );
    }
  };
  const qualify = async () => {
    assertBindingSupported();
    const source = await getChannel(rest, sourceId);
    assertCurrent();
    if (source.type !== ChannelType.PublicThread && source.type !== ChannelType.PrivateThread) {
      throw new Error(
        "Discord /fork supports existing text threads and forum posts, not DMs, unthreaded channels, announcement threads, or media posts.",
      );
    }
    const parentId = source.parent_id;
    const guildId = source.guild_id;
    if (!parentId || !guildId || (expectedParentId && expectedParentId !== parentId)) {
      throw new Error("Discord could not verify the source thread's parent server channel.");
    }
    const parent = await getChannel(rest, parentId);
    assertCurrent();
    if (
      (parent.type !== ChannelType.GuildText && parent.type !== ChannelType.GuildForum) ||
      parent.guild_id !== guildId ||
      (source.type === ChannelType.PrivateThread && parent.type !== ChannelType.GuildText)
    ) {
      throw new Error(
        "Discord /fork supports text-channel threads and forum posts only; media and announcement parents are not supported.",
      );
    }
    const { requesterCanRead, botPermissions } = await fetchThreadForkPermissionsDiscord(
      guildId,
      source,
      parent,
      senderId,
      { ...opts, rest },
    );
    assertCurrent();
    if (!requesterCanRead) {
      throw new Error(
        "Discord could not confirm your access to the source thread, its message history, and its parent channel.",
      );
    }
    const required = [
      "ViewChannel",
      "ReadMessageHistory",
      "SendMessagesInThreads",
      source.type === ChannelType.PrivateThread
        ? "CreatePrivateThreads"
        : parent.type === ChannelType.GuildForum
          ? "SendMessages"
          : "CreatePublicThreads",
    ];
    if (required.some((permission) => !botPermissions.includes(permission))) {
      throw new Error(
        "The Discord bot needs View Channel, Read Message History, Send Messages in Threads, and permission to create this kind of thread or forum post in the parent channel.",
      );
    }
    const tags =
      parent.type === ChannelType.GuildForum
        ? (source.applied_tags ?? [])
            .filter((id) =>
              parent.available_tags.some(
                (tag) =>
                  tag.id === id && (!tag.moderated || botPermissions.includes("ManageThreads")),
              ),
            )
            .slice(0, 5)
        : [];
    if (
      parent.type === ChannelType.GuildForum &&
      ((parent.flags ?? 0) & ChannelFlags.RequireTag) !== 0 &&
      tags.length === 0
    ) {
      throw new Error(
        "This Discord forum requires a tag, but no source tag can be reused. Add an available tag to the source post before forking.",
      );
    }
    return { source, parent, parentId, guildId, tags };
  };
  let prepared: Awaited<ReturnType<typeof qualify>>;
  try {
    prepared = await withDiscordRequestAuthority(assertCurrent, qualify);
  } catch (error) {
    assertCurrent();
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Discord could not verify this fork source.",
    };
  }
  let attempted = false;
  return {
    ok: true,
    assertCurrent,
    // Break mention tokens rather than relying on client rendering or a later send option.
    formatRecap: (text) => {
      const literal = text.replace(/@/gu, "@\u200b").replace(/</gu, "‹");
      const runs = literal.match(/`+/gu) ?? [];
      const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
      return {
        text: [fence, literal, fence].join("\n"),
        channelData: { discord: { literalText: true } },
      };
    },
    create: async (targetSessionKey) => {
      assertCurrent();
      if (attempted) {
        throw new Error(
          "This Discord fork creation was already attempted. Inspect the parent channel before running /fork again.",
        );
      }
      attempted = true;
      const fresh = await withDiscordRequestAuthority(assertCurrent, qualify);
      assertCurrent();
      if (
        fresh.source.type !== prepared.source.type ||
        fresh.parentId !== prepared.parentId ||
        fresh.guildId !== prepared.guildId
      ) {
        throw new Error(
          "The Discord fork source changed while copying the session. No sibling was created.",
        );
      }
      const name = truncateUtf16Safe(
        (params.title?.trim() || "Fork: " + fresh.source.name).replace(/[\r\n\t]/gu, " "),
        100,
      );
      const privateThread = fresh.source.type === ChannelType.PrivateThread;
      const forum = fresh.parent.type === ChannelType.GuildForum;
      const body = {
        name,
        ...(fresh.parent.default_auto_archive_duration !== undefined
          ? { auto_archive_duration: fresh.parent.default_auto_archive_duration }
          : {}),
        ...(forum
          ? {
              message: {
                content: "Forked conversation. Context follows.",
                allowed_mentions: { parse: [] },
              },
              ...(fresh.tags.length ? { applied_tags: fresh.tags } : {}),
            }
          : { type: fresh.source.type, ...(privateThread ? { invitable: false } : {}) }),
      };
      let created: APIThreadChannel;
      assertBindingSupported();
      try {
        created = await withDiscordRequestAuthority(assertCurrent, () =>
          createThread<APIThreadChannel>(rest, fresh.parentId, { body }),
        );
      } catch (error) {
        const outcome = classifyDiscordDeliveryFailure(error);
        throw new Error(
          outcome === "rejected" || outcome === "pre-connect"
            ? "Discord did not create the fork. Check bot permissions and the parent channel's thread requirements."
            : "Discord fork creation is uncertain; a sibling may exist. Inspect the parent channel before retrying. No automatic retry was made.",
          { cause: error },
        );
      }
      const url = /^\d+$/u.test(created.id ?? "")
        ? "https://discord.com/channels/" + fresh.guildId + "/" + created.id
        : undefined;
      try {
        assertCurrent();
        if (
          !url ||
          created.id === sourceId ||
          created.id === fresh.parentId ||
          created.parent_id !== fresh.parentId ||
          created.guild_id !== fresh.guildId ||
          created.type !== fresh.source.type ||
          (privateThread && created.thread_metadata?.invitable !== false)
        ) {
          throw new Error("Discord did not confirm the expected sibling placement and privacy.");
        }
        if (privateThread) {
          await withDiscordRequestAuthority(assertCurrent, async () => {
            await rest.put(Routes.threadMembers(created.id, senderId));
            assertCurrent();
            const member = await getThreadMember(rest, created.id, senderId);
            assertCurrent();
            if (
              member.user_id !== senderId ||
              !(await canViewDiscordGuildChannel(fresh.guildId, created.id, senderId, opts))
            ) {
              throw new Error("Discord could not confirm requester access to the private fork.");
            }
          });
        }
        assertCurrent();
        const binding = await withDiscordRequestAuthority(assertCurrent, () =>
          service.bind({
            targetSessionKey,
            targetKind: "session",
            placement: "current",
            conversation: {
              channel: "discord",
              accountId: account.accountId,
              conversationId: created.id,
              parentConversationId: fresh.parentId,
            },
            metadata: { boundBy: senderId },
            assertCurrent,
          }),
        );
        assertCurrent();
        return {
          binding,
          url,
          ...(privateThread
            ? {
                notice:
                  "Private fork: only you and the bot are added; other source members are not automatically included. Server members with Manage Threads may still have access. Member invitations are disabled.",
              }
            : {}),
        };
      } catch (error) {
        throw new Error(
          "Discord created a sibling" +
            (url ? " at " + url : " with an unverified identity") +
            ", but fork setup did not complete. No recap was sent. Inspect this sibling before retrying.",
          { cause: error },
        );
      }
    },
  };
};
