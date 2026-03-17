import { sendTextMediaPayload } from "../../../src/channels/plugins/outbound/direct-text-media.js";
import { resolveOutboundSendDep } from "../../../src/infra/outbound/send-deps.js";
import { getThreadBindingManager } from "./monitor/thread-bindings.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import { sendMessageDiscord, sendPollDiscord, sendWebhookMessageDiscord } from "./send.js";
function resolveDiscordOutboundTarget(params) {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return params.to;
  }
  return `channel:${threadId}`;
}
function resolveDiscordWebhookIdentity(params) {
  const usernameRaw = params.identity?.name?.trim();
  const fallbackUsername = params.binding.label?.trim() || params.binding.agentId;
  const username = (usernameRaw || fallbackUsername || "").slice(0, 80) || void 0;
  const avatarUrl = params.identity?.avatarUrl?.trim() || void 0;
  return { username, avatarUrl };
}
async function maybeSendDiscordWebhookText(params) {
  if (params.threadId == null) {
    return null;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId ?? void 0);
  if (!manager) {
    return null;
  }
  const binding = manager.getByThreadId(threadId);
  if (!binding?.webhookId || !binding?.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    identity: params.identity,
    binding
  });
  const result = await sendWebhookMessageDiscord(params.text, {
    webhookId: binding.webhookId,
    webhookToken: binding.webhookToken,
    accountId: binding.accountId,
    threadId: binding.threadId,
    cfg: params.cfg,
    replyTo: params.replyToId ?? void 0,
    username: persona.username,
    avatarUrl: persona.avatarUrl
  });
  return result;
}
const discordOutbound = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2e3,
  pollMaxOptions: 10,
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendPayload: async (ctx) => await sendTextMediaPayload({ channel: "discord", ctx, adapter: discordOutbound }),
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity, silent }) => {
    if (!silent) {
      const webhookResult = await maybeSendDiscordWebhookText({
        cfg,
        text,
        threadId,
        accountId,
        identity,
        replyToId
      }).catch(() => null);
      if (webhookResult) {
        return { channel: "discord", ...webhookResult };
      }
    }
    const send = resolveOutboundSendDep(deps, "discord") ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to, threadId });
    const result = await send(target, text, {
      verbose: false,
      replyTo: replyToId ?? void 0,
      accountId: accountId ?? void 0,
      silent: silent ?? void 0,
      cfg
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    silent
  }) => {
    const send = resolveOutboundSendDep(deps, "discord") ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to, threadId });
    const result = await send(target, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
      replyTo: replyToId ?? void 0,
      accountId: accountId ?? void 0,
      silent: silent ?? void 0,
      cfg
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) => {
    const target = resolveDiscordOutboundTarget({ to, threadId });
    return await sendPollDiscord(target, poll, {
      accountId: accountId ?? void 0,
      silent: silent ?? void 0,
      cfg
    });
  }
};
export {
  discordOutbound
};
