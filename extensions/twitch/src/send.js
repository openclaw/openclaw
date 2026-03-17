import { getClientManager as getRegistryClientManager } from "./client-manager-registry.js";
import { DEFAULT_ACCOUNT_ID, getAccountConfig } from "./config.js";
import { resolveTwitchToken } from "./token.js";
import { stripMarkdownForTwitch } from "./utils/markdown.js";
import { generateMessageId, isAccountConfigured, normalizeTwitchChannel } from "./utils/twitch.js";
async function sendMessageTwitchInternal(channel, text, cfg, accountId = DEFAULT_ACCOUNT_ID, stripMarkdown = true, logger = console) {
  const account = getAccountConfig(cfg, accountId);
  if (!account) {
    const availableIds = Object.keys(cfg.channels?.twitch?.accounts ?? {});
    return {
      ok: false,
      messageId: generateMessageId(),
      error: `Account not found: ${accountId}. Available accounts: ${availableIds.join(", ") || "none"}`
    };
  }
  const tokenResolution = resolveTwitchToken(cfg, { accountId });
  if (!isAccountConfigured(account, tokenResolution.token)) {
    return {
      ok: false,
      messageId: generateMessageId(),
      error: `Account ${accountId} is not properly configured. Required: username, clientId, and token (config or env for default account).`
    };
  }
  const normalizedChannel = channel || account.channel;
  if (!normalizedChannel) {
    return {
      ok: false,
      messageId: generateMessageId(),
      error: "No channel specified and no default channel in account config"
    };
  }
  const cleanedText = stripMarkdown ? stripMarkdownForTwitch(text) : text;
  if (!cleanedText) {
    return {
      ok: true,
      messageId: "skipped"
    };
  }
  const clientManager = getRegistryClientManager(accountId);
  if (!clientManager) {
    return {
      ok: false,
      messageId: generateMessageId(),
      error: `Client manager not found for account: ${accountId}. Please start the Twitch gateway first.`
    };
  }
  try {
    const result = await clientManager.sendMessage(
      account,
      normalizeTwitchChannel(normalizedChannel),
      cleanedText,
      cfg,
      accountId
    );
    if (!result.ok) {
      return {
        ok: false,
        messageId: result.messageId ?? generateMessageId(),
        error: result.error ?? "Send failed"
      };
    }
    return {
      ok: true,
      messageId: result.messageId ?? generateMessageId()
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to send message: ${errorMsg}`);
    return {
      ok: false,
      messageId: generateMessageId(),
      error: errorMsg
    };
  }
}
export {
  sendMessageTwitchInternal
};
