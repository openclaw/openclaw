/**
 * WebSocket 模块类型定义
 *
 * 基于元宝长连接 ConnMsg protobuf 协议，
 * 适配腾讯云 IM（YuanBao）场景。
 */

import type { YuanbaoMsgBodyElement } from "../../types.js";

// ============ 连接配置 ============

/** WebSocket 连接配置 */
export type WsConnectionConfig = {
  /** WebSocket 网关地址 */
  gatewayUrl: string;
  /** 鉴权信息 */
  auth: {
    /** 业务租户 ID（如 "yuanbao"） */
    bizId: string;
    /** 用户 UID */
    uid: string;
    /** 来源（app/web/miniprogram） */
    source: string;
    /** 鉴权 token */
    token: string;
    /** Internal routing environment identifier */
    routeEnv?: string;
  };
};

/** WebSocket client configuration */
export type WsClientConfig = {
  /** 最大重连次数（Default 100） */
  maxReconnectAttempts?: number;
  /** 自定义重连延迟序列（毫秒），依次使用，超出则使用最后一个 */
  reconnectDelays?: number[];
};

// ============ 客户端状态 ============

/** 客户端状态 */
export type WsClientState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";

// ============ 客户端事件回调 ============

/** 鉴权成功事件数据 */
export type WsAuthBindResult = {
  /** 连接 ID */
  connectId: string;
  /** 服务端时间戳 */
  timestamp: number;
  /** 客户端 IP */
  clientIp: string;
};

/** 客户端事件回调 */
export type WsClientCallbacks = {
  /** 鉴权成功，连接就绪 */
  onReady?: (data: WsAuthBindResult) => void;
  /** 收到业务推送（DirectedPush 或 PushMsg） */
  onDispatch?: (pushData: WsPushEvent) => void;
  /** 连接状态变更 */
  onStateChange?: (state: WsClientState) => void;
  /** 发生错误 */
  onError?: (error: Error) => void;
  /** 连接关闭 */
  onClose?: (code: number, reason: string) => void;
  /** 被踢下线 */
  onKickout?: (data: { status: number; reason: string; otherDeviceName?: string }) => void;
  /**
   * WS 鉴权失败（错误码 41103/41104/41108），token 可能已过期。
   * 回调应重新签票并返回新的鉴权信息，客户端会用新 token 自动重连。
   * 如果回调返回 null 或抛出异常，则放弃重连。
   */
  onAuthFailed?: (code: number) => Promise<WsConnectionConfig["auth"] | null>;
};

// ============ 推送事件 ============

/** 业务推送事件（来自 DirectedPush 或 PushMsg） */
export type WsPushEvent = {
  /** 推送类型（DirectedPush.type） */
  type?: number;
  /** 推送内容（DirectedPush.content，可能是 JSON 字符串） */
  content?: string;
  /** 推送命令字（PushMsg.cmd） */
  cmd?: string;
  /** 推送模块名（PushMsg.module） */
  module?: string;
  /** 推送消息 ID（PushMsg.msgId） */
  msgId?: string;
  /** 原始 data bytes（PushMsg.data） */
  rawData?: Uint8Array;
  /** 完整的 ConnMsg.data bytes，当 rawData 解码失败时可作为 fallback */
  connData?: Uint8Array;
};

// ============ 出站Message type ============

/** C2C 消息发送请求 */
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

/** 群消息发送请求 */
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

/** 出站消息请求联合类型 */
export type WsOutboundMessageData = WsSendC2CMessageData | WsSendGroupMessageData;

/** 回复状态心跳枚举值（与 EnumHeartbeat 保持一致） */
export const WS_HEARTBEAT = {
  UNKNOWN: 0,
  RUNNING: 1,
  FINISH: 2,
} as const;

/** 回复状态心跳枚举值类型 */
export type WsHeartbeatValue = (typeof WS_HEARTBEAT)[keyof typeof WS_HEARTBEAT];

/** 服务端对业务请求的响应 */
export type WsSendMessageResponse = {
  /** 请求匹配用的 msgId */
  msgId: string;
  /** 响应码（0=成功） */
  code: number;
  /** 响应信息 */
  message: string;
};

// ============ QueryGroupInfo ============

/** Query group info请求 */
export type WsQueryGroupInfoData = {
  group_code: string;
};

/** 群信息 */
export type WsGroupInfo = {
  group_name: string;
  group_owner_user_id: string;
  group_owner_nickname: string;
  group_size: number;
};

/** Query group info响应 */
export type WsQueryGroupInfoResponse = {
  /** 请求匹配用的 msgId */
  msgId: string;
  /** 响应码（0=成功） */
  code: number;
  /** 响应信息 */
  msg: string;
  /** 群信息（成功时存在） */
  group_info?: WsGroupInfo;
};

// ============ GetGroupMemberList ============

/** Get group member list请求 */
export type WsGetGroupMemberListData = {
  group_code: string;
};

/** 群成员信息 */
export type WsGroupMember = {
  user_id: string;
  nick_name: string;
  user_type: number;
};

/** Get group member list响应 */
export type WsGetGroupMemberListResponse = {
  /** 请求匹配用的 msgId */
  msgId: string;
  /** 响应码（0=成功） */
  code: number;
  /** 响应信息 */
  message: string;
  /** 成员列表 */
  member_list: WsGroupMember[];
};

// ============ Reply Heartbeat ============

/** 私聊回复状态心跳请求 */
export type WsSendPrivateHeartbeatData = {
  from_account: string;
  to_account: string;
  heartbeat: WsHeartbeatValue;
};

/** 群聊回复状态心跳请求 */
export type WsSendGroupHeartbeatData = {
  from_account: string;
  to_account: string;
  group_code: string;
  send_time: number;
  heartbeat: WsHeartbeatValue;
};

/** 回复状态心跳响应 */
export type WsHeartbeatResponse = {
  msgId: string;
  code: number;
  msg?: string;
  message?: string;
};

// ============ SyncInformation ============

/** SyncInformation 命令项 */
export type WsSyncCommand = {
  name: string;
  description: string;
};

/** SyncInformation 命令数据（sync_type=1） */
export type WsSyncCommandsData = {
  botCommands: WsSyncCommand[];
  pluginCommands: WsSyncCommand[];
};

/** SyncInformation 请求数据 */
export type WsSyncInformationData = {
  syncType: number;
  botVersion: string;
  pluginVersion: string;
  commandData?: WsSyncCommandsData;
};

/** SyncInformation 响应 */
export type WsSyncInformationResponse = {
  msgId: string;
  code: number;
  msg: string;
};
