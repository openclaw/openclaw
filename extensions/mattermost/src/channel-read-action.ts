// Mattermost message action adapter: read branch.
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
  withNormalizedTimestamp,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
} from "./mattermost/accounts.js";
import type { readMattermostMessages } from "./mattermost/read.js";
import { normalizeMattermostMessagingTarget } from "./normalize.js";

export async function handleMattermostReadAction(
  {
    params,
    cfg,
    accountId,
    conversationReadOrigin,
    requesterAccountId,
    toolContext,
  }: ChannelMessageActionContext,
  // channel.ts owns the lazy channel runtime boundary.
  loadRuntime: () => Promise<{ readMattermostMessages: typeof readMattermostMessages }>,
) {
  const resolvedAccountId = accountId ?? resolveDefaultMattermostAccountId(cfg);
  const account = resolveMattermostAccount({ cfg, accountId: resolvedAccountId });
  if (!account.enabled) {
    throw new Error(`Mattermost account "${resolvedAccountId}" is disabled`);
  }
  const messagesEnabled =
    account.config.actions?.messages ?? cfg.channels?.mattermost?.actions?.messages ?? false;
  if (!messagesEnabled) {
    throw new Error("Mattermost message reads are disabled in config");
  }

  const rawTarget =
    readStringParam(params, "to") ??
    readStringParam(params, "channelId") ??
    readStringParam(params, "target");
  if (!rawTarget) {
    throw new Error("Mattermost read requires target, to, or channelId.");
  }
  const normalizedTarget = normalizeMattermostMessagingTarget(rawTarget);
  const channelId = normalizedTarget?.startsWith("channel:")
    ? normalizedTarget.slice("channel:".length).trim()
    : !rawTarget.includes(":")
      ? rawTarget
      : "";
  if (!channelId) {
    throw new Error("Mattermost read requires a channel target.");
  }

  const before = readStringParam(params, "before");
  const after = readStringParam(params, "after");
  if (before && after) {
    throw new Error("Mattermost read accepts either before or after, not both.");
  }
  const result = await (
    await loadRuntime()
  ).readMattermostMessages({
    cfg,
    channelId,
    limit: readPositiveIntegerParam(params, "limit", {
      message: "limit must be a positive integer.",
    }),
    before,
    after,
    messageId: readStringParam(params, "messageId"),
    accountId: resolvedAccountId,
    context: {
      conversationReadOrigin,
      requesterAccountId,
      toolContext,
    },
  });
  return jsonResult({
    ok: true,
    channelId,
    messages: result.messages.map((message) => withNormalizedTimestamp(message, message.create_at)),
    hasMore: result.hasMore,
  });
}
