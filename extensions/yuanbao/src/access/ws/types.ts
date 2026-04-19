/**
 * WebSocket module type definitions
 *
 * Based on the Yuanbao long-connection ConnMsg protobuf protocol,
 * adapted for the Tencent IM (YuanBao) scenario.
 */

import type { YuanbaoMsgBodyElement } from "../../types.js";

/** WebSocket connection configuration */
export type WsConnectionConfig = {
  /** WebSocket gateway URL */
  gatewayUrl: string;
  /** Authentication info */
  auth: {
    /** Business tenant ID (e.g. "yuanbao") */
    bizId: string;
    /** User UID */
    uid: string;
    /** Source (app / web / miniprogram) */
    source: string;
    /** Auth token */
    token: string;
    /** Internal routing environment identifier */
    routeEnv?: string;
  };
};

/** WebSocket client configuration */
export type WsClientConfig = {
  /** Max reconnect attempts (default 100) */
  maxReconnectAttempts?: number;
  /** Custom reconnect delay sequence (ms); values are used in order, last one repeats */
  reconnectDelays?: number[];
};

/** Client state */
export type WsClientState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";

// --- Client event callbacks ---

/** Auth success event data */
export type WsAuthBindResult = {
  connectId: string;
  timestamp: number;
  clientIp: string;
};

/** Client event callbacks */
export type WsClientCallbacks = {
  onReady?: (data: WsAuthBindResult) => void;
  onDispatch?: (pushData: WsPushEvent) => void;
  onStateChange?: (state: WsClientState) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
  onKickout?: (data: { status: number; reason: string; otherDeviceName?: string }) => void;
  onAuthFailed?: (code: number) => Promise<WsConnectionConfig["auth"] | null>;
};

/** Business push event (from DirectedPush or PushMsg) */
export type WsPushEvent = {
  type?: number;
  content?: string;
  cmd?: string;
  module?: string;
  msgId?: string;
  rawData?: Uint8Array;
  connData?: Uint8Array;
};

/** C2C message send request */
export type WsSendC2CMessageData = {
  to_account: string;
  msg_body: YuanbaoMsgBodyElement[];
  from_account?: string;
  msg_id?: string;
  msg_random?: number;
  group_code?: string;
  msg_seq?: number | string;
  trace_id?: string;
};

/** Group message send request */
export type WsSendGroupMessageData = {
  group_code: string;
  msg_body: YuanbaoMsgBodyElement[];
  from_account?: string;
  to_account?: string;
  msg_id?: string;
  random?: string;
  ref_msg_id?: string;
  msg_seq?: number | string;
  trace_id?: string;
};

/** Union type for outbound message requests */
export type WsOutboundMessageData = WsSendC2CMessageData | WsSendGroupMessageData;

/** Reply-status heartbeat enum values (matches EnumHeartbeat) */
export const WS_HEARTBEAT = {
  UNKNOWN: 0,
  RUNNING: 1,
  FINISH: 2,
} as const;

/** Reply-status heartbeat enum type */
export type WsHeartbeatValue = (typeof WS_HEARTBEAT)[keyof typeof WS_HEARTBEAT];

/** Server response for a business request */
export type WsSendMessageResponse = {
  msgId: string;
  code: number;
  message: string;
};

/** Query group info request */
export type WsQueryGroupInfoData = {
  group_code: string;
};

/** Group info */
export type WsGroupInfo = {
  group_name: string;
  group_owner_user_id: string;
  group_owner_nickname: string;
  group_size: number;
};

/** Query group info response */
export type WsQueryGroupInfoResponse = {
  msgId: string;
  code: number;
  msg: string;
  group_info?: WsGroupInfo;
};

/** Get group member list request */
export type WsGetGroupMemberListData = {
  group_code: string;
};

/** Group member info */
export type WsGroupMember = {
  user_id: string;
  nick_name: string;
  user_type: number;
};

/** Get group member list response */
export type WsGetGroupMemberListResponse = {
  msgId: string;
  code: number;
  message: string;
  member_list: WsGroupMember[];
};

/** Direct chat reply-status heartbeat request */
export type WsSendPrivateHeartbeatData = {
  from_account: string;
  to_account: string;
  heartbeat: WsHeartbeatValue;
};

/** Group chat reply-status heartbeat request */
export type WsSendGroupHeartbeatData = {
  from_account: string;
  to_account: string;
  group_code: string;
  send_time: number;
  heartbeat: WsHeartbeatValue;
};

/** Reply-status heartbeat response */
export type WsHeartbeatResponse = {
  msgId: string;
  code: number;
  msg?: string;
  message?: string;
};

/** SyncInformation command item */
export type WsSyncCommand = {
  name: string;
  description: string;
};

/** SyncInformation command data (sync_type=1) */
export type WsSyncCommandsData = {
  botCommands: WsSyncCommand[];
  pluginCommands: WsSyncCommand[];
};

/** SyncInformation request data */
export type WsSyncInformationData = {
  syncType: number;
  botVersion: string;
  pluginVersion: string;
  commandData?: WsSyncCommandsData;
};

/** SyncInformation response */
export type WsSyncInformationResponse = {
  msgId: string;
  code: number;
  msg: string;
};
