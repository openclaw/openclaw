import { randomUUID } from "node:crypto";
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
type PBAuthBindRsp = {
  code?: number;
  message?: string;
  connectId?: string;
  timestamp?: number | string;
  clientIp?: string;
};

type PBPingRsp = {
  heartInterval?: number;
};

type PBKickoutMsg = {
  status?: number;
  reason?: string;
  otherDeviceName?: string;
};

type PBPushMsg = {
  cmd?: string;
  module?: string;
  msgId?: string;
  data?: Uint8Array;
};

type PBDirectedPush = {
  type?: number;
  content?: string;
};

const DEFAULT_RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

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

const AUTH_FAILED_CODES = new Set([41103, 41104, 41108]);
const AUTH_ALREADY_CODE = 41101;

const AUTH_RETRYABLE_CODES = new Set([
  50400, // Server program error
  50503, // System overload protection
  90001, // Downstream network error
  90003, // Downstream dependency failure
]);

const HEARTBEAT_TIMEOUT_THRESHOLD = 2;

function generateMsgId(): string {
  return randomUUID().replace(/-/g, "");
}

/** Outbound business commands */
export const BIZ_CMD = {
  /** Send C2C message */
  SendC2CMessage: "send_c2c_message",
  /** Send group message */
  SendGroupMessage: "send_group_message",
  QueryGroupInfo: "query_group_info",
  GetGroupMemberList: "get_group_member_list",
  SendPrivateHeartbeat: "send_private_heartbeat",
  SendGroupHeartbeat: "send_group_heartbeat",
} as const;

const BIZ_MODULE = "yuanbao_openclaw_proxy";

/**
 * Yuanbao WebSocket client.
 * Implements connection lifecycle, auth, heartbeat, auto-reconnect,
 * send/receive, and request-response matching via msgId.
 */
export class YuanbaoWsClient {
  private connectionConfig: WsConnectionConfig;
  private readonly clientConfig: Required<WsClientConfig>;
  private readonly callbacks: WsClientCallbacks;
  private readonly log: ModuleLog;
  private ws: WebSocket | null = null;
  private state: WsClientState = "disconnected";
  private connectId: string | null = null;
  private heartbeatIntervalS: number = DEFAULT_HEARTBEAT_INTERVAL_S;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAckReceived = true;
  private lastHeartbeatAt = 0;
  private heartbeatTimeoutCount = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  private pendingRequests = new Map<
    string,
    {
      resolve: (resp: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
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

  sendAndWait(
    cmd: string,
    module: string,
    data: Uint8Array,
    timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  ): Promise<WsSendMessageResponse> {
    return this.sendAndWaitWith(cmd, module, data, decodeSendMessageRsp, timeoutMs);
  }

  sendC2CMessage(data: WsSendC2CMessageData): Promise<WsSendMessageResponse> {
    this.log.debug("[C2C] preparing to send message", {
      to_account: data.to_account,
      body: msgBodyDesensitization(data.msg_body),
    });
    return this.encodeThenSend(
      BIZ_CMD.SendC2CMessage,
      encodeSendC2CMessageReq(data),
      "SendC2CMessageReq",
    );
  }

  sendGroupMessage(data: WsSendGroupMessageData): Promise<WsSendMessageResponse> {
    this.log.debug("[group] preparing to send message", {
      msg_id: data.msg_id,
      group_code: data.group_code,
      body: msgBodyDesensitization(data.msg_body),
    });
    return this.encodeThenSend(
      BIZ_CMD.SendGroupMessage,
      encodeSendGroupMessageReq(data),
      "SendGroupMessageReq",
    );
  }

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
      if (!this.sendBinary(binary)) {
        clearTimeout(timer);
        this.pendingRequests.delete(msgId);
        reject(new Error("WebSocket not connected, cannot send"));
      }
    });
  }

  private encodeThenSend(
    cmd: string,
    encoded: Uint8Array | null,
    label: string,
  ): Promise<WsSendMessageResponse> {
    if (!encoded) {
      return Promise.reject(new Error(`Failed to encode ${label}`));
    }
    return this.sendAndWait(cmd, BIZ_MODULE, encoded);
  }

  private encodeThenSendWith<T>(
    cmd: string,
    encoded: Uint8Array | null,
    label: string,
    decoder: (data: Uint8Array | ArrayBuffer, msgId: string) => T | null,
  ): Promise<T> {
    if (!encoded) {
      return Promise.reject(new Error(`Failed to encode ${label}`));
    }
    return this.sendAndWaitWith(cmd, BIZ_MODULE, encoded, decoder);
  }

  queryGroupInfo(data: WsQueryGroupInfoData): Promise<WsQueryGroupInfoResponse> {
    this.log.debug("[group-info] querying group info", { group_code: data.group_code });
    return this.encodeThenSendWith(
      BIZ_CMD.QueryGroupInfo,
      encodeQueryGroupInfoReq(data),
      "QueryGroupInfoReq",
      decodeQueryGroupInfoRsp,
    );
  }

  getGroupMemberList(data: WsGetGroupMemberListData): Promise<WsGetGroupMemberListResponse> {
    this.log.debug("[group-member] fetching group member list", { group_code: data.group_code });
    return this.encodeThenSendWith(
      BIZ_CMD.GetGroupMemberList,
      encodeGetGroupMemberListReq(data),
      "GetGroupMemberListReq",
      decodeGetGroupMemberListRsp,
    );
  }

  sendPrivateHeartbeat(data: WsSendPrivateHeartbeatData): Promise<WsHeartbeatResponse> {
    this.log.debug("[C2C] sending reply heartbeat", {
      from_account: data.from_account,
      to_account: data.to_account,
      heartbeat: data.heartbeat,
    });
    return this.encodeThenSendWith(
      BIZ_CMD.SendPrivateHeartbeat,
      encodeSendPrivateHeartbeatReq(data),
      "SendPrivateHeartbeatReq",
      decodeSendPrivateHeartbeatRsp,
    );
  }

  sendGroupHeartbeat(data: WsSendGroupHeartbeatData): Promise<WsHeartbeatResponse> {
    this.log.debug("[group] sending reply heartbeat", {
      from_account: data.from_account,
      to_account: data.to_account,
      group_code: data.group_code,
      heartbeat: data.heartbeat,
    });
    return this.encodeThenSendWith(
      BIZ_CMD.SendGroupHeartbeat,
      encodeSendGroupHeartbeatReq(data),
      "SendGroupHeartbeatReq",
      decodeSendGroupHeartbeatRsp,
    );
  }

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

    if (cmdType === CMD_TYPE.Response) {
      this.onResponse(connMsg);
      return;
    }

    if (cmdType === CMD_TYPE.Push) {
      this.onPush(connMsg);
      return;
    }

    this.log.debug(`received unhandled cmdType=${cmdType}, cmd=${head.cmd}`);
  }

  private onResponse(connMsg: PBConnMsg): void {
    const { head, data } = connMsg;
    const { cmd } = head;

    if (cmd === CMD.AuthBind) {
      this.onAuthBindResponse(head, data);
      return;
    }

    if (cmd === CMD.Ping) {
      this.onPingResponse(head, data);
      return;
    }

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

  private tryAuthFailedRefresh(errorCode: number, source: string): boolean {
    if (!AUTH_FAILED_CODES.has(errorCode) || !this.callbacks.onAuthFailed) {
      return false;
    }
    this.log.warn(`[${source}] token invalid (code=${errorCode}), refreshing`);
    this.closeCurrentWs();
    this.doAuthRefresh(errorCode, source);
    return true;
  }

  private doAuthRefresh(errorCode: number, source: string): void {
    if (this.disposed || !this.callbacks.onAuthFailed) {
      this.setState("disconnected");
      return;
    }
    this.callbacks
      .onAuthFailed(errorCode)
      .then((newAuth) => {
        if (newAuth && !this.disposed) {
          this.updateAuth(newAuth);
          this.scheduleReconnect();
        } else {
          this.setState("disconnected");
        }
      })
      .catch((err) => {
        this.log.error(`[${source}] token refresh failed: ${String(err)}`);
        if (!this.disposed && this.reconnectAttempts < this.clientConfig.maxReconnectAttempts) {
          this.reconnectAttempts++;
          this.setState("reconnecting");
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.doAuthRefresh(errorCode, source);
          }, this.getReconnectDelay());
        } else {
          this.setState("disconnected");
        }
      });
  }

  private onAuthBindResponse(head: PBConnMsg["head"], data: Uint8Array): void {
    const rsp = decodePB(PB_MSG_TYPES.AuthBindRsp, data) as PBAuthBindRsp | null;
    if (head.status && head.status !== 0) {
      if (rsp?.code === AUTH_ALREADY_CODE) {
        this.log.info(`received ALREADY_AUTH(${AUTH_ALREADY_CODE}), treating as success`);
      } else {
        if (rsp?.code && this.tryAuthFailedRefresh(rsp.code, "auth-head-status")) {
          return;
        }
        if (rsp?.code && AUTH_RETRYABLE_CODES.has(rsp.code)) {
          this.closeCurrentWs();
          this.scheduleReconnect();
          return;
        }
        this.closeCurrentWs();
        this.setState("disconnected");
        this.callbacks.onError?.(new Error(`Auth-bind failed: status=${head.status}`));
        return;
      }
    }
    if (!rsp || (rsp.code !== 0 && rsp.code !== AUTH_ALREADY_CODE)) {
      if (rsp?.code && this.tryAuthFailedRefresh(rsp.code, "auth-rsp-code")) {
        return;
      }
      if (rsp?.code && AUTH_RETRYABLE_CODES.has(rsp.code)) {
        this.closeCurrentWs();
        this.scheduleReconnect();
        return;
      }
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
      if (this.heartbeatTimeoutCount >= HEARTBEAT_TIMEOUT_THRESHOLD) {
        this.log.warn(`heartbeat timeout ${this.heartbeatTimeoutCount} times, reconnecting`);
        this.heartbeatTimeoutCount = 0;
        this.closeCurrentWs();
        this.scheduleReconnect();
        return;
      }
      this.scheduleNextPingCheck();
      return;
    }
    const binary = buildPingMsg(generateMsgId());
    if (!binary) {
      return;
    }
    this.heartbeatAckReceived = false;
    this.lastHeartbeatAt = Date.now();
    this.sendBinary(binary);
  }

  private onPingResponse(head: PBConnMsg["head"], data: Uint8Array): void {
    this.heartbeatAckReceived = true;
    this.heartbeatTimeoutCount = 0;
    const rsp = decodePB(PB_MSG_TYPES.PingRsp, data) as PBPingRsp | null;
    if (rsp?.heartInterval && rsp.heartInterval > 1) {
      this.heartbeatIntervalS = rsp.heartInterval;
    }
    this.startHeartbeat(false);
  }

  private onPush(connMsg: PBConnMsg): void {
    const { head, data } = connMsg;

    this.log.debug("received push", { head });

    if (head.needAck) {
      const ack = buildPushAck(head);
      if (ack) {
        this.sendBinary(ack);
        this.log.debug(`ACK sent: cmd=${head.cmd}, msgId=${head.msgId}`);
      }
    }

    if (head.cmd === CMD.Kickout) {
      const kickout = decodePB(PB_MSG_TYPES.KickoutMsg, data) as PBKickoutMsg | null;
      this.log.warn("kicked out", { kickout });
      this.callbacks.onKickout?.({
        status: kickout?.status || 0,
        reason: kickout?.reason || "",
        otherDeviceName: kickout?.otherDeviceName,
      });
      return;
    }

    const pushMsg = decodePB(PB_MSG_TYPES.PushMsg, data) as PBPushMsg | null;
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

    const directed = decodePB(PB_MSG_TYPES.DirectedPush, data) as PBDirectedPush | null;
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

    this.callbacks.onDispatch?.({
      cmd: head.cmd,
      module: head.module,
      msgId: head.msgId,
      rawData: data,
    });
  }

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

    if (data && data.length > 0) {
      const decoder = pending.decoder ?? decodeSendMessageRsp;
      const rsp = decoder(data, msgId) as Record<string, unknown> | null;
      this.log.debug("business response decoded", { rsp });
      if (rsp) {
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
      this.setState("disconnected");
      this.callbacks.onError?.(
        new Error(`Max reconnect attempts (${this.clientConfig.maxReconnectAttempts}) exceeded`),
      );
      return;
    }
    const delay = customDelay ?? this.getReconnectDelay();
    this.reconnectAttempts++;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) {
        this.doConnect();
      }
    }, delay);
  }

  private setState(next: WsClientState): void {
    if (this.state !== next) {
      this.state = next;
      this.callbacks.onStateChange?.(next);
    }
  }

  private closeCurrentWs(): void {
    this.stopHeartbeat();
    if (!this.ws) {
      return;
    }
    try {
      this.ws.removeAllListeners();
      this.ws.on("error", () => {});
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "client closing");
      }
    } catch {
      /* ignore */
    }
    this.ws = null;
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
      pending.resolve({ msgId, code: -1, message: "Client disconnected" });
    }
    this.pendingRequests.clear();
    this.setState("disconnected");
  }
}
