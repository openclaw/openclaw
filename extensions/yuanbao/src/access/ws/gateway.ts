/**
 * WebSocket gateway adapter
 *
 * Integrates YuanbaoWsClient with the OpenClaw channel gateway lifecycle.
 * Responsibilities:
 *   - Build connection params from account config (obtain auth token via sign-token API)
 *   - Bind abortSignal for graceful shutdown
 *   - Report connection status via statusSink
 *   - Convert incoming push events into YuanbaoInboundMessage and feed them into the message pipeline
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { buildSyncCommandsPayload } from "../../business/commands/slash-commands/index.js";
import { handleInboundMessage } from "../../business/inbound/index.js";
import { resolveTraceContext } from "../../business/trace/context.js";
import { createLog } from "../../logger.js";
import type {
  ResolvedYuanbaoAccount,
  YuanbaoInboundMessage,
  YuanbaoMsgBodyElement,
} from "../../types.js";
import { getSignToken, forceRefreshSignToken } from "../api.js";
import { decodeInboundMessage } from "./biz-codec.js";
import { YuanbaoWsClient } from "./client.js";
import { setActiveWsClient } from "./runtime.js";
import type { WsClientState, WsAuthBindResult, WsPushEvent } from "./types.js";

type GatewayLog = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

type GatewayStatusPatch = Record<string, unknown>;

export type StartWsGatewayParams = {
  account: ResolvedYuanbaoAccount;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  log?: GatewayLog;
  /** PluginRuntime instance for connecting to the OpenClaw message pipeline */
  runtime?: PluginRuntime;
  statusSink?: (patch: GatewayStatusPatch) => void;
};

/**
 * Start the WebSocket gateway.
 *
 * Flow: sign token → establish WS connection → authenticate.
 * Returns a Promise that stays pending until abortSignal fires.
 */
export async function startYuanbaoWsGateway(params: StartWsGatewayParams): Promise<void> {
  const { account, config, abortSignal, log, runtime, statusSink } = params;
  const gwlog = createLog("ws", log);

  // Build auth info (requires async token signing)
  const auth = await resolveWsAuth(account, log);

  const client = new YuanbaoWsClient({
    connection: {
      gatewayUrl: account.wsGatewayUrl,
      auth,
    },
    config: {
      maxReconnectAttempts: account.wsMaxReconnectAttempts,
    },
    callbacks: {
      onReady: (data: WsAuthBindResult) => {
        gwlog.info(`[${account.accountId}] WS ready: connectId=${data.connectId} ✅`);
        statusSink?.({
          running: true,
          connected: true,
          wsConnectId: data.connectId,
          lastConnectedAt: Date.now(),
        });

        // Sync command list to the backend after connection is established
        syncCommandsToServer(client, account.accountId, config).catch((err) => {
          gwlog.warn(`[${account.accountId}] failed to sync command list (non-blocking)`, {
            error: String(err),
          });
        });
      },
      onDispatch: (pushEvent: WsPushEvent) => {
        gwlog.debug(`[${account.accountId}] WS push: cmd=${pushEvent.cmd}, type=${pushEvent.type}`);
        handleWsDispatchEvent({
          account,
          config,
          pushEvent,
          log,
          runtime,
          client,
          statusSink,
          abortSignal,
        });
      },
      onStateChange: (state: WsClientState) => {
        gwlog.info(`[${account.accountId}] WS state: ${state}`);
        statusSink?.({
          wsState: state,
          connected: state === "connected",
          running: state !== "disconnected",
        });
      },
      onError: (error: Error) => {
        gwlog.error(`[${account.accountId}] WS error: ${error.message}`);
        statusSink?.({ lastError: error.message });
      },
      onClose: (code, reason) => {
        gwlog.info(`[${account.accountId}] WS closed: code=${code}, reason=${reason}`);
      },
      onKickout: (data) => {
        gwlog.warn(
          `[${account.accountId}] kicked out: status=${data.status}, reason=${data.reason}`,
        );
        statusSink?.({ kickedOut: true, kickReason: data.reason });
      },
      onAuthFailed: async (code: number) => {
        gwlog.warn(`[${account.accountId}] onAuthFailed callback (code=${code}), refreshing token`);
        const tokenData = await forceRefreshSignToken(account, log);
        const uid = tokenData.bot_id || account.botId || "";
        if (tokenData.bot_id) {
          account.botId = tokenData.bot_id;
        }
        return {
          bizId: "ybBot",
          uid,
          source: tokenData.source || "bot",
          token: tokenData.token,
          routeEnv: account.config?.routeEnv,
        };
      },
    },
    log: {
      info: (msg) => log?.info?.(msg),
      warn: (msg) => log?.warn?.(msg),
      error: (msg) => log?.error?.(msg),
      debug: (msg) => log?.debug?.(msg),
    },
  });

  // Start the connection
  client.connect();

  // Store client reference for multi-account use (used by outbound.sendText)
  setActiveWsClient(account.accountId, client);

  // Return a Promise that resolves when abortSignal fires.
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      gwlog.info(`[${account.accountId}] received stop signal, disconnecting WebSocket`);
      setActiveWsClient(account.accountId, null);
      client.disconnect();
      statusSink?.({
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
      resolve();
    };

    if (abortSignal.aborted) {
      onAbort();
      return;
    }
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build WS auth info from account config (obtained via sign-token API, cached by duration).
 */
async function resolveWsAuth(account: ResolvedYuanbaoAccount, log?: GatewayLog) {
  const mlog = createLog("ws", log);
  mlog.info(`[${account.accountId}] resolveWsAuth params:`, {
    botId: account.botId,
    token: account.token,
  });
  // If a pre-signed static token is available, use it directly
  if (account.token) {
    const uid = account.botId || "";
    mlog.info(`[${account.accountId}] using pre-configured static token`, {
      uid,
      botId: account.botId,
      token: account.token,
    });
    return {
      bizId: "ybBot",
      uid,
      source: "bot",
      token: account.token,
      routeEnv: account.config?.routeEnv,
    };
  }
  const tokenData = await getSignToken(account, log);
  const uid = tokenData.bot_id || account.botId || "";

  if (tokenData.bot_id) {
    account.botId = tokenData.bot_id;
  }

  mlog.info(
    `[${account.accountId}] ✍️ sign-token done uid=${uid} (bot_id=${tokenData.bot_id}, botId=${account.botId})`,
  );

  return {
    bizId: "ybBot",
    uid,
    source: tokenData.source || "bot",
    token: tokenData.token,
    routeEnv: account.config?.routeEnv,
  };
}

/**
 * Parse push content into Tencent IM MsgBody format.
 */
function parsePushContentToMsgBody(content: unknown): YuanbaoMsgBodyElement[] | undefined {
  if (typeof content === "string" && content.trim()) {
    // Try JSON parse (push content may be a JSON string)
    try {
      const parsed = JSON.parse(content);
      if (parsed?.msg_body && Array.isArray(parsed.msg_body)) {
        return parsed.msg_body;
      }
      // If it's another JSON format, try to extract the text field
      if (parsed?.text) {
        return [{ msg_type: "TIMTextElem", msg_content: { text: parsed.text } }];
      }
    } catch {
      // Not JSON — treat as plain text
    }
    return [{ msg_type: "TIMTextElem", msg_content: { text: content } }];
  }
  return undefined;
}

type InboundResult = { msg: YuanbaoInboundMessage; chatType: "c2c" | "group" };

/** Infer chat type from message fields */
function inferChatType(msg: Record<string, unknown>): "c2c" | "group" {
  if (msg.group_code) {
    return "group";
  }
  const cmd = msg.callback_command as string | undefined;
  if (cmd === "Group.CallbackAfterRecallMsg" || cmd === "Group.CallbackAfterSendMsg") {
    return "group";
  }
  return "c2c";
}

/** Check whether the message has at least one valid business field */
function hasValidMsgFields(msg: Record<string, unknown>): boolean {
  return Boolean(msg.callback_command || msg.from_account || msg.msg_body);
}

/** Try protobuf decode on rawData; returns null on failure */
function decodeFromProtobuf(rawData: Uint8Array, pushType: string): InboundResult | null {
  const decoded = decodeInboundMessage(rawData);
  if (!decoded || !hasValidMsgFields(decoded as Record<string, unknown>)) {
    return null;
  }
  createLog("ws").debug(`[${pushType}] WS push event decoded`, { ...decoded });
  return { msg: decoded, chatType: inferChatType(decoded as Record<string, unknown>) };
}

/** Fallback: try to decode rawData as JSON text when protobuf fails */
function decodeFromRawDataJson(rawData: Uint8Array, pushType: string): InboundResult | null {
  try {
    const rawJson = JSON.parse(new TextDecoder().decode(rawData));
    if (!rawJson || !hasValidMsgFields(rawJson)) {
      return null;
    }
    const msg = rawJson as YuanbaoInboundMessage;
    // Back-fill trace_id from log_ext
    if (!msg.trace_id) {
      msg.trace_id = rawJson.log_ext?.trace_id;
    }
    createLog("ws").info(`[${pushType}] WS push event decoded`, { ...msg });
    return { msg, chatType: inferChatType(msg as Record<string, unknown>) };
  } catch {
    return null;
  }
}

/** Decode message body from the DirectedPush content field */
function decodeFromContent(pushEvent: WsPushEvent): InboundResult | null {
  const msgBody = parsePushContentToMsgBody(pushEvent.content);
  if (!msgBody) {
    return null;
  }

  let parsedContent: Record<string, unknown> = {};
  try {
    parsedContent = JSON.parse(pushEvent.content as string);
  } catch {
    /* Plain text content — JSON parse failure is expected */
  }

  const logExt = parsedContent.log_ext as { trace_id?: string } | undefined;
  const chatType = parsedContent.group_code ? "group" : "c2c";
  return {
    msg: {
      callback_command:
        chatType === "group" ? "Group.CallbackAfterSendMsg" : "C2C.CallbackAfterSendMsg",
      from_account: parsedContent.from_account as string | undefined,
      group_code: parsedContent.group_code as string | undefined,
      msg_body: msgBody,
      msg_key: parsedContent.msg_key as string | undefined,
      msg_seq: parsedContent.msg_seq as number | undefined,
      msg_time: parsedContent.msg_time as number | undefined,
      trace_id: logExt?.trace_id ?? (parsedContent.trace_id as string | undefined),
      seq_id: parsedContent.seq_id as string | undefined,
    },
    chatType,
  };
}

/**
 * Convert a WS push event into YuanbaoInboundMessage + chatType.
 * Returns null if the push does not need to enter the message pipeline.
 *
 * Decode priority: rawData protobuf → rawData JSON fallback → DirectedPush content
 */
export function wsPushToInboundMessage(
  pushEvent: WsPushEvent,
  log?: GatewayLog,
): InboundResult | null {
  const wsLog = createLog("ws", log);

  // First try decoding full ConnMsg.data directly (backend may omit the PushMsg wrapper)
  if (pushEvent.connData && pushEvent.connData.length > 0) {
    wsLog.debug(
      `[${pushEvent.type}] WS push decode via connData (connData.length=${pushEvent.connData.length})`,
    );
    const pushType = String(pushEvent.type ?? "");
    const result = decodeFromProtobuf(pushEvent.connData, pushType);
    if (result) {
      return result;
    }
  }

  // connData decode failed — fallback to rawData (PushMsg.data)
  if (pushEvent.rawData && pushEvent.rawData.length > 0) {
    const pushType = String(pushEvent.type ?? "rawData");
    wsLog.debug(`[${pushType}] WS push decode via rawData`);
    const result =
      decodeFromProtobuf(pushEvent.rawData, pushType) ??
      decodeFromRawDataJson(pushEvent.rawData, pushType);
    if (result) {
      return result;
    }
    wsLog.warn(`[${pushType}] WS push decode failed`);
  }

  if (pushEvent.content) {
    wsLog.debug(`[${pushEvent.type || "content"}] WS push decode via content`, {
      content: pushEvent.content,
    });
    return decodeFromContent(pushEvent);
  }

  return null;
}

/**
 * Handle a push event received from WebSocket.
 * Converts the event into a YuanbaoInboundMessage and feeds it into the OpenClaw message pipeline.
 */
function handleWsDispatchEvent(params: {
  account: ResolvedYuanbaoAccount;
  config: OpenClawConfig;
  pushEvent: WsPushEvent;
  log?: GatewayLog;
  runtime?: PluginRuntime;
  client: YuanbaoWsClient;
  statusSink?: (patch: GatewayStatusPatch) => void;
  abortSignal: AbortSignal;
}): void {
  const {
    account,
    config,
    pushEvent,
    log: gwLog,
    runtime,
    client,
    statusSink,
    abortSignal,
  } = params;
  const dlog = createLog("ws", gwLog);

  dlog.debug(
    `[${account.accountId}][dispatch] cmd=${pushEvent.cmd}, module=${pushEvent.module}, msgId=${pushEvent.msgId}`,
  );

  const converted = wsPushToInboundMessage(pushEvent, gwLog);
  if (!converted) {
    dlog.debug(
      `[${account.accountId}][dispatch] cmd=${pushEvent.cmd} (non-message event, skipping)`,
    );
    return;
  }

  const { msg, chatType } = converted;

  // Resolve / generate trace context
  const traceContext = resolveTraceContext({
    traceId: msg.trace_id,
    seqId: msg.seq_id ?? msg.msg_seq,
  });
  msg.trace_id = traceContext.traceId;
  msg.seq_id = traceContext.seqId;

  const isGroup = chatType === "group";

  dlog.debug("[msg-trace] dispatch resolved", {
    traceId: traceContext.traceId,
    seqId: traceContext.seqId ?? "(none)",
    traceparent: traceContext.traceparent,
    account: account.accountId,
  });
  dlog.info(`[${account.accountId}][dispatch] received ${isGroup ? "group" : "direct"} message`);

  // Report inbound status
  if (statusSink) {
    statusSink({ lastInboundAt: Date.now() });
  }

  // Feed into the message pipeline
  if (!runtime) {
    dlog.warn(
      `[${account.accountId}][dispatch] PluginRuntime not provided, cannot process message`,
    );
    return;
  }

  handleInboundMessage({
    msg,
    isGroup,
    account,
    config,
    core: runtime,
    wsClient: client,
    log: {
      info: (m: string) => gwLog?.info?.(m),
      warn: (m: string) => gwLog?.warn?.(m),
      error: (m: string) => gwLog?.error?.(m),
      verbose: (m: string) => gwLog?.debug?.(m),
    },
    statusSink: statusSink as Parameters<typeof handleInboundMessage>[0]["statusSink"],
    abortSignal,
  }).catch((err) => {
    dlog.error(
      `[${account.accountId}][dispatch] WS ${isGroup ? "group " : ""} message handler failed: ${String(err)}`,
    );
  });
}

/**
 * Sync the command list to the backend after connection is established.
 *
 * - bot_commands: dynamically obtained from the OpenClaw framework via listChatCommandsForConfig
 * - plugin_commands: commands collected during plugin registration
 * Sync failure does not affect normal operation — only a warning is logged.
 */
async function syncCommandsToServer(
  client: YuanbaoWsClient,
  accountId: string,
  config?: OpenClawConfig,
): Promise<void> {
  const slog = createLog("ws");
  const payload = await buildSyncCommandsPayload(config);
  slog.info(`[${accountId}] syncing command list, request payload:`, {
    sync_type: payload.syncType,
    bot_version: payload.botVersion,
    plugin_version: payload.pluginVersion,
    command_data: {
      bot_commands: payload.commandData.botCommands,
      plugin_commands: payload.commandData.pluginCommands,
    },
  });

  const rsp = await client.syncInformation(payload);

  slog.info(`[${accountId}] SyncInformationRsp:`, { code: rsp.code, msg: rsp.msg });

  if (rsp.code !== 0) {
    slog.warn(`[${accountId}] sync command list returned non-zero code: code=${rsp.code}, msg=${rsp.msg}`);
  } else {
    slog.info(`[${accountId}] sync command list succeeded`);
  }
}
