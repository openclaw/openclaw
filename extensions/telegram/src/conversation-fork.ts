import { isDeepStrictEqual } from "node:util";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getSessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import { listTelegramAccountIds, mergeTelegramAccountConfig } from "./accounts.js";
import { loadTelegramSendModule } from "./send-runtime.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

type PrepareFork = NonNullable<NonNullable<ChannelPlugin["conversationBindings"]>["prepareFork"]>;

/** Topic links do not grant membership in the source supergroup. */
function topicUrl(chatId: string, topicId: number): string | undefined {
  const internalId = /^-100([1-9]\d*)$/.exec(chatId)?.[1];
  return internalId ? "https://t.me/c/" + internalId + "/" + topicId : undefined;
}

export const prepareTelegramConversationFork: PrepareFork = async (params) => {
  const topic = parseTelegramTopicConversation(params.source);
  if (
    !params.isGroup ||
    !topic ||
    topic.thread.scope !== "forum" ||
    !/^-100[1-9]\d*$/.test(topic.chatId)
  ) {
    return {
      ok: false,
      reason: "/fork requires a Telegram forum topic, not a DM or an unthreaded group.",
    };
  }
  const title = params.title ?? "Forked conversation";
  if (Array.from(title).length > 128) {
    return { ok: false, reason: "Telegram topic titles must be at most 128 characters." };
  }
  const readConfig = createRuntimeConfigReader(params.cfg);
  const cfg = readConfig();
  const accountConfig = mergeTelegramAccountConfig(cfg, params.accountId);
  const assertCurrent = () => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
    const current = readConfig();
    if (
      current.channels?.telegram?.enabled === false ||
      !listTelegramAccountIds(current).includes(params.accountId) ||
      !isDeepStrictEqual(mergeTelegramAccountConfig(current, params.accountId), accountConfig) ||
      accountConfig.enabled === false
    ) {
      throw new Error("Telegram account or policy changed; send a new /fork request.");
    }
  };
  assertCurrent();
  const bindings = getSessionBindingService();
  const capabilities = bindings.getCapabilities({
    channel: "telegram",
    accountId: params.accountId,
  });
  if (!capabilities.bindSupported || !capabilities.placements.includes("current")) {
    return {
      ok: false,
      reason:
        "Telegram thread bindings are unavailable. Enable thread bindings for this account before using /fork.",
    };
  }
  assertCurrent();
  return {
    ok: true,
    assertCurrent,
    formatRecap: (text) => {
      // A longer fence keeps copied Markdown, mentions, links, and image syntax inside native code.
      const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      return {
        text: [fence, text, fence].join("\n"),
        channelData: { telegram: { linkPreview: false } },
      };
    },
    create: async (targetSessionKey) => {
      const { createForumTopicTelegram } = await loadTelegramSendModule();
      params.signal?.throwIfAborted();
      assertCurrent();
      const created = await createForumTopicTelegram(topic.chatId, title, {
        cfg,
        accountId: params.accountId,
        assertPlatformSendAuthorized: assertCurrent,
      });
      const conversationId = created.chatId + ":topic:" + created.topicId;
      const url = topicUrl(created.chatId, created.topicId);
      try {
        params.signal?.throwIfAborted();
        assertCurrent();
        const binding = await bindings.bind({
          targetSessionKey,
          targetKind: "session",
          placement: "current",
          conversation: {
            channel: "telegram",
            accountId: params.accountId,
            conversationId,
            parentConversationId: created.chatId,
          },
          metadata: { threadName: title, boundBy: params.senderId },
          assertCurrent,
        });
        return { binding, url };
      } catch (error) {
        // Retain the observed native identity when persistence fails; never create another topic here.
        throw new Error(
          "Telegram topic " +
            (url ?? conversationId) +
            " was created, but its session binding was not confirmed: " +
            formatErrorMessage(error),
          { cause: error },
        );
      }
    },
  };
};
