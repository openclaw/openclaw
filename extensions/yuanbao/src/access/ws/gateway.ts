/**
 * WebSocket 网关适配器
 *
 * 将 YuanbaoWsClient 与 OpenClaw channel gateway 生命周期集成。
 * Responsible for:
 *   - 根据账号配置构建连接参数（通过 sign-token 接口获取鉴权 token）
 *   - 绑定 abortSignal 实现优雅关闭
 *   - 通过 statusSink 上报连接状态
 *   - 将收到的推送事件转换为 YuanbaoInboundMessage 并注入消息处理管线
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
  /** PluginRuntime 实例，用于接入 OpenClaw 消息管线 */
  runtime?: PluginRuntime;
  statusSink?: (patch: GatewayStatusPatch) => void;
};

/**
 * 启动 WebSocket 网关
 *
 * 流程：签票获取 token → 建立 WS 连接 → 鉴权
 * 返回一个 Promise，在 abortSignal 触发前保持挂起。
 *
 * @param params - Gateway startup参数，包含账号配置、abort 信号、日志和状态上报等
 * @returns 在 abortSignal 触发时 resolve 的 Promise
 */
export async function startYuanbaoWsGateway(params: StartWsGatewayParams): Promise<void> {
  const { account, config, abortSignal, log, runtime, statusSink } = params;
  const gwlog = createLog("ws", log);

  // 构建鉴权信息（需要异步签票）
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

        // 建联成功后同步命令列表到后台
        syncCommandsToServer(client, account.accountId, config).catch((err) => {
          gwlog.warn(`[${account.accountId}] 同步命令列表失败（不影响正常功能）`, {
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

  // 启动连接
  client.connect();

  // 保存到多账号引用（供 outbound.sendText 使用）
  setActiveWsClient(account.accountId, client);

  // 返回 Promise，在 abortSignal 触发时断开连接并 resolve。
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

// ============ 内部辅助 ============

/**
 * 根据账号配置构建 WS 鉴权信息（通过 sign-token 接口获取，基于 duration 字段缓存）。
 */
async function resolveWsAuth(account: ResolvedYuanbaoAccount, log?: GatewayLog) {
  const mlog = createLog("ws", log);
  mlog.info(`[${account.accountId}] resolveWsAuth params:`, {
    botId: account.botId,
    token: account.token,
  });
  // 如果已有预签的静态 token，直接使用
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
 * 将推送内容解析为腾讯 IM MsgBody 格式。
 */
function parsePushContentToMsgBody(content: unknown): YuanbaoMsgBodyElement[] | undefined {
  if (typeof content === "string" && content.trim()) {
    // 尝试 JSON 解析（推送内容可能是 JSON 字符串）
    try {
      const parsed = JSON.parse(content);
      if (parsed?.msg_body && Array.isArray(parsed.msg_body)) {
        return parsed.msg_body;
      }
      // 如果是其他 JSON 格式，尝试Extract text 字段
      if (parsed?.text) {
        return [{ msg_type: "TIMTextElem", msg_content: { text: parsed.text } }];
      }
    } catch {
      // 非 JSON，当作纯文本
    }
    return [{ msg_type: "TIMTextElem", msg_content: { text: content } }];
  }
  return undefined;
}

type InboundResult = { msg: YuanbaoInboundMessage; chatType: "c2c" | "group" };

/** 根据消息字段推断聊天类型 */
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

/** 检查消息是否含有至少一个有效的业务字段 */
function hasValidMsgFields(msg: Record<string, unknown>): boolean {
  return Boolean(msg.callback_command || msg.from_account || msg.msg_body);
}

/** 尝试用 protobuf 解码 rawData，失败返回 null */
function decodeFromProtobuf(rawData: Uint8Array, pushType: string): InboundResult | null {
  const decoded = decodeInboundMessage(rawData);
  if (!decoded || !hasValidMsgFields(decoded as Record<string, unknown>)) {
    return null;
  }
  createLog("ws").debug(`[${pushType}] WS 推送事件解析`, { ...decoded });
  return { msg: decoded, chatType: inferChatType(decoded as Record<string, unknown>) };
}

/** protobuf 解码失败后，尝试将 rawData 当 JSON 文本解码 */
function decodeFromRawDataJson(rawData: Uint8Array, pushType: string): InboundResult | null {
  try {
    const rawJson = JSON.parse(new TextDecoder().decode(rawData));
    if (!rawJson || !hasValidMsgFields(rawJson)) {
      return null;
    }
    const msg = rawJson as YuanbaoInboundMessage;
    // 从 log_ext 中回填 trace_id
    if (!msg.trace_id) {
      msg.trace_id = rawJson.log_ext?.trace_id;
    }
    createLog("ws").info(`[${pushType}] WS 推送事件解析`, { ...msg });
    return { msg, chatType: inferChatType(msg as Record<string, unknown>) };
  } catch {
    return null;
  }
}

/** 从 DirectedPush content 字段解析Message body */
function decodeFromContent(pushEvent: WsPushEvent): InboundResult | null {
  const msgBody = parsePushContentToMsgBody(pushEvent.content);
  if (!msgBody) {
    return null;
  }

  let parsedContent: Record<string, unknown> = {};
  try {
    parsedContent = JSON.parse(pushEvent.content as string);
  } catch {
    /* 纯文本内容，JSON 解析失败是预期行为 */
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
 * 将 WS 推送事件转换为 YuanbaoInboundMessage + chatType。
 * 返回 null 表示该推送不需要进入消息处理管线。
 *
 * 解码Priority:rawData protobuf → rawData JSON 回退 → DirectedPush content
 *
 * @param pushEvent - WebSocket 推送事件
 * @param log - 可选日志对象
 * @returns 包含解码后消息和聊天类型的对象，或 null
 */
export function wsPushToInboundMessage(
  pushEvent: WsPushEvent,
  log?: GatewayLog,
): InboundResult | null {
  const wsLog = createLog("ws", log);

  // 先尝试用完整的 ConnMsg.data 直接解码（后台可能没有 PushMsg 外层）
  if (pushEvent.connData && pushEvent.connData.length > 0) {
    wsLog.debug(
      `[${pushEvent.type}] WS 推送事件解析 type=connData (connData.length=${pushEvent.connData.length})`,
    );
    const pushType = String(pushEvent.type ?? "");
    const result = decodeFromProtobuf(pushEvent.connData, pushType);
    if (result) {
      return result;
    }
  }

  // connData 解码失败，兜底用 rawData（PushMsg.data）解码
  if (pushEvent.rawData && pushEvent.rawData.length > 0) {
    const pushType = String(pushEvent.type ?? "rawData");
    wsLog.debug(`[${pushType}] WS 推送事件解析`);
    const result =
      decodeFromProtobuf(pushEvent.rawData, pushType) ??
      decodeFromRawDataJson(pushEvent.rawData, pushType);
    if (result) {
      return result;
    }
    wsLog.warn(`[${pushType}] WS 推送事件解析失败`);
  }

  if (pushEvent.content) {
    wsLog.debug(`[${pushEvent.type || "content"}] WS 推送事件解析, type=content`, {
      content: pushEvent.content,
    });
    return decodeFromContent(pushEvent);
  }

  return null;
}

/**
 * 处理从 WebSocket 收到的推送事件。
 * 将事件转换为 YuanbaoInboundMessage 并注入 OpenClaw 消息处理管线。
 *
 * @param params - 包含账号、配置、推送事件、日志、Runtime等上下文
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

  // 解析/生成 trace 上下文
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

  // 上报入站状态
  if (statusSink) {
    statusSink({ lastInboundAt: Date.now() });
  }

  // 接入消息处理管线
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

// ============ 命令列表同步 ============

/**
 * 建联成功后同步命令列表到后台
 *
 * - bot_commands: 通过 listChatCommandsForConfig 从 OpenClaw 框架动态获取
 * - plugin_commands: 从插件注册阶段动态收集的命令列表
 * 同步失败不影响正常功能，仅打印警告日志。
 *
 * @param client - 当前活跃的 WebSocket 客户端
 * @param accountId - 账号标识（用于日志）
 * @param config - OpenClaw 配置
 */
async function syncCommandsToServer(
  client: YuanbaoWsClient,
  accountId: string,
  config?: OpenClawConfig,
): Promise<void> {
  const slog = createLog("ws");
  const payload = await buildSyncCommandsPayload(config);
  // 按 SyncInformationReq proto 结构打印完整请求内容
  slog.info(`[${accountId}] 同步命令列表 请求内容:`, {
    sync_type: payload.syncType,
    bot_version: payload.botVersion,
    plugin_version: payload.pluginVersion,
    command_data: {
      bot_commands: payload.commandData.botCommands,
      plugin_commands: payload.commandData.pluginCommands,
    },
  });

  const rsp = await client.syncInformation(payload);

  slog.info(`[${accountId}] SyncInformationRsp 响应内容:`, { code: rsp.code, msg: rsp.msg });

  if (rsp.code !== 0) {
    slog.warn(`[${accountId}] 同步命令列表返回非零码: code=${rsp.code}, msg=${rsp.msg}`);
  } else {
    slog.info(`[${accountId}] 同步命令列表成功`);
  }
}
