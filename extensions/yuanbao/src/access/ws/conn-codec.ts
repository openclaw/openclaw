/**
 * 连接层 Protobuf 编解码
 *
 * 基于 protobufjs 加载 conn.json Description文件，
 * 提供 ConnMsg 协议的编码/解码能力。
 */

import protobuf from "protobufjs";
import { createLog } from "../../logger.js";
import jsonDescriptor from "./proto/conn.json" with { type: "json" };

// ============ Root 缓存 ============

let root: protobuf.Root | null = null;

function getRoot(): protobuf.Root {
  if (!root) {
    root = protobuf.Root.fromJSON(jsonDescriptor);
  }
  return root;
}

// ============ 公共编解码 ============

/**
 * 编码 protobuf 消息
 * @param key - Message type全路径，如 "trpc.yuanbao.conn_common.ConnMsg"
 * @param value - 要编码的对象
 * @returns 编码后的 Uint8Array，失败返回 null
 */
export function encodePB(key: string, value: Record<string, unknown>): Uint8Array | null {
  try {
    const type = getRoot().lookupType(key);
    const message = type.create(value);
    return type.encode(message).finish();
  } catch (error: unknown) {
    const log = createLog("conn-codec");
    log.error("encode failed", { key, error: (error as Error).message });
    return null;
  }
}

/**
 * 解码 protobuf 消息
 * @param key - Message type全路径
 * @param data - 二进制数据
 * @returns 解码后的对象，失败返回 null
 */
export function decodePB<T = Record<string, unknown>>(key: string, data: Uint8Array | ArrayBuffer): T | null {
  try {
    const type = getRoot().lookupType(key);
    return type.decode(data instanceof Uint8Array ? data : new Uint8Array(data)) as unknown as T;
  } catch {
    // 解码失败是可预期的（数据可能不匹配该Message type），静默返回 null 走兜底逻辑
    return null;
  }
}

// ============ ConnMsg 协议常量 ============

export const PB_MSG_TYPES = {
  /** ConnMsg 外层消息 */
  ConnMsg: "trpc.yuanbao.conn_common.ConnMsg",
  /** 鉴权请求 */
  AuthBindReq: "trpc.yuanbao.conn_common.AuthBindReq",
  /** 鉴权响应 */
  AuthBindRsp: "trpc.yuanbao.conn_common.AuthBindRsp",
  /** 心跳请求 */
  PingReq: "trpc.yuanbao.conn_common.PingReq",
  /** 心跳响应 */
  PingRsp: "trpc.yuanbao.conn_common.PingRsp",
  /** 踢下线消息 */
  KickoutMsg: "trpc.yuanbao.conn_common.KickoutMsg",
  /** 推送消息 */
  DirectedPush: "trpc.yuanbao.conn_common.DirectedPush",
  /** 业务推送消息 */
  PushMsg: "trpc.yuanbao.conn_common.PushMsg",
} as const;

/** ConnMsg.Head.cmdType 枚举 */
export const CMD_TYPE = {
  /** 上行请求 */
  Request: 0,
  /** 上行请求的回包 */
  Response: 1,
  /** 下行推送 */
  Push: 2,
  /** 下行推送的回包（ACK） */
  PushAck: 3,
} as const;

/** 内置命令字 */
export const CMD = {
  AuthBind: "auth-bind",
  Ping: "ping",
  Kickout: "kickout",
  UpdateMeta: "update-meta",
} as const;

/** 内置模块名 */
export const MODULE = {
  ConnAccess: "conn_access",
} as const;

// ============ Head / ConnMsg 类型 ============

export type PBHead = {
  cmdType: number;
  cmd: string;
  seqNo: number;
  msgId: string;
  module: string;
  needAck?: boolean;
  status?: number;
};

export type PBConnMsg = {
  head: PBHead;
  data: Uint8Array;
};

// ============ 序列号生成 ============

let seqCounter = 0;

/** 序列号最大精度 */
const SEQ_NO_OVERFLOW_RESET = Number.MAX_SAFE_INTEGER;

/**
 * Generate the next incrementing sequence number.
 * 接近 Number.MAX_SAFE_INTEGER 时自动重置为 0，避免精度问题。
 * @returns 新的序列号
 */
export function nextSeqNo(): number {
  const next = seqCounter++;
  if (next >= SEQ_NO_OVERFLOW_RESET) {
    return 0;
  }
  return next;
}

// ============ 消息构造辅助 ============

/**
 * 构造一个 ConnMsg Head
 * @param cmd - 命令字
 * @param module - 模块名
 * @param msgId - 消息唯一标识
 * @returns 协议头对象
 */
export function createHead(cmd: string, module: string, msgId: string): PBHead {
  return {
    cmdType: CMD_TYPE.Request,
    cmd,
    seqNo: nextSeqNo(),
    msgId,
    module,
  };
}

/**
 * 编码一个完整的 ConnMsg（head + data）为二进制
 * @param head - 协议头
 * @param innerData - 内层 data 的二进制数据（已编码的业务 payload）
 * @returns 编码后的 Uint8Array，失败返回 null
 */
export function encodeConnMsg(head: PBHead, innerData: Uint8Array | null): Uint8Array | null {
  return encodePB(PB_MSG_TYPES.ConnMsg, {
    head,
    data: innerData ?? new Uint8Array(0),
  });
}

/**
 * 解码一个 ConnMsg 二进制帧
 * @param raw - 原始二进制数据
 * @returns 解码后的 ConnMsg 对象，失败返回 null
 */
export function decodeConnMsg(raw: Uint8Array | ArrayBuffer): PBConnMsg | null {
  return decodePB(PB_MSG_TYPES.ConnMsg, raw) as PBConnMsg | null;
}

// openclaw 使用的 instance_id
const OPENCLAW_ID = 16;

interface AuthBindParams {
  bizId: string;
  uid: string;
  source: string;
  token: string;
  msgId: string;
  /** Internal routing environment identifier */
  routeEnv?: string;
  /** 当前Plugin version number */
  appVersion: string;
  /** 当前操作系统 */
  operationSystem: string;
  /** openclaw 版本号 */
  botVersion: string;
}

/**
 * 构造 auth-bind 请求二进制帧
 * @param params - 鉴权参数（bizId, uid, source, token, msgId）
 * @returns 编码后的二进制帧，失败返回 null
 */
export function buildAuthBindMsg(params: AuthBindParams): Uint8Array | null {
  const authBindPayload: Record<string, unknown> = {
    bizId: params.bizId,
    authInfo: {
      uid: params.uid,
      source: params.source,
      token: params.token,
    },
    deviceInfo: {
      appVersion: params.appVersion,
      appOperationSystem: params.operationSystem,
      botVersion: params.botVersion,
      instanceId: String(OPENCLAW_ID),
    },
  };
  if (params.routeEnv) {
    authBindPayload.envName = params.routeEnv;
  }

  const authBindData = encodePB(PB_MSG_TYPES.AuthBindReq, authBindPayload);
  if (!authBindData) {
    return null;
  }

  const head = createHead(CMD.AuthBind, MODULE.ConnAccess, params.msgId);
  return encodeConnMsg(head, authBindData);
}

/**
 * 构造 ping 请求二进制帧
 * @param msgId - 消息唯一标识
 * @returns 编码后的二进制帧，失败返回 null
 */
export function buildPingMsg(msgId: string): Uint8Array | null {
  const pingData = encodePB(PB_MSG_TYPES.PingReq, {});
  if (!pingData) {
    return null;
  }

  const head = createHead(CMD.Ping, MODULE.ConnAccess, msgId);
  return encodeConnMsg(head, pingData);
}

/**
 * 构造 push ACK 回包
 * @param originalHead - 原始推送消息的协议头
 * @returns 编码后的 ACK 二进制帧，失败返回 null
 */
export function buildPushAck(originalHead: PBHead): Uint8Array | null {
  const ackHead: PBHead = {
    ...originalHead,
    cmdType: CMD_TYPE.PushAck,
    seqNo: nextSeqNo(),
  };
  return encodeConnMsg(ackHead, null);
}

/**
 * 构造业务请求 ConnMsg
 * @param cmd - 命令字（如 "/im/send_c2c_msg"）
 * @param module - 模块名
 * @param bizData - 已编码的业务 payload（Uint8Array）
 * @param msgId - 消息 ID
 * @returns 编码后的二进制帧，失败返回 null
 */
export function buildBusinessConnMsg(
  cmd: string,
  module: string,
  bizData: Uint8Array,
  msgId: string,
): Uint8Array | null {
  const head = createHead(cmd, module, msgId);
  return encodeConnMsg(head, bizData);
}
