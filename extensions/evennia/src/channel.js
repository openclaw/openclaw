import { createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { EvenniaClient } from "./evennia-client.js";

const clients = new Map();

function channelSection(cfg) {
  return (cfg.channels && cfg.channels.evennia) || {};
}

function listAccountIds(cfg) {
  return Object.keys(channelSection(cfg).accounts || {});
}

function resolveAccount(cfg, accountId = null) {
  const section = channelSection(cfg);
  const accounts = section.accounts || {};
  const id = accountId || Object.keys(accounts)[0] || "default";
  const raw = accounts[id] || {};
  return {
    accountId: id,
    enabled: section.enabled !== false && raw.enabled !== false,
    baseUrl: section.baseUrl || "http://127.0.0.1:14001",
    websocketUrl: section.websocketUrl || "ws://127.0.0.1:14002",
    agentId: raw.agentId || id,
    username: raw.username,
    passwordFile: raw.passwordFile,
    character: raw.character || raw.username,
    triggerName: (raw.triggerName || raw.character || raw.username || id).toLowerCase(),
    startRoom: raw.startRoom,
    allowFrom: raw.allowFrom || [],
    allowedRooms: raw.allowedRooms || [],
    respondToAmbientMentions: raw.respondToAmbientMentions !== false
  };
}

function inspectAccount(cfg, accountId = null) {
  try {
    const account = resolveAccount(cfg, accountId);
    return {
      enabled: account.enabled,
      configured: Boolean(account.username && account.passwordFile),
      tokenStatus: account.passwordFile ? "file" : "missing",
      accountId: account.accountId,
      character: account.character
    };
  } catch (err) {
    return { enabled: false, configured: false, error: String(err?.message || err) };
  }
}

async function dispatchEvenniaEvent(ctx, account, event) {
  const rt = ctx.channelRuntime;
  if (!rt) {
    ctx.log?.warn?.("evennia channelRuntime unavailable; inbound ignored");
    return;
  }
  const lower = event.text.toLowerCase();
  const direct = event.kind === "tell" || event.kind === "whisper";
  const mentioned = lower.includes(account.triggerName.toLowerCase());
  if (!direct && account.respondToAmbientMentions && !mentioned) return;

  const messageId = event.id || `evennia-${Date.now()}`;
  const routeSessionKey = rt.routing.buildAgentSessionKey({
    agentId: account.agentId,
    channel: "evennia",
    chatType: direct ? "direct" : "group",
    target: direct ? event.sender : (event.room || "room")
  });
  const storePath = rt.session.resolveStorePath(undefined, { agentId: account.agentId });
  const ctxPayload = rt.turn.buildContext({
    channel: "evennia",
    accountId: account.accountId,
    provider: "evennia",
    surface: "evennia",
    messageId,
    timestamp: event.timestamp || Date.now(),
    from: event.sender,
    sender: { id: event.sender, name: event.sender, displayLabel: event.sender, isBot: false, isSelf: false },
    conversation: {
      kind: direct ? "direct" : "group",
      id: direct ? event.sender : (event.room || "room"),
      label: direct ? event.sender : (event.room || "Evennia room"),
      routePeer: { kind: direct ? "direct" : "group", id: direct ? event.sender : (event.room || "room") }
    },
    route: { agentId: account.agentId, accountId: account.accountId, routeSessionKey, createIfMissing: true },
    reply: { to: account.accountId, originatingTo: account.accountId, deliveryTarget: account.accountId, replyToId: messageId },
    message: {
      rawBody: event.text,
      body: event.text,
      bodyForAgent: `[Evennia ${direct ? "tell" : "room"} from ${event.sender}${event.room ? ` in ${event.room}` : ""}]\n${event.text}`,
      commandBody: event.text,
      envelopeFrom: event.sender,
      senderLabel: event.sender,
      preview: event.text.slice(0, 200)
    },
    access: {
      dm: direct ? { decision: "allow", allowFrom: account.allowFrom, reason: "evennia-direct" } : undefined,
      group: !direct ? { policy: "open", routeAllowed: true, senderAllowed: true, allowFrom: account.allowFrom, requireMention: true } : undefined,
      mentions: { canDetectMention: true, wasMentioned: direct || mentioned, hasAnyMention: mentioned }
    }
  });

  await rt.turn.dispatchAssembled({
    cfg: ctx.cfg,
    channel: "evennia",
    accountId: account.accountId,
    agentId: account.agentId,
    routeSessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: rt.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: rt.reply.dispatchReplyWithBufferedBlockDispatcher,
    messageId,
    admission: { kind: "dispatch", reason: direct ? "direct-tell" : "mentioned" },
    delivery: {
      deliver: async (payload) => {
        const text = payload?.text || payload?.content || "";
        if (text.trim()) {
          const client = clients.get(account.accountId);
          if (event.replyMode === "tell") await client?.tell(event.sender, text.trim());
          else if (event.replyMode === "whisper") await client?.whisper(event.sender, text.trim());
          else await client?.say(text.trim());
        }
        return { messageIds: [`evennia-out-${Date.now()}`], visibleReplySent: true };
      }
    }
  });
}

export const evenniaPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "evennia",
    config: {
      listAccountIds,
      resolveAccount,
      inspectAccount,
      defaultAccountId: (cfg) => listAccountIds(cfg)[0] || "default",
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => Boolean(account.username && account.passwordFile),
      describeAccount: (account) => ({
        id: account.accountId,
        name: account.character || account.username,
        enabled: account.enabled,
        configured: Boolean(account.username && account.passwordFile),
        connected: clients.has(account.accountId)
      })
    },
    setup: {
      applyAccountConfig: ({ cfg }) => cfg
    }
  }),
  outbound: {
    base: {
      deliveryMode: "gateway",
      resolveTarget: ({ to }) => ({ ok: true, to: to || "default" })
    },
    attachedResults: {
      channel: "evennia",
      sendText: async ({ to, text, accountId }) => {
        const id = accountId || to;
        const client = clients.get(id);
        if (!client) throw new Error(`evennia account ${id} is not connected`);
        await client.say(text);
        return { messageId: `evennia-out-${Date.now()}` };
      }
    }
  }
});

// createChatChannelPlugin intentionally focuses the common chat surfaces; attach
// the long-running gateway adapter explicitly for this external transport.
evenniaPlugin.gateway = {
  startAccount: async (ctx) => {
    if (!ctx.account.enabled) return;
    const client = new EvenniaClient(ctx.account, ctx.log);
    clients.set(ctx.account.accountId, client);
    ctx.abortSignal.addEventListener("abort", () => client.close(), { once: true });
    client.onEvent((event) => dispatchEvenniaEvent(ctx, ctx.account, event).catch((err) => ctx.log?.error?.(`evennia inbound failed: ${err?.stack || err?.message || err}`)));
    await client.connect();
    if (ctx.account.character) await client.command(`ic ${ctx.account.character}`).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (ctx.account.startRoom) await client.command(`teleport ${ctx.account.startRoom}`).catch(() => {});
    await client.command("look").catch(() => {});
    ctx.setStatus({ accountId: ctx.account.accountId, id: ctx.account.accountId, name: ctx.account.character, enabled: true, configured: true, connected: true, running: true });
    await new Promise((resolve) => ctx.abortSignal.addEventListener("abort", resolve, { once: true }));
  },
  stopAccount: async ({ account }) => {
    const client = clients.get(account.accountId);
    clients.delete(account.accountId);
    client?.close();
  }
};
