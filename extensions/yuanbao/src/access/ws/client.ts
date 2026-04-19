/**
 * WebSocket client
 *
 * Implements connection management, auth, heartbeat, and auto-reconnect
 * based on the Yuanbao long-connection ConnMsg protobuf protocol.
 * Adapted from chatbot-web's chat-web-socket.ts for Node.js server-side use.
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
  encodeSyncInformationReq,
  decodeSyncInformationRsp,
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
  WsSyncInformationData,
  WsSyncInformationResponse,
} from "./types.js";

/** AuthBindRsp decoded result */
type PBAuthBindRsp = {
  code?: number;
  message?: string;
  connectId?: string;
  timestamp?: number | string;
  clientIp?: string;
};

/** PingRsp decoded result */
type PBPingRsp = {
  heartInterval?: number;
};

/** KickoutMsg decoded result */
type PBKickoutMsg = {
  status?: number;
  reason?: string;
  otherDeviceName?: string;
};

/** PushMsg decoded result */
type PBPushMsg = {
  cmd?: string;
  module?: string;
  msgId?: string;
  data?: Uint8Array;
};

/** DirectedPush decoded result */
type PBDirectedPush = {
  type?: number;
  content?: string;
};

const DEFAULT_RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** Close codes that should NOT trigger auto-reconnect */
const NO_RECONNECT_CLOSE_CODES = new Set([
  4012, // Version ban
  4013, // User ban
  4014, // Same-user connection conflict
  4018, // Account ban
  4019, // Account deleted
  4021, // Device removed
]);
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 100;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_S = 5;

/** Auth error codes requiring token refresh before reconnect */
const AUTH_FAILED_CODES = new Set([41103, 41104, 41108]);

/** Already authenticated — treat as auth success */
const AUTH_ALREADY_CODE = 41101;

/** Transient server errors — can reconnect directly without refreshing the token */
const AUTH_RETRYABLE_CODES = new Set([
  50400, // Server program error
  50503, // System overload protection
  90001, // Downstream network error
  90003, // Downstream dependency failure
]);

/** Number of consecutive heartbeat timeouts before triggering reconnect */
const HEARTBEAT_TIMEOUT_THRESHOLD = 2;

// --- Helpers ---

function generateMsgId(): string {
  return uuidv4().replace(/-/g, "");
}

/** Outbound business commands */
export const BIZ_CMD = {
  /** Send C2C message */
  SendC2CMessage: "send_c2c_message",
  /** Send group message */
  SendGroupMessage: "send_group_message",
  /** Query group info */
  QueryGroupInfo: "query_group_info",
  /** Get group member list */
  GetGroupMemberList: "get_group_member_list",
  /** Direct-chat reply status heartbeat */
  SendPrivateHeartbeat: "send_private_heartbeat",
  /** Group-chat reply status heartbeat */
  SendGroupHeartbeat: "send_group_heartbeat",
  /** Sync information (command list, etc.) */
  SyncInformation: "sync_information",
} as const;

const BIZ_MODULE = "yuanbao_openclaw_proxy";

// --- Client class ---

/**
 * Yuanbao WebSocket client
 *
 * Implements connection management, auth, heartbeat, and auto-reconnect
 * based on the ConnMsg protobuf protocol.
 * Provides send/receive, request-response matching, and other core capabilities.
 */
export class YuanbaoWsClient {
  // --- Config ---
  private connectionConfig: WsConnectionConfig;
  private readonly clientConfig: Required<WsClientConfig>;
  private readonly callbacks: WsClientCallbacks;
  private readonly log: ModuleLog;

  // --- Connection state ---
  private ws: WebSocket | null = null;
  private state: WsClientState = "disconnected";
  private connectId: string | null = null;

  // --- Heartbeat ---
  private heartbeatIntervalS: number = DEFAULT_HEARTBEAT_INTERVAL_S;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAckReceived = true;
  private lastHeartbeatAt = 0;
  private heartbeatTimeoutCount = 0;

  // ---- Reconnect ----
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- Lifecycle ----
  private abortController: AbortController | null = null;
  private disposed = false;

  // --- Request / response matching (via msgId) ---
  private pendingRequests = new Map<
    string,
    {
      resolve: (resp: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
      /** Custom decoder; falls back to decodeSendMessageRsp when absent */
      decoder?: (data: Uint8Array | ArrayBuffer, msgId: string) => unknown;
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

  /**
   * Update auth info (used for reconnect after token refresh).
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
   * Send raw binary data.
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
   * Send a business request and wait for the response matching the same msgId.
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

      this.pendingRequests.set(msgId, { resolve: resolve as (resp: unknown) => void, timer });

      const sent = this.sendBinary(binary);
      if (!sent) {
        clearTimeout(timer);
        this.pendingRequests.delete(msgId);
        reject(new Error("WebSocket not connected, cannot send"));
      }
    });
  }

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
   * Send a business request and wait for the response (supports custom decoders).
   *
   * Internally generates a unique msgId, encodes the request as a binary frame,
   * sends it over WebSocket, and uses the `decoder` to decode the response
   * matching the same msgId into target type T.
   * Auto-rejects if no response arrives within `timeoutMs`.
   *
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

      this.pendingRequests.set(msgId, {
        resolve: resolve as (resp: unknown) => void,
        timer,
        decoder: decoder as (data: Uint8Array | ArrayBuffer, msgId: string) => unknown,
      });

      const sent = this.sendBinary(binary);
      if (!sent) {
        clearTimeout(timer);
        this.pendingRequests.delete(msgId);
        reject(new Error("WebSocket not connected, cannot send"));
      }
    });
  }

  /**
   * Query group info.
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
   * Get group member list.
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
   * Send direct-chat reply status heartbeat.
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
   * Send group-chat reply status heartbeat.
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

  /**
   * Sync information to the backend (command list, etc.).
   */
  syncInformation(data: WsSyncInformationData): Promise<WsSyncInformationResponse> {
    this.log.info("[sync] sending SyncInformation request", {
      syncType: data.syncType,
      botVersion: data.botVersion,
      pluginVersion: data.pluginVersion,
    });
    const encoded = encodeSyncInformationReq(data);
    if (!encoded) {
      return Promise.reject(new Error("Failed to encode SyncInformationReq"));
    }
    return this.sendAndWaitWith(
      BIZ_CMD.SyncInformation,
      BIZ_MODULE,
      encoded,
      decodeSyncInformationRsp,
    );
  }

  /**
   * Establish WebSocket connection and bind event handlers.
   * Auto-sends auth on connect; schedules reconnect on close.
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

    // cmdType=1: Response to an upstream request
    if (cmdType === CMD_TYPE.Response) {
      this.onResponse(connMsg);
      return;
    }

    // cmdType=2: Downstream push
    if (cmdType === CMD_TYPE.Push) {
      this.onPush(connMsg);
      return;
    }

    // Other cmdTypes (0=own request — never received, 3=ACK — no handling needed)
    this.log.debug(`received unhandled cmdType=${cmdType}, cmd=${head.cmd}`);
  }

  private onResponse(connMsg: PBConnMsg): void {
    const { head, data } = connMsg;
    const { cmd } = head;

    // Auth response
    if (cmd === CMD.AuthBind) {
      this.onAuthBindResponse(head, data);
      return;
    }

    // Heartbeat response
    if (cmd === CMD.Ping) {
      this.onPingResponse(head, data);
      return;
    }

    // Business response — match via msgId
    this.onBusinessResponse(head, data);
  }

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
   * Try triggering the onAuthFailed callback for token refresh and reconnect.
   * Uses the same scheduleReconnect delay strategy and counter as close events.
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
          // Skip pointless connection attempt with old (definitely invalid) token;
          // consume one reconnect count and retry token refresh after delay
          this.retryAuthRefreshAfterDelay(errorCode, source);
        } else {
          this.setState("disconnected");
        }
      });

    return true;
  }

  /**
   * After token signing failure, consume one reconnect attempt and retry after a delay.
   * Avoids wasting a reconnect attempt on a connection with a known-expired token.
   *
   * Flow: increment reconnectAttempts → wait → call onAuthFailed to re-sign
   * - Success: updateAuth + scheduleReconnect with new token
   * - Failure: recursively call self to keep retrying until attempts exhausted
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
   * Handle auth response: verify status code, decode response, start heartbeat.
   * Fires the onReady callback on auth success.
   */
  private onAuthBindResponse(head: PBConnMsg["head"], data: Uint8Array): void {
    const rsp = decodePB<PBAuthBindRsp>(PB_MSG_TYPES.AuthBindRsp, data);

    // Check head.status non-zero (transport layer failure)
    if (head.status && head.status !== 0) {
      this.log.error(
        `auth-bind head.status non-zero: status=${head.status}, rsp.code=${rsp?.code}, rsp.message=${rsp?.message}`,
      );

      // Already authenticated — treat as success
      if (rsp?.code === AUTH_ALREADY_CODE) {
        this.log.info(`received ALREADY_AUTH(${AUTH_ALREADY_CODE}), treating as auth success`);
        // fall through to auth success logic below
      } else {
        if (rsp?.code && this.tryAuthFailedRefresh(rsp.code, "auth-head-status")) {
          return;
        }

        // Transient server error — reconnect via scheduleReconnect
        if (rsp?.code && AUTH_RETRYABLE_CODES.has(rsp.code)) {
          this.log.warn?.(
            `auth retryable error (code=${rsp.code}), reconnecting via scheduleReconnect`,
          );
          this.closeCurrentWs();
          this.scheduleReconnect();
          return;
        }

        // Non-recoverable auth failure — close to avoid dangling connection
        this.closeCurrentWs();
        this.setState("disconnected");
        this.callbacks.onError?.(new Error(`Auth-bind failed: status=${head.status}`));
        return;
      }
    }

    // Check business layer code non-zero
    if (!rsp || (rsp.code !== 0 && rsp.code !== AUTH_ALREADY_CODE)) {
      this.log.error(
        `auth-bind response error: rsp.code=${rsp?.code}, rsp.message=${rsp?.message}`,
      );

      if (rsp?.code && this.tryAuthFailedRefresh(rsp.code, "auth-rsp-code")) {
        return;
      }

      // Transient server error — reconnect via scheduleReconnect
      if (rsp?.code && AUTH_RETRYABLE_CODES.has(rsp.code)) {
        this.log.warn?.(`auth retryable error (code=${rsp.code}), reconnecting via scheduleReconnect`);
        this.closeCurrentWs();
        this.scheduleReconnect();
        return;
      }

      // Non-recoverable auth failure — close to avoid dangling connection
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

  /** Schedule the next sendPing call without resetting heartbeatAckReceived (for consecutive timeout detection) */
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
      // Only schedule next timeout check; don't reset ack so the next check still detects timeout
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

    const rsp = decodePB<PBPingRsp>(PB_MSG_TYPES.PingRsp, data);
    if (rsp?.heartInterval && rsp.heartInterval > 1) {
      this.heartbeatIntervalS = rsp.heartInterval;
      this.log.debug(`heartbeat ACK: latency=${latency}ms, next interval=${rsp.heartInterval}s`);
    } else {
      this.log.debug(`heartbeat ACK: latency=${latency}ms`);
    }

    // Schedule next heartbeat
    this.startHeartbeat(false);
  }

  /**
   * Handle a downstream push (cmdType=2).
   * Sends ACK if needed, handles kickout, decodes DirectedPush/PushMsg, and dispatches.
   */
  private onPush(connMsg: PBConnMsg): void {
    const { head, data } = connMsg;

    this.log.debug("received push", { head });

    // Send ACK if required
    if (head.needAck) {
      const ack = buildPushAck(head);
      if (ack) {
        this.sendBinary(ack);
        this.log.debug(`ACK sent: cmd=${head.cmd}, msgId=${head.msgId}`);
      }
    }

    // Kickout handling
    if (head.cmd === CMD.Kickout) {
      const kickout = decodePB<PBKickoutMsg>(PB_MSG_TYPES.KickoutMsg, data);
      this.log.warn("kicked out", { kickout });
      this.callbacks.onKickout?.({
        status: kickout?.status || 0,
        reason: kickout?.reason || "",
        otherDeviceName: kickout?.otherDeviceName,
      });
      return;
    }

    // Try PushMsg first (more precise structure, less likely to false-match)
    const pushMsg = decodePB<PBPushMsg>(PB_MSG_TYPES.PushMsg, data);
    if (pushMsg && (pushMsg.cmd || pushMsg.module)) {
      const rawData = pushMsg.data;
      const pushEvent: WsPushEvent = {
        cmd: pushMsg.cmd || head.cmd,
        module: pushMsg.module || head.module,
        msgId: pushMsg.msgId || head.msgId,
        rawData,
        connData: data, // Keep full ConnMsg.data for gateway fallback decoding
      };
      this.callbacks.onDispatch?.(pushEvent);
      return;
    }

    // Then try DirectedPush
    const directed = decodePB<PBDirectedPush>(PB_MSG_TYPES.DirectedPush, data);
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

    // Unrecognized push — pass raw data through
    this.callbacks.onDispatch?.({
      cmd: head.cmd,
      module: head.module,
      msgId: head.msgId,
      rawData: data,
    });
  }

  // --- Business response (cmdType=1, non-auth/ping) ---

  /**
   * Handle a business response (cmdType=1, non-auth/ping).
   * Matches pending requests by msgId and resolves the Promise.
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

    // Try protobuf decode on the response
    if (data && data.length > 0) {
      // Prefer custom decoder (QueryGroupInfo / GetGroupMemberList, etc.)
      const decoder = pending.decoder ?? decodeSendMessageRsp;
      const rsp = decoder(data, msgId) as Record<string, unknown> | null;
      this.log.debug("business response decoded", { rsp });
      if (rsp) {
        // Override code if head.status is non-zero
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

    // Protobuf decode failed — return a basic response based on head
    pending.resolve({
      msgId,
      code: head.status || 0,
      message: head.status === 0 ? "" : "FAIL",
    });
  }

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

  private setState(next: WsClientState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  private closeCurrentWs(): void {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        // Keep a noop error handler to prevent unhandled error crash
        // after removeAllListeners when the server sends an abnormal close frame
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
