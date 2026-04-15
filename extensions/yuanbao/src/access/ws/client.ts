/**
 * WebSocket 客户端
 *
 * 基于元宝长连接 ConnMsg protobuf 协议实现连接管理、鉴权、心跳、自动重连。
 * 参考 chatbot-web 的 chat-web-socket.ts 适配 Node.js 服务端场景。
 */

import { v4 as uuidv4 } from "uuid";
import WebSocket from "ws";
import { msgBodyDesensitization } from "../../business/utils/utils.js";
import { getPluginVersion, getOpenclawVersion, getOperationSystem } from "../../infra/env.js";
import { createLog } from "../../logger.js";
import type { LogSink, ModuleLog } from "../../logger.js";
import {
  encodeSendC2CMessageReq,
  encodeSendGroupMessageReq,
  decodeSendMessageRsp,
  encodeSendPrivateHeartbeatReq,
  encodeSendGroupHeartbeatReq,
  decodeSendPrivateHeartbeatRsp,
  decodeSendGroupHeartbeatRsp,
  encodeQueryGroupInfoReq,
  decodeQueryGroupInfoRsp,
  encodeGetGroupMemberListReq,
  decodeGetGroupMemberListRsp,
} from "./biz-codec.js";
import {
  decodeConnMsg,
  decodePB,
  buildAuthBindMsg,
  buildPingMsg,
  buildPushAck,
  buildBusinessConnMsg,
  PB_MSG_TYPES,
  CMD_TYPE,
  CMD,
} from "./conn-codec.js";
import type { PBConnMsg } from "./conn-codec.js";
import type {
  WsClientCallbacks,
  WsClientConfig,
  WsClientState,
  WsConnectionConfig,
  WsSendMessageResponse,
  WsSendC2CMessageData,
  WsSendGroupMessageData,
  WsSendPrivateHeartbeatData,
  WsSendGroupHeartbeatData,
  WsHeartbeatResponse,
  WsQueryGroupInfoData,
  WsQueryGroupInfoResponse,
  WsGetGroupMemberListData,
  WsGetGroupMemberListResponse,
  WsPushEvent,
} from "./types.js";

// ============ Default值 ============

const DEFAULT_RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** 收到这些 close code 时不触发自动重连 */
const NO_RECONNECT_CLOSE_CODES = new Set([
  4012, // 版本封禁
  4013, // 用户封禁
  4014, // 同用户连接冲突
  4018, // 账号封禁
  4019, // 账号被删除
  4021, // 设备删除
]);
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 100;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_S = 5;

/** 收到这些鉴权错误码时需要重新签票后重连 */
const AUTH_FAILED_CODES = new Set([41103, 41104, 41108]);

/** 已经鉴权通过，视为鉴权成功 */
const AUTH_ALREADY_CODE = 41101;

/** 服务端临时性错误，可直接重连（无需刷新 token） */
const AUTH_RETRYABLE_CODES = new Set([
  50400, // 服务程序错误
  50503, // 系统过载保护
  90001, // 下游网络错误
  90003, // 下游依赖处理失败
]);

/** 连续心跳超时达到此次数后才触发重连 */
const HEARTBEAT_TIMEOUT_THRESHOLD = 2;

// ============ 辅助 ============

function generateMsgId(): string {
  return uuidv4().replace(/-/g, "");
}

// ============ 业务命令字 ============

/** 出站业务命令字 */
export const BIZ_CMD = {
  /** 发送 C2C 消息 */
  SendC2CMessage: "send_c2c_message",
  /** 发送群消息 */
  SendGroupMessage: "send_group_message",
  /** Query group info */
  QueryGroupInfo: "query_group_info",
  /** Get group member list */
  GetGroupMemberList: "get_group_member_list",
  /** 私聊回复状态心跳 */
  SendPrivateHeartbeat: "send_private_heartbeat",
  /** 群聊回复状态心跳 */
  SendGroupHeartbeat: "send_group_heartbeat",
} as const;

const BIZ_MODULE = "yuanbao_openclaw_proxy";

// ============ 客户端类 ============

/**
 * 元宝 WebSocket 客户端
 *
 * 基于 ConnMsg protobuf 协议实现连接管理、鉴权、心跳和自动重连。
 * 提供发送/接收消息、请求-响应匹配等核心能力。
 */
export class YuanbaoWsClient {
  // ---- 配置 ----
  private connectionConfig: WsConnectionConfig;
  private readonly clientConfig: Required<WsClientConfig>;
  private readonly callbacks: WsClientCallbacks;
  private readonly log: ModuleLog;

  // ---- 连接状态 ----
  private ws: WebSocket | null = null;
  private state: WsClientState = "disconnected";
  private connectId: string | null = null;

  // ---- 心跳 ----
  private heartbeatIntervalS: number = DEFAULT_HEARTBEAT_INTERVAL_S;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAckReceived = true;
  private lastHeartbeatAt = 0;
  /** 连续心跳超时次数，达到阈值后才触发重连，避免单次波动导致频繁重连 */
  private heartbeatTimeoutCount = 0;

  // ---- 重连 ----
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- 生命周期 ----
  private abortController: AbortController | null = null;
  private disposed = false;

  // ---- 请求/响应匹配（via msgId） ----
  private pendingRequests = new Map<
    string,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WS 响应动态类型
      resolve: (resp: any) => void;
      timer: ReturnType<typeof setTimeout>;
      /** 自定义解码器，为空时使用Default的 decodeSendMessageRsp */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 解码器返回动态类型
      decoder?: (data: Uint8Array | ArrayBuffer, msgId: string) => any;
    }
  >();

  constructor(params: {
    connection: WsConnectionConfig;
    config?: WsClientConfig;
    callbacks?: WsClientCallbacks;
    log?: LogSink;
  }) {
    this.log = createLog("ws", params.log);
    this.log.info("initializing WebSocket client", {
      connection: params.connection as unknown as Record<string, unknown>,
      config: params.config as unknown as Record<string, unknown>,
    });
    this.connectionConfig = params.connection;
    this.clientConfig = {
      maxReconnectAttempts: params.config?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      reconnectDelays: params.config?.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS,
    };
    this.callbacks = params.callbacks ?? {};
  }

  // ============ 公共接口 ============

  /**
   * 更新鉴权信息（用于 token 刷新后重连）
   */
  updateAuth(auth: WsConnectionConfig["auth"]): void {
    this.connectionConfig = {
      ...this.connectionConfig,
      auth,
    };
  }

  connect(): void {
    if (this.disposed) {
      throw new Error("Client has been disposed");
    }
    this.abortController = new AbortController();
    this.doConnect();
  }

  disconnect(): void {
    this.disposed = true;
    this.cleanup();
  }

  getState(): WsClientState {
    return this.state;
  }

  getConnectId(): string | null {
    return this.connectId;
  }

  /**
   * Send raw binary data
   */
  sendBinary(data: Uint8Array): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.error(
        `send failed: connection unavailable (state=${this.state}, readyState=${this.ws?.readyState ?? "no socket"})`,
      );
      return false;
    }
    this.ws.send(data);
    return true;
  }

  /**
   * 发送业务请求并等待匹配 msgId 的响应。
   * 超时（Default 30s）后 reject。
   * @param cmd - 命令字
   * @param module - 模块名
   * @param data - 已编码的业务 payload（Uint8Array）
   * @param timeoutMs - 超时时间（毫秒），Default 30000
   * @returns 业务响应 Promise
   */
  sendAndWait(
    cmd: string,
    module: string,
    data: Uint8Array,
    timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  ): Promise<WsSendMessageResponse> {
    const msgId = generateMsgId();
    const binary = buildBusinessConnMsg(cmd, module, data, msgId);

    if (!binary) {
      return Promise.reject(new Error("Failed to encode business message"));
    }

    return new Promise<WsSendMessageResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msgId);
        reject(new Error(`WS request timeout (${timeoutMs}ms) for msgId=${msgId}`));
      }, timeoutMs);

      this.pendingRequests.set(msgId, { resolve, timer });

      const sent = this.sendBinary(binary);
      if (!sent) {
        clearTimeout(timer);
        this.pendingRequests.delete(msgId);
        reject(new Error("WebSocket not connected, cannot send"));
      }
    });
  }

  // ---- 便捷发送方法 ----

  sendC2CMessage(data: WsSendC2CMessageData): Promise<WsSendMessageResponse> {
    this.log.debug("[C2C] preparing to send message", {
      to_account: data.to_account,
      body: msgBodyDesensitization(data.msg_body),
    });
    const encoded = encodeSendC2CMessageReq(data);
    if (!encoded) {
      return Promise.reject(new Error("Failed to encode SendC2CMessageReq"));
    }
    return this.sendAndWait(BIZ_CMD.SendC2CMessage, BIZ_MODULE, encoded);
  }

  sendGroupMessage(data: WsSendGroupMessageData): Promise<WsSendMessageResponse> {
    this.log.debug("[group] preparing to send message", {
      msg_id: data.msg_id,
      group_code: data.group_code,
      body: msgBodyDesensitization(data.msg_body),
    });
    const encoded = encodeSendGroupMessageReq(data);
    if (!encoded) {
      return Promise.reject(new Error("Failed to encode SendGroupMessageReq"));
    }
    return this.sendAndWait(BIZ_CMD.SendGroupMessage, BIZ_MODULE, encoded);
  }

  /**
   * Send a business request and wait for response (supports custom decoders).
   *
   * 内部会生成唯一 msgId，将请求编码为二进制帧后通过 WebSocket 发送，
   * 并在收到同一 msgId 的响应时使用 `decoder` 解码为目标类型 T。
   * 若在 `timeoutMs` 内未收到响应则自动 reject。
   *
   * @param cmd - 业务命令字，用于标识请求类型（如 SendGroupMessage、QueryGroupInfo 等）
   * @param module - 业务模块名，与 cmd 共同确定后端路由
   * @param data - 已通过 protobuf 等方式编码的业务 payload（Uint8Array）
   * @param decoder - 自定义解码函数，将原始响应字节解码为业务类型 T；解码失败时应返回 null
   * @param timeoutMs - 等待响应的超时时间（毫秒），Default为 {@link DEFAULT_SEND_TIMEOUT_MS}
   * @returns 解码后的业务响应对象；若超时、编码失败或连接断开则 reject
   */
  sendAndWaitWith<T>(
    cmd: string,
    module: string,
    data: Uint8Array,
    decoder: (data: Uint8Array | ArrayBuffer, msgId: string) => T | null,
    timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  ): Promise<T> {
    const msgId = generateMsgId();
    const binary = buildBusinessConnMsg(cmd, module, data, msgId);

    if (!binary) {
      return Promise.reject(new Error("Failed to encode business message"));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msgId);
        reject(new Error(`WS request timeout (${timeoutMs}ms) for msgId=${msgId}`));
      }, timeoutMs);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 类型擦除用于统一 pending 请求存储
      this.pendingRequests.set(msgId, { resolve, timer, decoder: decoder as any });

      const sent = this.sendBinary(binary);
      if (!sent) {
        clearTimeout(timer);
        this.pendingRequests.delete(msgId);
        reject(new Error("WebSocket not connected, cannot send"));
      }
    });
  }

  /**
   * Query group info
   * @param data - Query group info请求数据（包含 group_code）
   */
  queryGroupInfo(data: WsQueryGroupInfoData): Promise<WsQueryGroupInfoResponse> {
    this.log.debug("[group-info] querying group info", { group_code: data.group_code });
    const encoded = encodeQueryGroupInfoReq(data);
    if (!encoded) {
      return Promise.reject(new Error("Failed to encode QueryGroupInfoReq"));
    }
    return this.sendAndWaitWith(
      BIZ_CMD.QueryGroupInfo,
      BIZ_MODULE,
      encoded,
      decodeQueryGroupInfoRsp,
    );
  }

  /**
   * Get group member list
   * @param data - Get group member list请求数据（包含 group_code）
   */
  getGroupMemberList(data: WsGetGroupMemberListData): Promise<WsGetGroupMemberListResponse> {
    this.log.debug("[group-member] fetching group member list", { group_code: data.group_code });
    const encoded = encodeGetGroupMemberListReq(data);
    if (!encoded) {
      return Promise.reject(new Error("Failed to encode GetGroupMemberListReq"));
    }
    return this.sendAndWaitWith(
      BIZ_CMD.GetGroupMemberList,
      BIZ_MODULE,
      encoded,
      decodeGetGroupMemberListRsp,
    );
  }

  /**
   * Send direct chat reply status heartbeat
   */
  sendPrivateHeartbeat(data: WsSendPrivateHeartbeatData): Promise<WsHeartbeatResponse> {
    this.log.debug("[C2C] sending reply heartbeat", {
      from_account: data.from_account,
      to_account: data.to_account,
      heartbeat: data.heartbeat,
    });
    const encoded = encodeSendPrivateHeartbeatReq(data);
    if (!encoded) {
      return Promise.reject(new Error("Failed to encode SendPrivateHeartbeatReq"));
    }
    return this.sendAndWaitWith(
      BIZ_CMD.SendPrivateHeartbeat,
      BIZ_MODULE,
      encoded,
      decodeSendPrivateHeartbeatRsp,
    );
  }

  /**
   * Send group chat reply status heartbeat
   */
  sendGroupHeartbeat(data: WsSendGroupHeartbeatData): Promise<WsHeartbeatResponse> {
    this.log.debug("[group] sending reply heartbeat", {
      from_account: data.from_account,
      to_account: data.to_account,
      group_code: data.group_code,
      send_time: data.send_time,
      heartbeat: data.heartbeat,
    });
    const encoded = encodeSendGroupHeartbeatReq(data);
    if (!encoded) {
      return Promise.reject(new Error("Failed to encode SendGroupHeartbeatReq"));
    }
    return this.sendAndWaitWith(
      BIZ_CMD.SendGroupHeartbeat,
      BIZ_MODULE,
      encoded,
      decodeSendGroupHeartbeatRsp,
    );
  }

  // ============ 连接建立 ============

  /**
   * 建立 WebSocket 连接并绑定事件处理
   * 连接成功后自动发起鉴权，连接断开后自动调度重连
   */
  private doConnect(): void {
    if (this.disposed) {
      return;
    }

    this.setState("connecting");
    this.log.info(`connecting to ${this.connectionConfig.gatewayUrl}`);

    try {
      const ws = new WebSocket(this.connectionConfig.gatewayUrl);
      this.ws = ws;

      ws.on("open", () => {
        this.log.info("WebSocket connected, sending auth...");
        this.sendAuthBind();
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        this.onMessage(raw);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString("utf-8");
        this.log.info(`connection closed: code=${code}, reason=${reasonStr}`);
        this.stopHeartbeat();
        this.callbacks.onClose?.(code, reasonStr);

        if (!this.disposed) {
          if (NO_RECONNECT_CLOSE_CODES.has(code)) {
            this.log.info(`received non-retryable close code=${code}, giving up reconnect`);
            this.setState("disconnected");
            this.callbacks.onError?.(
              new Error(`Connection closed with non-retryable code=${code}: ${reasonStr}`),
            );
          } else {
            this.scheduleReconnect();
          }
        }
      });

      ws.on("error", (err: Error) => {
        this.log.error(`connection error: ${err.message}`);
        this.callbacks.onError?.(err);
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error(`failed to establish connection: ${error.message}`);
      this.callbacks.onError?.(error);
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    }
  }

  // ============ 消息处理 ============

  private onMessage(raw: WebSocket.RawData): void {
    let binary: Uint8Array;
    if (raw instanceof Buffer) {
      binary = new Uint8Array(raw);
    } else if (raw instanceof ArrayBuffer) {
      binary = new Uint8Array(raw);
    } else if (Array.isArray(raw)) {
      binary = new Uint8Array(Buffer.concat(raw));
    } else {
      this.log.warn("received non-binary message, ignoring");
      return;
    }

    const connMsg = decodeConnMsg(binary);
    if (!connMsg?.head) {
      this.log.warn("received undecodable ConnMsg");
      return;
    }

    this.handleConnMsg(connMsg);
  }

  private handleConnMsg(connMsg: PBConnMsg): void {
    const { head } = connMsg;
    const { cmdType } = head;

    // ---- cmdType=1: 上行请求的回包（Response） ----
    if (cmdType === CMD_TYPE.Response) {
      this.onResponse(connMsg);
      return;
    }

    // ---- cmdType=2: 下行推送（Push） ----
    if (cmdType === CMD_TYPE.Push) {
      this.onPush(connMsg);
      return;
    }

    // 其他 cmdType（0=自身发的请求不会收到，3=ACK 回包无需处理）
    this.log.debug(`received unhandled cmdType=${cmdType}, cmd=${head.cmd}`);
  }

  // ---- 回包处理 (cmdType=1) ----

  private onResponse(connMsg: PBConnMsg): void {
    const { head, data } = connMsg;
    const { cmd } = head;

    // 鉴权回包
    if (cmd === CMD.AuthBind) {
      this.onAuthBindResponse(head, data);
      return;
    }

    // 心跳回包
    if (cmd === CMD.Ping) {
      this.onPingResponse(head, data);
      return;
    }

    // 业务请求回包 — 通过 msgId 匹配
    this.onBusinessResponse(head, data);
  }

  // ---- 鉴权 ----

  private sendAuthBind(): void {
    this.setState("authenticating");
    const { auth } = this.connectionConfig;
    const msgId = generateMsgId();

    const payload = {
      bizId: auth.bizId,
      uid: auth.uid,
      source: auth.source,
      token: auth.token,
      msgId,
      routeEnv: auth.routeEnv,
      appVersion: getPluginVersion(),
      operationSystem: getOperationSystem(),
      botVersion: getOpenclawVersion(),
    };

    const binary = buildAuthBindMsg(payload);

    if (!binary) {
      this.log.error("auth-bind message encode failed");
      this.callbacks.onError?.(new Error("Failed to encode auth-bind message"));
      return;
    }

    this.log.info("sending auth-bind request...");
    this.sendBinary(binary);
  }

  /**
   * 尝试触发 onAuthFailed 回调进行 token 刷新并重连。
   * 使用与 close 事件相同的 scheduleReconnect 延迟策略和计数器。
   * @returns 是否已触发回调（true 表示已接管后续流程，调用方应 return）
   */
  private tryAuthFailedRefresh(errorCode: number, source: string): boolean {
    if (!AUTH_FAILED_CODES.has(errorCode) || !this.callbacks.onAuthFailed) {
      return false;
    }

    this.log.warn(
      `[${source}] token invalid (code=${errorCode}), refreshing token then scheduleReconnect`,
    );
    this.closeCurrentWs();
    this.callbacks
      .onAuthFailed(errorCode)
      .then((newAuth) => {
        if (newAuth && !this.disposed) {
          this.log.info(
            `[${source}] token refreshed, reconnecting with new token via scheduleReconnect`,
          );
          this.updateAuth(newAuth);
          this.scheduleReconnect();
        } else {
          this.log.warn(
            `[${source}] token refresh returned empty or client disposed, giving up reconnect`,
          );
          this.setState("disconnected");
        }
      })
      .catch((err) => {
        this.log.error(`[${source}] token refresh failed: ${String(err)}, retrying after delay`);
        if (!this.disposed) {
          // 签票失败时跳过无意义的建联（旧 token 必定鉴权失败），
          // 直接消耗一次重连计数并延迟后重新尝试签票
          this.retryAuthRefreshAfterDelay(errorCode, source);
        } else {
          this.setState("disconnected");
        }
      });

    return true;
  }

  /**
   * After ticket signing failure, consume one reconnect attempt and retry ticket signing after a delay,
   * 避免用已知过期的旧 token 建联（必定鉴权失败）浪费一次重连机会。
   *
   * 流程：递增 reconnectAttempts → 延迟等待 → 调用 onAuthFailed 重新签票
   * - 签票成功：updateAuth + scheduleReconnect 用新 token 建联
   * - 签票失败：递归调用自身继续重试，直到 reconnectAttempts 耗尽
   *
   * @param errorCode - 触发签票刷新的鉴权错误码（如 41103/41104/41108），
   *                    透传给 onAuthFailed 回调以便上层区分失败原因
   * @param source - 调用来源标识（如 'auth-rsp-code'），用于日志追踪
   */
  private retryAuthRefreshAfterDelay(errorCode: number, source: string): void {
    if (this.disposed) {
      return;
    }

    if (this.reconnectAttempts >= this.clientConfig.maxReconnectAttempts) {
      this.log.error(
        `[${source}] max reconnect attempts (${this.clientConfig.maxReconnectAttempts}) reached, giving up token refresh`,
      );
      this.setState("disconnected");
      this.callbacks.onError?.(
        new Error(
          `Max reconnect attempts (${this.clientConfig.maxReconnectAttempts}) exceeded during token refresh`,
        ),
      );
      return;
    }

    const delay = this.getReconnectDelay();
    this.reconnectAttempts++;
    this.setState("reconnecting");
    this.log.info(
      `[${source}] will retry token refresh in ${delay}ms (attempt ${this.reconnectAttempts}/${this.clientConfig.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || !this.callbacks.onAuthFailed) {
        return;
      }

      this.callbacks
        .onAuthFailed(errorCode)
        .then((newAuth) => {
          if (newAuth && !this.disposed) {
            this.log.info(
              `[${source}] token retry succeeded, reconnecting with new token via scheduleReconnect`,
            );
            this.updateAuth(newAuth);
            this.scheduleReconnect();
          } else {
            this.log.warn(
              `[${source}] token retry returned empty or client disposed, giving up reconnect`,
            );
            this.setState("disconnected");
          }
        })
        .catch((err) => {
          this.log.error(
            `[${source}] token retry still failed: ${String(err)}, retrying after delay`,
          );
          if (!this.disposed) {
            this.retryAuthRefreshAfterDelay(errorCode, source);
          } else {
            this.setState("disconnected");
          }
        });
    }, delay);
  }

  /**
   * Handle auth response: verify status code, decode response, start heartbeat
   * 鉴权成功后触发 onReady 回调
   *
   * @param head - ConnMsg 协议头，包含状态码和消息 ID
   * @param data - 鉴权响应的二进制数据
   */
  private onAuthBindResponse(head: PBConnMsg["head"], data: Uint8Array): void {
    const rsp = decodePB(PB_MSG_TYPES.AuthBindRsp, data);

    // 检查 head.status 非 0（Transport layer失败）
    if (head.status && head.status !== 0) {
      this.log.error(
        `auth-bind head.status non-zero: status=${head.status}, rsp.code=${rsp?.code}, rsp.message=${rsp?.message}`,
      );

      // 已经鉴权通过，视为成功
      if (rsp?.code === AUTH_ALREADY_CODE) {
        this.log.info(`received ALREADY_AUTH(${AUTH_ALREADY_CODE}), treating as auth success`);
        // fall through 到下方鉴权成功逻辑
      } else {
        if (rsp?.code && this.tryAuthFailedRefresh(rsp.code, "auth-head-status")) {
          return;
        }

        // 服务端临时错误，走 scheduleReconnect 重连
        if (rsp?.code && AUTH_RETRYABLE_CODES.has(rsp.code)) {
          this.log.warn?.(
            `auth retryable error (code=${rsp.code}), reconnecting via scheduleReconnect`,
          );
          this.closeCurrentWs();
          this.scheduleReconnect();
          return;
        }

        // 非可处理的鉴权失败，关闭连接避免悬挂
        this.closeCurrentWs();
        this.setState("disconnected");
        this.callbacks.onError?.(new Error(`Auth-bind failed: status=${head.status}`));
        return;
      }
    }

    // 检查业务层 code 非 0
    if (!rsp || (rsp.code !== 0 && rsp.code !== AUTH_ALREADY_CODE)) {
      this.log.error(
        `auth-bind response error: rsp.code=${rsp?.code}, rsp.message=${rsp?.message}`,
      );

      if (rsp?.code && this.tryAuthFailedRefresh(rsp.code, "auth-rsp-code")) {
        return;
      }

      // 服务端临时错误，走 scheduleReconnect 重连
      if (rsp?.code && AUTH_RETRYABLE_CODES.has(rsp.code)) {
        this.log.warn?.(`鉴权收到可重试错误(code=${rsp.code})，走 scheduleReconnect 重连`);
        this.closeCurrentWs();
        this.scheduleReconnect();
        return;
      }

      // 非可处理的鉴权失败，关闭连接避免悬挂
      this.closeCurrentWs();
      this.setState("disconnected");
      this.callbacks.onError?.(new Error(`Auth-bind response error: code=${rsp?.code}`));
      return;
    }

    this.connectId = rsp.connectId || null;
    this.log.info(`auth success: connectId=${this.connectId}`);
    this.reconnectAttempts = 0;

    this.setState("connected");
    this.startHeartbeat(true);

    this.callbacks.onReady?.({
      connectId: rsp.connectId || "",
      timestamp: Number(rsp.timestamp || 0),
      clientIp: rsp.clientIp || "",
    });
  }

  // ---- 心跳 ----

  private startHeartbeat(isFirst = false): void {
    this.stopHeartbeat();
    this.heartbeatAckReceived = true;
    if (isFirst) {
      this.heartbeatTimeoutCount = 0;
    }

    const delayMs = isFirst ? 5_000 : (this.heartbeatIntervalS - 1) * 1000;
    this.log.debug(`heartbeat scheduled: ${delayMs}ms`);

    this.heartbeatTimer = setTimeout(() => {
      this.sendPing();
    }, delayMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 仅安排下一次 sendPing 调用（用于连续超时检查），不重置 heartbeatAckReceived */
  private scheduleNextPingCheck(): void {
    this.stopHeartbeat();
    const delayMs = (this.heartbeatIntervalS - 1) * 1000;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      this.sendPing();
    }, delayMs);
  }

  private sendPing(): void {
    if (!this.heartbeatAckReceived) {
      this.heartbeatTimeoutCount++;
      const elapsed = Date.now() - this.lastHeartbeatAt;
      if (this.heartbeatTimeoutCount >= HEARTBEAT_TIMEOUT_THRESHOLD) {
        this.log.warn(
          `heartbeat timeout ${this.heartbeatTimeoutCount} consecutive times (${elapsed}ms no ack), triggering reconnect`,
        );
        this.heartbeatTimeoutCount = 0;
        this.closeCurrentWs();
        this.scheduleReconnect();
        return;
      }
      this.log.warn(
        `heartbeat timeout (${elapsed}ms no ack), ${this.heartbeatTimeoutCount}/${HEARTBEAT_TIMEOUT_THRESHOLD}, ${HEARTBEAT_TIMEOUT_THRESHOLD - this.heartbeatTimeoutCount} more before reconnect`,
      );
      // 仅安排下一次超时检查，不重置 ack，以便下次仍能判定为超时
      this.scheduleNextPingCheck();
      return;
    }

    const msgId = generateMsgId();
    const binary = buildPingMsg(msgId);
    if (!binary) {
      this.log.error("heartbeat message encode failed");
      return;
    }

    this.heartbeatAckReceived = false;
    this.lastHeartbeatAt = Date.now();
    this.sendBinary(binary);
    this.log.debug("heartbeat sent");
  }

  private onPingResponse(head: PBConnMsg["head"], data: Uint8Array): void {
    this.heartbeatAckReceived = true;
    this.heartbeatTimeoutCount = 0;
    const latency = Date.now() - this.lastHeartbeatAt;

    const rsp = decodePB(PB_MSG_TYPES.PingRsp, data);
    if (rsp?.heartInterval && rsp.heartInterval > 1) {
      this.heartbeatIntervalS = rsp.heartInterval;
      this.log.debug(`heartbeat ACK: latency=${latency}ms, next interval=${rsp.heartInterval}s`);
    } else {
      this.log.debug(`heartbeat ACK: latency=${latency}ms`);
    }

    // 安排下次心跳
    this.startHeartbeat(false);
  }

  // ---- 推送处理 (cmdType=2) ----

  /**
   * 处理下行推送消息（cmdType=2）
   * 按需发送 ACK、处理踢下线、解码 DirectedPush/PushMsg 并分发
   *
   * @param connMsg - 完整的 ConnMsg 消息对象，包含 head 和 data
   */
  private onPush(connMsg: PBConnMsg): void {
    const { head, data } = connMsg;

    this.log.debug("received push", { head });

    // 如果 needAck，发回 ACK
    if (head.needAck) {
      const ack = buildPushAck(head);
      if (ack) {
        this.sendBinary(ack);
        this.log.debug(`ACK sent: cmd=${head.cmd}, msgId=${head.msgId}`);
      }
    }

    // 踢下线处理
    if (head.cmd === CMD.Kickout) {
      const kickout = decodePB(PB_MSG_TYPES.KickoutMsg, data);
      this.log.warn("kicked out", { kickout });
      this.callbacks.onKickout?.({
        status: kickout?.status || 0,
        reason: kickout?.reason || "",
        otherDeviceName: kickout?.otherDeviceName,
      });
      return;
    }

    // 先尝试解码为 PushMsg（结构更精确，不易误匹配）
    const pushMsg = decodePB(PB_MSG_TYPES.PushMsg, data);
    if (pushMsg && (pushMsg.cmd || pushMsg.module)) {
      const rawData = pushMsg.data;
      // this.log.debug?.(prefixed(`PushMsg decoded: cmd=${pushMsg.cmd}, module=${pushMsg.module}, msgId=${pushMsg.msgId}, rawData.length=${rawData?.length ?? 0}, data.length=${data.length}`));
      const pushEvent: WsPushEvent = {
        cmd: pushMsg.cmd || head.cmd,
        module: pushMsg.module || head.module,
        msgId: pushMsg.msgId || head.msgId,
        rawData,
        connData: data, // 保留完整 ConnMsg.data，供 gateway fallback 解码
      };
      this.callbacks.onDispatch?.(pushEvent);
      return;
    }

    // 再尝试解码为 DirectedPush
    const directed = decodePB(PB_MSG_TYPES.DirectedPush, data);
    if (directed && (directed.type || directed.content)) {
      const pushEvent: WsPushEvent = {
        type: directed.type,
        content: directed.content,
        cmd: head.cmd,
        module: head.module,
        msgId: head.msgId,
      };
      this.callbacks.onDispatch?.(pushEvent);
      return;
    }

    // 未识别的推送，传递原始 data
    this.callbacks.onDispatch?.({
      cmd: head.cmd,
      module: head.module,
      msgId: head.msgId,
      rawData: data,
    });
  }

  // ---- 业务回包 (cmdType=1, 非 auth/ping) ----

  /**
   * 处理业务回包（cmdType=1，非 auth/ping）
   * 通过 msgId 匹配 pending 请求并 resolve Promise
   *
   * @param head - ConnMsg 协议头，包含 msgId 用于匹配 pending 请求
   * @param data - 业务响应的二进制数据
   */
  private onBusinessResponse(head: PBConnMsg["head"], data: Uint8Array): void {
    const { msgId } = head;
    if (!msgId) {
      return;
    }

    const pending = this.pendingRequests.get(msgId);
    if (!pending) {
      this.log.debug(`received unmatched business response: cmd=${head.cmd}, msgId=${msgId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msgId);

    // 尝试用 protobuf 解码回包
    if (data && data.length > 0) {
      // 优先使用自定义解码器（QueryGroupInfo / GetGroupMemberList 等）
      const decoder = pending.decoder ?? decodeSendMessageRsp;
      const rsp = decoder(data, msgId);
      this.log.debug("business response decoded", { rsp });
      if (rsp) {
        // 如果 head.status 非 0，覆盖 code
        if (head.status && head.status !== 0) {
          rsp.code = head.status;
          if ("message" in rsp) {
            rsp.message = rsp.message || "FAIL";
          }
          if ("msg" in rsp) {
            rsp.msg = rsp.msg || "FAIL";
          }
        }
        pending.resolve(rsp);
        return;
      }
    }

    // protobuf 解码失败，返回基于 head 的基本响应
    pending.resolve({
      msgId,
      code: head.status || 0,
      message: head.status === 0 ? "" : "FAIL",
    });
  }

  // ============ 重连机制 ============

  private getReconnectDelay(): number {
    const delays = this.clientConfig.reconnectDelays;
    const index = Math.min(this.reconnectAttempts, delays.length - 1);
    return delays[index];
  }

  private scheduleReconnect(customDelay?: number): void {
    if (this.disposed) {
      return;
    }

    if (this.reconnectAttempts >= this.clientConfig.maxReconnectAttempts) {
      this.log.error(
        `max reconnect attempts (${this.clientConfig.maxReconnectAttempts}) reached, giving up`,
      );
      this.setState("disconnected");
      this.callbacks.onError?.(
        new Error(`Max reconnect attempts (${this.clientConfig.maxReconnectAttempts}) exceeded`),
      );
      return;
    }

    const delay = customDelay ?? this.getReconnectDelay();
    this.reconnectAttempts++;
    this.setState("reconnecting");
    this.log.info(
      `will reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.clientConfig.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) {
        this.doConnect();
      }
    }, delay);
  }

  // ============ 状态管理 ============

  private setState(next: WsClientState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  // ============ 清理 ============

  private closeCurrentWs(): void {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        // 保留一个 noop error handler，防止 removeAllListeners 后
        // 服务端发来异常 close frame 导致 unhandled error crash
        this.ws.on("error", () => {});
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, "client closing");
        }
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  private cleanup(): void {
    this.closeCurrentWs();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // 拒绝所有待处理请求
    for (const [msgId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({
        msgId,
        code: -1,
        message: "Client disconnected",
      });
    }
    this.pendingRequests.clear();

    this.setState("disconnected");
  }
}
