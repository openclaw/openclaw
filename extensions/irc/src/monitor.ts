// Irc plugin module implements monitor behavior.
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveIrcAccount } from "./accounts.js";
import { connectIrcClient, type IrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import { handleIrcInbound } from "./inbound.js";
import { isChannelTarget } from "./normalize.js";
import { makeIrcMessageId } from "./protocol.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { getIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

type IrcMonitorStatusPatch = Partial<
  Pick<
    ChannelAccountSnapshot,
    | "running"
    | "connected"
    | "lastStartAt"
    | "lastStopAt"
    | "lastConnectedAt"
    | "lastDisconnect"
    | "lastError"
    | "lastInboundAt"
    | "lastOutboundAt"
  >
>;

type IrcMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: IrcMonitorStatusPatch) => void;
  onMessage?: (message: IrcInboundMessage, client: IrcClient) => void | Promise<void>;
};

const IRC_MONITOR_RECONNECT_DELAY_MS = 1000;

export function resolveIrcInboundTarget(params: { target: string; senderNick: string }): {
  isGroup: boolean;
  target: string;
  rawTarget: string;
} {
  const rawTarget = params.target;
  const isGroup = isChannelTarget(rawTarget);
  if (isGroup) {
    return { isGroup: true, target: rawTarget, rawTarget };
  }
  const senderNick = params.senderNick.trim();
  return { isGroup: false, target: senderNick || rawTarget, rawTarget };
}

export async function monitorIrcProvider(opts: IrcMonitorOptions): Promise<{ stop: () => void }> {
  const core = getIrcRuntime();
  const cfg = opts.config ?? (core.config.current() as CoreConfig);
  const account = resolveIrcAccount({
    cfg,
    accountId: opts.accountId,
  });

  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.configured) {
    throw new Error(
      `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "irc",
    accountId: account.accountId,
  });

  let client: IrcClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const monitorAbort = new AbortController();
  let removeAbortListener: (() => void) | null = null;

  function publishConnectedStatus() {
    const now = Date.now();
    opts.statusSink?.({
      running: true,
      connected: true,
      lastStartAt: now,
      lastConnectedAt: now,
      lastDisconnect: null,
      lastError: null,
    });
  }

  function publishDisconnectedStatus(error: string) {
    opts.statusSink?.({
      running: false,
      connected: false,
      lastDisconnect: { at: Date.now(), error },
      lastError: error,
    });
  }
  if (opts.abortSignal) {
    const forwardAbort = () => monitorAbort.abort();
    if (opts.abortSignal.aborted) {
      forwardAbort();
    } else {
      opts.abortSignal.addEventListener("abort", forwardAbort, { once: true });
      removeAbortListener = () => opts.abortSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  function scheduleReconnect() {
    if (stopped || monitorAbort.signal.aborted || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch((error: unknown) => {
        if (stopped || monitorAbort.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[${account.accountId}] IRC reconnect failed: ${message}`);
        scheduleReconnect();
      });
    }, IRC_MONITOR_RECONNECT_DELAY_MS);
  }

  async function connect() {
    if (stopped || monitorAbort.signal.aborted) {
      return;
    }
    let nextClient: IrcClient;
    try {
      nextClient = await connectIrcClient(
        buildIrcConnectOptions(account, {
          channels: account.config.channels,
          abortSignal: monitorAbort.signal,
          onLine: (line) => {
            if (core.logging.shouldLogVerbose()) {
              logger.debug?.(`[${account.accountId}] << ${line}`);
            }
          },
          onNotice: (text, target) => {
            if (core.logging.shouldLogVerbose()) {
              logger.debug?.(`[${account.accountId}] notice ${target ?? ""}: ${text}`);
            }
          },
          onError: (error) => {
            logger.error(`[${account.accountId}] IRC error: ${error.message}`);
          },
          onDisconnect: () => {
            if (stopped || monitorAbort.signal.aborted) {
              return;
            }
            client = null;
            publishDisconnectedStatus("IRC connection closed");
            logger.warn?.(
              `[${account.accountId}] IRC connection closed; reconnecting in ${IRC_MONITOR_RECONNECT_DELAY_MS}ms`,
            );
            scheduleReconnect();
          },
          onPrivmsg: async (event) => {
            if (!client) {
              return;
            }
            if (
              normalizeLowercaseStringOrEmpty(event.senderNick) ===
              normalizeLowercaseStringOrEmpty(client.nick)
            ) {
              return;
            }

            const inboundTarget = resolveIrcInboundTarget({
              target: event.target,
              senderNick: event.senderNick,
            });
            const message: IrcInboundMessage = {
              messageId: makeIrcMessageId(),
              target: inboundTarget.target,
              rawTarget: inboundTarget.rawTarget,
              senderNick: event.senderNick,
              senderUser: event.senderUser,
              senderHost: event.senderHost,
              text: event.text,
              timestamp: Date.now(),
              isGroup: inboundTarget.isGroup,
            };

            core.channel.activity.record({
              channel: "irc",
              accountId: account.accountId,
              direction: "inbound",
              at: message.timestamp,
            });

            if (opts.onMessage) {
              await opts.onMessage(message, client);
              return;
            }

            await handleIrcInbound({
              message,
              account,
              config: cfg,
              runtime,
              connectedNick: client.nick,
              sendReply: async (target, text) => {
                client?.sendPrivmsg(target, text);
                opts.statusSink?.({ lastOutboundAt: Date.now() });
                core.channel.activity.record({
                  channel: "irc",
                  accountId: account.accountId,
                  direction: "outbound",
                });
              },
              statusSink: opts.statusSink,
            });
          },
        }),
      );
    } catch (error) {
      if (!stopped && !monitorAbort.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        publishDisconnectedStatus(message);
      }
      throw error;
    }
    if (stopped || monitorAbort.signal.aborted) {
      nextClient.quit("shutdown");
      return;
    }
    client = nextClient;
    publishConnectedStatus();

    logger.info(
      `[${account.accountId}] connected to ${account.host}:${account.port}${account.tls ? " (tls)" : ""} as ${nextClient.nick}`,
    );
  }

  await connect();

  return {
    stop: () => {
      stopped = true;
      removeAbortListener?.();
      removeAbortListener = null;
      if (!monitorAbort.signal.aborted) {
        monitorAbort.abort();
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      opts.statusSink?.({ running: false, connected: false, lastStopAt: Date.now() });
      client?.quit("shutdown");
      client = null;
    },
  };
}
