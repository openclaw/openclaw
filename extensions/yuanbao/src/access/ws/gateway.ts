import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
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
  runtime?: PluginRuntime;
  statusSink?: (patch: GatewayStatusPatch) => void;
};

export async function startYuanbaoWsGateway(params: StartWsGatewayParams): Promise<void> {
  const { account, config, abortSignal, log, runtime, statusSink } = params;
  const gwlog = createLog("ws", log);

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

  client.connect();

  setActiveWsClient(account.accountId, client);

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

async function resolveWsAuth(account: ResolvedYuanbaoAccount, log?: GatewayLog) {
  if (account.token) {
    return {
      bizId: "ybBot",
      uid: account.botId || "",
      source: "bot",
      token: account.token,
      routeEnv: account.config?.routeEnv,
    };
  }
  const tokenData = await getSignToken(account, log);
  if (tokenData.bot_id) {
    account.botId = tokenData.bot_id;
  }
  return {
    bizId: "ybBot",
    uid: tokenData.bot_id || account.botId || "",
    source: tokenData.source || "bot",
    token: tokenData.token,
    routeEnv: account.config?.routeEnv,
  };
}

function parsePushContentToMsgBody(content: unknown): YuanbaoMsgBodyElement[] | undefined {
  if (typeof content !== "string" || !content.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed?.msg_body && Array.isArray(parsed.msg_body)) {
      return parsed.msg_body;
    }
    if (parsed?.text) {
      return [{ msg_type: "TIMTextElem", msg_content: { text: parsed.text } }];
    }
  } catch {
    /* not JSON */
  }
  return [{ msg_type: "TIMTextElem", msg_content: { text: content } }];
}

type InboundResult = { msg: YuanbaoInboundMessage; chatType: "c2c" | "group" };

function inferChatType(msg: Record<string, unknown>): "c2c" | "group" {
  if (msg.group_code) {
    return "group";
  }
  const cmd = msg.callback_command as string | undefined;
  return cmd === "Group.CallbackAfterRecallMsg" || cmd === "Group.CallbackAfterSendMsg"
    ? "group"
    : "c2c";
}

function hasValidMsgFields(msg: Record<string, unknown>): boolean {
  return Boolean(msg.callback_command || msg.from_account || msg.msg_body);
}

function decodeFromProtobuf(rawData: Uint8Array, _pushType: string): InboundResult | null {
  const decoded = decodeInboundMessage(rawData);
  if (!decoded || !hasValidMsgFields(decoded as Record<string, unknown>)) {
    return null;
  }
  return { msg: decoded, chatType: inferChatType(decoded as Record<string, unknown>) };
}

function decodeFromRawDataJson(rawData: Uint8Array, _pushType: string): InboundResult | null {
  try {
    const rawJson = JSON.parse(new TextDecoder().decode(rawData));
    if (!rawJson || !hasValidMsgFields(rawJson)) {
      return null;
    }
    const msg = rawJson as YuanbaoInboundMessage;
    if (!msg.trace_id) {
      msg.trace_id = rawJson.log_ext?.trace_id;
    }
    return { msg, chatType: inferChatType(msg as Record<string, unknown>) };
  } catch {
    return null;
  }
}

function decodeFromContent(pushEvent: WsPushEvent): InboundResult | null {
  const msgBody = parsePushContentToMsgBody(pushEvent.content);
  if (!msgBody) {
    return null;
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(pushEvent.content as string);
  } catch {
    /* plain text */
  }
  const logExt = parsed.log_ext as { trace_id?: string } | undefined;
  const chatType = parsed.group_code ? "group" : "c2c";
  return {
    msg: {
      callback_command:
        chatType === "group" ? "Group.CallbackAfterSendMsg" : "C2C.CallbackAfterSendMsg",
      from_account: parsed.from_account as string | undefined,
      group_code: parsed.group_code as string | undefined,
      msg_body: msgBody,
      msg_key: parsed.msg_key as string | undefined,
      msg_seq: parsed.msg_seq as number | undefined,
      msg_time: parsed.msg_time as number | undefined,
      trace_id: logExt?.trace_id ?? (parsed.trace_id as string | undefined),
      seq_id: parsed.seq_id as string | undefined,
    },
    chatType,
  };
}

export function wsPushToInboundMessage(
  pushEvent: WsPushEvent,
  _log?: GatewayLog,
): InboundResult | null {
  const pushType = String(pushEvent.type ?? "");
  if (pushEvent.connData && pushEvent.connData.length > 0) {
    const result = decodeFromProtobuf(pushEvent.connData, pushType);
    if (result) {
      return result;
    }
  }
  if (pushEvent.rawData && pushEvent.rawData.length > 0) {
    const result =
      decodeFromProtobuf(pushEvent.rawData, pushType) ??
      decodeFromRawDataJson(pushEvent.rawData, pushType);
    if (result) {
      return result;
    }
  }
  if (pushEvent.content) {
    return decodeFromContent(pushEvent);
  }
  return null;
}

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
  const converted = wsPushToInboundMessage(pushEvent, gwLog);
  if (!converted) {
    return;
  }
  const { msg, chatType } = converted;
  const traceContext = resolveTraceContext({
    traceId: msg.trace_id,
    seqId: msg.seq_id ?? msg.msg_seq,
  });
  msg.trace_id = traceContext.traceId;
  msg.seq_id = traceContext.seqId;
  const isGroup = chatType === "group";
  statusSink?.({ lastInboundAt: Date.now() });
  if (!runtime) {
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
    createLog("ws", gwLog).error(`[${account.accountId}][dispatch] handler failed: ${String(err)}`);
  });
}
