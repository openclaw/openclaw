import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { resolveInboundDirectDmAccessWithRuntime } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { getVkGroupsById, getVkLongPollServer, pollVkLongPoll } from "./api.js";
import { sendVkText } from "./send.js";
import type { ResolvedVkAccount } from "./types.js";

const VK_GROUP_CHAT_PEER_ID_MIN = 2_000_000_000;

type VkStatusSink = (patch: {
  connected?: boolean;
  lastConnectedAt?: number | null;
  lastDisconnect?: { at: number; error?: string } | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastError?: string | null;
  profile?: unknown;
}) => void;

export type VkMonitorOptions = {
  token: string;
  account: ResolvedVkAccount;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  abortSignal: AbortSignal;
  statusSink: VkStatusSink;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
};

function normalizeVkUserId(raw: string): string | "*" | null {
  const trimmed = raw.trim().replace(/^vk:/i, "");
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function isVkSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  for (const entry of allowFrom) {
    const normalized = normalizeVkUserId(entry);
    if (normalized === "*") {
      return true;
    }
    if (normalized === senderId) {
      return true;
    }
  }
  return false;
}

function getVkMessageId(msg: Record<string, unknown>, peerId: string): string {
  const candidates = [msg.id, msg.conversation_message_id, msg.update_time, msg.date];
  for (const candidate of candidates) {
    if (typeof candidate === "number" || typeof candidate === "string") {
      const value = String(candidate).trim();
      if (value) {
        return `${peerId}:${value}`;
      }
    }
  }
  return `${peerId}:${Date.now()}`;
}

async function handleVkUpdate(params: {
  update: unknown;
  token: string;
  account: ResolvedVkAccount;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  pairing: ReturnType<typeof createChannelPairingController>;
  statusSink: VkStatusSink;
  log?: VkMonitorOptions["log"];
}) {
  const { update, token, account, config, runtime, pairing, statusSink, log } = params;
  if (!update || typeof update !== "object") {
    return;
  }
  const typedUpdate = update as {
    type?: string;
    object?:
      | {
          message?: Record<string, unknown>;
        }
      | Record<string, unknown>;
  };
  if (typedUpdate.type !== "message_new") {
    return;
  }
  const msg =
    typedUpdate.object && typeof typedUpdate.object === "object"
      ? ((typedUpdate.object as { message?: Record<string, unknown> }).message ??
        (typedUpdate.object as Record<string, unknown>))
      : null;
  if (!msg) {
    return;
  }
  const peerId = Number(msg.peer_id ?? msg.from_id ?? 0);
  const senderId = Number(msg.from_id ?? 0);
  const isOutgoing = Number(msg.out ?? 0) === 1;
  if (!Number.isFinite(peerId) || !Number.isFinite(senderId) || peerId <= 0 || senderId <= 0) {
    return;
  }
  if (isOutgoing) {
    return;
  }
  if (peerId >= VK_GROUP_CHAT_PEER_ID_MIN) {
    log?.debug?.(
      `[${account.accountId}] skipping VK group message peer=${String(peerId)} sender=${String(senderId)}`,
    );
    return;
  }

  const rawBody = String(msg.text ?? "");
  statusSink({
    lastInboundAt: Date.now(),
    lastError: null,
  });

  const resolvedAccess = await resolveInboundDirectDmAccessWithRuntime({
    cfg: config,
    channel: "vk",
    accountId: account.accountId,
    dmPolicy: account.config.dmPolicy ?? "pairing",
    allowFrom: account.config.allowFrom,
    senderId: String(senderId),
    rawBody,
    isSenderAllowed: isVkSenderAllowed,
    runtime: {
      shouldComputeCommandAuthorized: runtime.channel.commands.shouldComputeCommandAuthorized,
      resolveCommandAuthorizedFromAuthorizers:
        runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers,
    },
    modeWhenAccessGroupsOff: "configured",
  });

  if (resolvedAccess.access.decision === "pairing") {
    await pairing.issueChallenge({
      senderId: String(senderId),
      senderIdLine: `Your VK user id: ${String(senderId)}`,
      sendPairingReply: async (text) => {
        await sendVkText(senderId, text, { token });
        statusSink({ lastOutboundAt: Date.now() });
      },
      onCreated: () => {
        log?.debug?.(`[${account.accountId}] VK pairing request sender=${String(senderId)}`);
      },
      onReplyError: (err) => {
        log?.warn?.(
          `[${account.accountId}] VK pairing reply failed for ${String(senderId)}: ${String(err)}`,
        );
      },
    });
    return;
  }

  if (resolvedAccess.access.decision !== "allow") {
    log?.debug?.(
      `[${account.accountId}] blocked VK sender ${String(senderId)} (${resolvedAccess.access.reason})`,
    );
    return;
  }

  await dispatchInboundDirectDmWithRuntime({
    cfg: config,
    runtime,
    channel: "vk",
    channelLabel: "VK",
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: String(senderId),
    },
    senderId: String(senderId),
    senderAddress: `vk:${String(senderId)}`,
    recipientAddress: `vk:group:${account.accountId}`,
    conversationLabel: String(senderId),
    rawBody,
    messageId: getVkMessageId(msg, String(peerId)),
    timestamp: typeof msg.date === "number" ? msg.date * 1000 : Date.now(),
    commandAuthorized: resolvedAccess.commandAuthorized,
    deliver: async (payload) => {
      const outboundText =
        payload && typeof payload === "object" && "text" in payload
          ? String((payload as { text?: string }).text ?? "")
          : "";
      if (!outboundText.trim()) {
        return;
      }
      await sendVkText(peerId, outboundText, { token });
      statusSink({ lastOutboundAt: Date.now() });
    },
    onRecordError: (err) => {
      log?.error?.(`[${account.accountId}] failed recording VK inbound session: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      log?.error?.(`[${account.accountId}] VK ${info.kind} reply failed: ${String(err)}`);
    },
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function monitorVkProvider(params: VkMonitorOptions): Promise<void> {
  const { token, account, config, runtime, abortSignal, statusSink, log } = params;
  const pairing = createChannelPairingController({
    core: runtime,
    channel: "vk",
    accountId: account.accountId,
  });

  const groups = await getVkGroupsById(token);
  const group = groups[0];
  if (!group) {
    throw new Error("VK token did not resolve a group");
  }
  statusSink({
    connected: true,
    lastConnectedAt: Date.now(),
    profile: {
      id: group.id,
      name: group.name,
      screenName: group.screen_name,
    },
    lastError: null,
  });

  let longPoll = await getVkLongPollServer(token, group.id);
  while (!abortSignal.aborted) {
    try {
      const data = await pollVkLongPoll({
        server: longPoll.server,
        key: longPoll.key,
        ts: longPoll.ts,
      });

      if (data.failed) {
        if (data.failed === 1 && data.ts) {
          longPoll.ts = data.ts;
          continue;
        }
        log?.warn?.(
          `[${account.accountId}] VK long poll failed=${String(data.failed)}, reconnecting`,
        );
        longPoll = await getVkLongPollServer(token, group.id);
        continue;
      }

      longPoll.ts = data.ts;
      for (const update of data.updates ?? []) {
        await handleVkUpdate({
          update,
          token,
          account,
          config,
          runtime,
          pairing,
          statusSink,
          log,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusSink({
        connected: false,
        lastDisconnect: {
          at: Date.now(),
          error: message,
        },
        lastError: message,
      });
      if (abortSignal.aborted) {
        break;
      }
      log?.warn?.(`[${account.accountId}] VK polling error: ${message}`);
      await delay(5000, abortSignal);
      if (abortSignal.aborted) {
        break;
      }
      longPoll = await getVkLongPollServer(token, group.id);
      statusSink({
        connected: true,
        lastConnectedAt: Date.now(),
        lastError: null,
      });
    }
  }
}
