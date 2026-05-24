import {
  createChannelPluginBase,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
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
    triggerName: (
      raw.triggerName ||
      raw.character ||
      raw.username ||
      id
    ).toLowerCase(),
    startRoom: raw.startRoom,
    allowFrom: raw.allowFrom || [],
    allowedRooms: raw.allowedRooms || [],
    respondToAmbientMentions: raw.respondToAmbientMentions !== false,
    autonomy: {
      enabled: Boolean(raw.autonomy?.enabled),
      intervalMs: Math.max(10000, Number(raw.autonomy?.intervalMs || 90000)),
      idleChance: Math.max(
        0,
        Math.min(1, Number(raw.autonomy?.idleChance ?? 0.5)),
      ),
      commands: Array.isArray(raw.autonomy?.commands)
        ? raw.autonomy.commands.map(String).filter(Boolean)
        : ["look"],
    },
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
      character: account.character,
    };
  } catch (err) {
    return {
      enabled: false,
      configured: false,
      error: String(err?.message || err),
    };
  }
}

function readToolString(raw, key, { required = false } = {}) {
  const value = raw?.[key];
  if (value === undefined || value === null) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

export function createEvenniaCommandTool() {
  return {
    name: "evennia_command",
    label: "Evennia Command",
    description:
      "Send one raw command to an Evennia character. Evennia is the authority for permissions and game effects; this tool only rejects empty or multiline transport input.",
    parameters: Type.Object({
      command: Type.String({
        description:
          "One Evennia command to execute exactly as the character, for example: look, north, get key, use terminal, say hello. Must not contain newlines.",
      }),
      accountId: Type.Optional(
        Type.String({
          description:
            "Configured Evennia account id/character route to use. Defaults to the first connected account.",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams) {
      const command = readToolString(rawParams, "command", {
        required: true,
      }).trim();
      if (!command) throw new Error("command must not be empty");
      if (command.includes("\n") || command.includes("\r")) {
        throw new Error(
          "command must be a single Evennia command without newlines",
        );
      }

      const requestedAccountId = readToolString(rawParams, "accountId")?.trim();
      const accountId = requestedAccountId || clients.keys().next().value;
      if (!accountId)
        throw new Error("no connected Evennia accounts are available");
      const client = clients.get(accountId);
      if (!client)
        throw new Error(`evennia account ${accountId} is not connected`);
      await client.command(command);
      return jsonResult({ ok: true, accountId, command });
    },
  };
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
    target: direct ? event.sender : event.room || "room",
  });
  const storePath = rt.session.resolveStorePath(undefined, {
    agentId: account.agentId,
  });
  const ctxPayload = rt.turn.buildContext({
    channel: "evennia",
    accountId: account.accountId,
    provider: "evennia",
    surface: "evennia",
    messageId,
    timestamp: event.timestamp || Date.now(),
    from: event.sender,
    sender: {
      id: event.sender,
      name: event.sender,
      displayLabel: event.sender,
      isBot: false,
      isSelf: false,
    },
    conversation: {
      kind: direct ? "direct" : "group",
      id: direct ? event.sender : event.room || "room",
      label: direct ? event.sender : event.room || "Evennia room",
      routePeer: {
        kind: direct ? "direct" : "group",
        id: direct ? event.sender : event.room || "room",
      },
    },
    route: {
      agentId: account.agentId,
      accountId: account.accountId,
      routeSessionKey,
      createIfMissing: true,
    },
    reply: {
      to: account.accountId,
      originatingTo: account.accountId,
      deliveryTarget: account.accountId,
      replyToId: messageId,
    },
    message: {
      rawBody: event.text,
      body: event.text,
      bodyForAgent: `[Evennia ${direct ? "tell" : "room"} from ${event.sender}${event.room ? ` in ${event.room}` : ""}]\n${event.text}`,
      commandBody: event.text,
      envelopeFrom: event.sender,
      senderLabel: event.sender,
      preview: event.text.slice(0, 200),
    },
    access: {
      dm: direct
        ? {
            decision: "allow",
            allowFrom: account.allowFrom,
            reason: "evennia-direct",
          }
        : undefined,
      group: !direct
        ? {
            policy: "open",
            routeAllowed: true,
            senderAllowed: true,
            allowFrom: account.allowFrom,
            requireMention: true,
          }
        : undefined,
      mentions: {
        canDetectMention: true,
        wasMentioned: direct || mentioned,
        hasAnyMention: mentioned,
      },
    },
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
    dispatchReplyWithBufferedBlockDispatcher:
      rt.reply.dispatchReplyWithBufferedBlockDispatcher,
    messageId,
    admission: {
      kind: "dispatch",
      reason: direct ? "direct-tell" : "mentioned",
    },
    delivery: {
      deliver: async (payload) => {
        const text = payload?.text || payload?.content || "";
        if (text.trim()) {
          const client = clients.get(account.accountId);
          if (event.replyMode === "tell")
            await client?.tell(event.sender, text.trim());
          else if (event.replyMode === "whisper")
            await client?.whisper(event.sender, text.trim());
          else await client?.say(text.trim());
        }
        return {
          messageIds: [`evennia-out-${Date.now()}`],
          visibleReplySent: true,
        };
      },
    },
  });
}

function startAutonomyLoop(ctx, account, client) {
  const autonomy = account.autonomy;
  if (!autonomy?.enabled || !autonomy.commands.length) return () => {};
  let busy = false;
  const tick = async () => {
    if (busy || client.isClosed()) return;
    if (Math.random() < autonomy.idleChance) return;
    const command =
      autonomy.commands[Math.floor(Math.random() * autonomy.commands.length)];
    if (!command || command.includes("\n") || command.includes("\r")) return;
    busy = true;
    try {
      await client.command(command);
    } catch (err) {
      ctx.log?.warn?.(
        `evennia autonomy command failed: ${err?.message || err}`,
      );
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, autonomy.intervalMs);
  timer.unref?.();
  ctx.abortSignal.addEventListener("abort", () => clearInterval(timer), {
    once: true,
  });
  return () => clearInterval(timer);
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
      isConfigured: (account) =>
        Boolean(account.username && account.passwordFile),
      describeAccount: (account) => ({
        id: account.accountId,
        name: account.character || account.username,
        enabled: account.enabled,
        configured: Boolean(account.username && account.passwordFile),
        connected: clients.has(account.accountId),
      }),
    },
    setup: {
      applyAccountConfig: ({ cfg }) => cfg,
    },
  }),
  outbound: {
    base: {
      deliveryMode: "gateway",
      resolveTarget: ({ to }) => ({ ok: true, to: to || "default" }),
    },
    attachedResults: {
      channel: "evennia",
      sendText: async ({ to, text, accountId }) => {
        const id = accountId || to;
        const client = clients.get(id);
        if (!client) throw new Error(`evennia account ${id} is not connected`);
        await client.say(text);
        return { messageId: `evennia-out-${Date.now()}` };
      },
    },
  },
});

// createChatChannelPlugin intentionally focuses the common chat surfaces; attach
// the long-running gateway adapter explicitly for this external transport.
evenniaPlugin.gateway = {
  startAccount: async (ctx) => {
    if (!ctx.account.enabled) return;
    const client = new EvenniaClient(ctx.account, ctx.log);
    clients.set(ctx.account.accountId, client);
    ctx.abortSignal.addEventListener("abort", () => client.close(), {
      once: true,
    });
    client.onEvent((event) =>
      dispatchEvenniaEvent(ctx, ctx.account, event).catch((err) =>
        ctx.log?.error?.(
          `evennia inbound failed: ${err?.stack || err?.message || err}`,
        ),
      ),
    );
    await client.connect();
    startAutonomyLoop(ctx, ctx.account, client);
    if (ctx.account.character)
      await client.command(`ic ${ctx.account.character}`).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (ctx.account.startRoom)
      await client.command(`teleport ${ctx.account.startRoom}`).catch(() => {});
    await client.command("look").catch(() => {});
    ctx.setStatus({
      accountId: ctx.account.accountId,
      id: ctx.account.accountId,
      name: ctx.account.character,
      enabled: true,
      configured: true,
      connected: true,
      running: true,
    });
    await new Promise((resolve) =>
      ctx.abortSignal.addEventListener("abort", resolve, { once: true }),
    );
  },
  stopAccount: async ({ account }) => {
    const client = clients.get(account.accountId);
    clients.delete(account.accountId);
    client?.close();
  },
};
