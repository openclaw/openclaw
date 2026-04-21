import type { YuanbaoMsgBodyElement } from "../../types.js";

export type WsConnectionConfig = {
  gatewayUrl: string;
  auth: {
    /** e.g. "yuanbao" */
    bizId: string;
    uid: string;
    /** app / web / miniprogram */
    source: string;
    token: string;
    routeEnv?: string;
  };
};

export type WsClientConfig = {
  /** Default 100 */
  maxReconnectAttempts?: number;
  /** Values are used in order, last one repeats */
  reconnectDelays?: number[];
};

export type WsClientState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";

export type WsAuthBindResult = {
  connectId: string;
  timestamp: number;
  clientIp: string;
};

export type WsClientCallbacks = {
  onReady?: (data: WsAuthBindResult) => void;
  onDispatch?: (pushData: WsPushEvent) => void;
  onStateChange?: (state: WsClientState) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
  onKickout?: (data: { status: number; reason: string; otherDeviceName?: string }) => void;
  onAuthFailed?: (code: number) => Promise<WsConnectionConfig["auth"] | null>;
};

export type WsPushEvent = {
  type?: number;
  content?: string;
  cmd?: string;
  module?: string;
  msgId?: string;
  rawData?: Uint8Array;
  connData?: Uint8Array;
};

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

export type WsOutboundMessageData = WsSendC2CMessageData | WsSendGroupMessageData;

export const WS_HEARTBEAT = {
  UNKNOWN: 0,
  RUNNING: 1,
  FINISH: 2,
} as const;

export type WsHeartbeatValue = (typeof WS_HEARTBEAT)[keyof typeof WS_HEARTBEAT];

export type WsSendMessageResponse = {
  msgId: string;
  code: number;
  message: string;
};

export type WsQueryGroupInfoData = {
  group_code: string;
};

export type WsGroupInfo = {
  group_name: string;
  group_owner_user_id: string;
  group_owner_nickname: string;
  group_size: number;
};

export type WsQueryGroupInfoResponse = {
  msgId: string;
  code: number;
  msg: string;
  group_info?: WsGroupInfo;
};

export type WsGetGroupMemberListData = {
  group_code: string;
};

export type WsGroupMember = {
  user_id: string;
  nick_name: string;
  user_type: number;
};

export type WsGetGroupMemberListResponse = {
  msgId: string;
  code: number;
  message: string;
  member_list: WsGroupMember[];
};

export type WsSendPrivateHeartbeatData = {
  from_account: string;
  to_account: string;
  heartbeat: WsHeartbeatValue;
};

export type WsSendGroupHeartbeatData = {
  from_account: string;
  to_account: string;
  group_code: string;
  send_time: number;
  heartbeat: WsHeartbeatValue;
};

export type WsHeartbeatResponse = {
  msgId: string;
  code: number;
  msg?: string;
  message?: string;
};
