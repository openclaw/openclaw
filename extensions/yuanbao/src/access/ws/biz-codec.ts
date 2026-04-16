/**
 * 业务层 Protobuf 编解码
 *
 * 基于 protobufjs 加载 biz.json Description文件，
 * 提供入站/出站业务消息的 protobuf 编解码能力。
 * 处理 PascalCase (TS) <-> camelCase (protobufjs) 字段名映射。
 */

import protobuf from "protobufjs";
import { createLog } from "../../logger.js";
import type {
  YuanbaoInboundMessage,
  YuanbaoLogInfoExt,
  YuanbaoMsgBodyElement,
} from "../../types.js";
import bizDescriptor from "./proto/biz.json" with { type: "json" };
import type {
  WsSendC2CMessageData,
  WsSendGroupMessageData,
  WsSendMessageResponse,
  WsSendPrivateHeartbeatData,
  WsSendGroupHeartbeatData,
  WsHeartbeatResponse,
  WsQueryGroupInfoData,
  WsQueryGroupInfoResponse,
  WsGetGroupMemberListData,
  WsGetGroupMemberListResponse,
  WsSyncInformationData,
  WsSyncInformationResponse,
} from "./types.js";

// 模块级Logger instance

// ============ Root 缓存 ============

let root: protobuf.Root | null = null;

function getRoot(): protobuf.Root {
  if (!root) {
    root = protobuf.Root.fromJSON(bizDescriptor);
  }
  return root;
}

// ============ 通用编解码 ============

const PKG = "trpc.yuanbao.yuanbao_conn.yuanbao_openclaw_proxy";

export const BIZ_MSG_TYPES = {
  MsgContent: `${PKG}.MsgContent`,
  MsgBodyElement: `${PKG}.MsgBodyElement`,
  InboundMessagePush: `${PKG}.InboundMessagePush`,
  SendC2CMessageReq: `${PKG}.SendC2CMessageReq`,
  SendGroupMessageReq: `${PKG}.SendGroupMessageReq`,
  SendC2CMessageRsp: `${PKG}.SendC2CMessageRsp`,
  SendGroupMessageRsp: `${PKG}.SendGroupMessageRsp`,
  QueryGroupInfoReq: `${PKG}.QueryGroupInfoReq`,
  QueryGroupInfoRsp: `${PKG}.QueryGroupInfoRsp`,
  GetGroupMemberListReq: `${PKG}.GetGroupMemberListReq`,
  GetGroupMemberListRsp: `${PKG}.GetGroupMemberListRsp`,
  SendPrivateHeartbeatReq: `${PKG}.SendPrivateHeartbeatReq`,
  SendPrivateHeartbeatRsp: `${PKG}.SendPrivateHeartbeatRsp`,
  SendGroupHeartbeatReq: `${PKG}.SendGroupHeartbeatReq`,
  SendGroupHeartbeatRsp: `${PKG}.SendGroupHeartbeatRsp`,
  SyncInformationReq: `${PKG}.SyncInformationReq`,
  SyncInformationRsp: `${PKG}.SyncInformationRsp`,
} as const;

/**
 * 编码业务层 protobuf 消息
 * @param key - protobuf Message type全路径
 * @param value - 待编码的数据对象
 * @returns 编码后的 Uint8Array，失败返回 null
 */
export function encodeBizPB(key: string, value: Record<string, unknown>): Uint8Array | null {
  try {
    const type = getRoot().lookupType(key);
    const message = type.create(value);
    return type.encode(message).finish();
  } catch (error: unknown) {
    const log = createLog("biz-codec");
    log.error("encode failed", { key, error: (error as Error).message });
    return null;
  }
}

/**
 * 解码业务层 protobuf 消息
 * @param key - protobuf Message type全路径
 * @param data - 二进制数据
 * @returns 解码后的对象，失败返回 null
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- protobuf 解码返回动态类型
export function decodeBizPB(key: string, data: Uint8Array | ArrayBuffer): any {
  try {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    const type = getRoot().lookupType(key);
    return type.decode(buf);
  } catch {
    // protobuf decode failure is expected (data may not match the message type), silently return null
    return null;
  }
}

// ============ MsgBodyElement 转换 ============

/**
 * 将 TS MsgBodyElement[] 转换为 protobuf 格式
 * 新协议：MsgContent 包含 text, uuid, imageFormat, data, desc, ext, sound, imageInfoArray, index, url, fileSize, fileName
 * @param elements - TS 格式的Message body元素数组
 * @returns protobuf 格式的Message body数组
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- protobuf 编码需要动态类型
export function toProtoMsgBody(elements: YuanbaoMsgBodyElement[]): any[] {
  return elements.map((el) => {
    const c = el.msg_content;
    return {
      msgType: el.msg_type,
      msgContent: {
        text: c.text,
        uuid: c.uuid,
        imageFormat: c.image_format,
        data: c.data,
        desc: c.desc,
        ext: c.ext,
        sound: c.sound,
        imageInfoArray: c.image_info_array,
        index: c.index,
        url: c.url,
        fileSize: c.file_size,
        fileName: c.file_name,
      },
    };
  });
}

/**
 * 将 protobuf 格式Message body转换回 TS MsgBodyElement[]
 * 新协议：将 protobuf camelCase 字段映射回 snake_case TS 字段
 * @param elements - protobuf 格式的Message body数组
 * @returns TS 格式的Message body元素数组
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- protobuf 解码返回动态类型
export function fromProtoMsgBody(elements: any[]): YuanbaoMsgBodyElement[] {
  if (!elements || !Array.isArray(elements)) {
    return [];
  }
  return elements.map((el) => {
    const mc = el.msgContent;
    const content: Record<string, unknown> = {};

    if (mc?.text) {
      content.text = mc.text;
    }
    if (mc?.uuid) {
      content.uuid = mc.uuid;
    }
    if (mc?.imageFormat) {
      content.image_format = mc.imageFormat;
    }
    if (mc?.data) {
      content.data = mc.data;
    }
    if (mc?.desc) {
      content.desc = mc.desc;
    }
    if (mc?.ext) {
      content.ext = mc.ext;
    }
    if (mc?.sound) {
      content.sound = mc.sound;
    }
    if (mc?.imageInfoArray && mc.imageInfoArray.length > 0) {
      content.image_info_array = mc.imageInfoArray;
    }
    if (mc?.index) {
      content.index = mc.index;
    }
    if (mc?.url) {
      content.url = mc.url;
    }
    if (mc?.fileSize) {
      content.file_size = mc.fileSize;
    }
    if (mc?.fileName) {
      content.file_name = mc.fileName;
    }

    return {
      msg_type: el.msgType || "",
      msg_content: content,
    };
  });
}

function toProtoLogExt(
  logExt?: YuanbaoLogInfoExt,
  traceId?: string,
): { traceId: string } | undefined {
  const resolvedTraceId = traceId?.trim() || logExt?.trace_id?.trim();
  return resolvedTraceId ? { traceId: resolvedTraceId } : undefined;
}

// ============ 出站编码 ============

/**
 * 编码 C2C 发送消息请求
 * @param data - C2C 消息发送数据
 * @returns 编码后的二进制数据
 */
export function encodeSendC2CMessageReq(data: WsSendC2CMessageData): Uint8Array | null {
  const logExt = toProtoLogExt(undefined, data.trace_id);
  const log = createLog("biz-codec");
  log.debug("[msg-trace] encode c2c outbound", {
    traceId: data.trace_id ?? "(none)",
    msgSeq: data.msg_seq ?? "(none)",
    toAccount: data.to_account,
  });
  return encodeBizPB(BIZ_MSG_TYPES.SendC2CMessageReq, {
    msgId: data.msg_id ?? "",
    toAccount: data.to_account,
    fromAccount: data.from_account ?? "",
    groupCode: data.group_code ?? "",
    msgRandom: data.msg_random ?? 0,
    ...(data.msg_seq !== undefined ? { msgSeq: data.msg_seq } : {}),
    msgBody: toProtoMsgBody(data.msg_body),
    ...(logExt ? { logExt } : {}),
  });
}

/**
 * Encode group message send request
 * @param data - 群消息发送数据
 * @returns 编码后的二进制数据
 */
export function encodeSendGroupMessageReq(data: WsSendGroupMessageData): Uint8Array | null {
  const logExt = toProtoLogExt(undefined, data.trace_id);
  const log = createLog("biz-codec");
  log.debug("[msg-trace] encode group outbound", {
    traceId: data.trace_id ?? "(none)",
    msgSeq: data.msg_seq ?? "(none)",
    groupCode: data.group_code,
  });
  return encodeBizPB(BIZ_MSG_TYPES.SendGroupMessageReq, {
    msgId: data.msg_id ?? "",
    groupCode: data.group_code,
    fromAccount: data.from_account ?? "",
    toAccount: data.to_account ?? "",
    random: data.random ?? "",
    msgBody: toProtoMsgBody(data.msg_body),
    refMsgId: data.ref_msg_id ?? "",
    ...(data.msg_seq !== undefined ? { msgSeq: data.msg_seq } : {}),
    ...(logExt ? { logExt } : {}),
  });
}

/**
 * Encode direct chat reply status heartbeat request
 * @param data - 私聊心跳请求数据
 * @returns 编码后的二进制数据
 */
export function encodeSendPrivateHeartbeatReq(data: WsSendPrivateHeartbeatData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.SendPrivateHeartbeatReq, {
    // 双写 fromAccount/fromtAccount，兼容旧 descriptor 字段拼写
    fromAccount: data.from_account,
    fromtAccount: data.from_account,
    toAccount: data.to_account,
    heartbeat: data.heartbeat,
  });
}

/**
 * Encode group chat reply status heartbeat request
 * @param data - 群聊心跳请求数据
 * @returns 编码后的二进制数据
 */
export function encodeSendGroupHeartbeatReq(data: WsSendGroupHeartbeatData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.SendGroupHeartbeatReq, {
    fromAccount: data.from_account,
    toAccount: data.to_account,
    groupCode: data.group_code,
    sendTime: data.send_time,
    heartbeat: data.heartbeat,
  });
}

// ============ 入站解码 ============

/**
 * 解码入站消息 proto bytes -> YuanbaoInboundMessage
 * @param data - 二进制入站消息数据
 * @returns 解码后的入站消息对象，失败返回 null
 */
export function decodeInboundMessage(data: Uint8Array | ArrayBuffer): YuanbaoInboundMessage | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.InboundMessagePush, data);
  if (!decoded) {
    return null;
  }

  const msgBody = decoded.msgBody ? fromProtoMsgBody(decoded.msgBody) : undefined;
  const traceId = decoded.logExt?.traceId?.trim();
  const seqId =
    decoded.msgSeq !== undefined && decoded.msgSeq !== null ? String(decoded.msgSeq) : undefined;

  const log = createLog("biz-codec");
  log.debug("[msg-trace] decoded inbound", {
    traceId: traceId ?? "(none)",
    seqId: seqId ?? "(none)",
    from: decoded.fromAccount || "?",
    msgId: decoded.msgId || "?",
  });

  return {
    callback_command: decoded.callbackCommand || undefined,
    from_account: decoded.fromAccount || undefined,
    to_account: decoded.toAccount || undefined,
    sender_nickname: decoded.senderNickname || undefined,
    group_id: decoded.groupId || undefined,
    group_code: decoded.groupCode || undefined,
    group_name: decoded.groupName || undefined,
    msg_seq: decoded.msgSeq || undefined,
    msg_random: decoded.msgRandom || undefined,
    msg_time: decoded.msgTime || undefined,
    msg_key: decoded.msgKey || undefined,
    msg_id: decoded.msgId || undefined,
    msg_body: msgBody,
    cloud_custom_data: decoded.cloudCustomData || undefined,
    event_time: decoded.eventTime || undefined,
    bot_owner_id: decoded.botOwnerId || undefined,
    recall_msg_seq_list: decoded.recallMsgSeqList || undefined,
    claw_msg_type: decoded.clawMsgType || undefined,
    private_from_group_code: decoded.privateFromGroupCode || undefined,
    trace_id: traceId,
    seq_id: seqId,
  };
}

/**
 * 解码 C2C 出站响应 proto bytes -> WsSendMessageResponse
 * @param data - 二进制响应数据
 * @param msgId - 请求消息 ID，用于关联响应
 * @returns 解码后的响应对象，失败返回 null
 */
export function decodeSendC2CMessageRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsSendMessageResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.SendC2CMessageRsp, data);
  if (!decoded) {
    return null;
  }

  return {
    msgId,
    code: decoded.code || 0,
    message: decoded.message || "",
  };
}

/**
 * 解码群消息出站响应 proto bytes -> WsSendMessageResponse
 * @param data - 二进制响应数据
 * @param msgId - 请求消息 ID，用于关联响应
 * @returns 解码后的响应对象，失败返回 null
 */
export function decodeSendGroupMessageRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsSendMessageResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.SendGroupMessageRsp, data);
  if (!decoded) {
    return null;
  }

  return {
    msgId,
    code: decoded.code || 0,
    message: decoded.message || "",
  };
}

/**
 * 解码出站响应（兼容 C2C 和群消息，两者响应结构一致）
 * @param data - 二进制响应数据
 * @param msgId - 请求消息 ID，用于关联响应
 * @returns 解码后的响应对象，失败返回 null
 */
export function decodeSendMessageRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsSendMessageResponse | null {
  // C2C 和群消息的 Rsp 结构一致（code + message），优先尝试 C2C
  return decodeSendC2CMessageRsp(data, msgId) ?? decodeSendGroupMessageRsp(data, msgId);
}

// ============ QueryGroupInfo 编解码 ============

/**
 * Encode query group info request
 * @param data - Query group info请求数据
 * @returns 编码后的二进制数据
 */
export function encodeQueryGroupInfoReq(data: WsQueryGroupInfoData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.QueryGroupInfoReq, {
    groupCode: data.group_code,
  });
}

/**
 * 解码Query group info响应 proto bytes -> WsQueryGroupInfoResponse
 * @param data - 二进制响应数据
 * @param msgId - 请求消息 ID，用于关联响应
 * @returns 解码后的响应对象，失败返回 null
 */
export function decodeQueryGroupInfoRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsQueryGroupInfoResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.QueryGroupInfoRsp, data);
  if (!decoded) {
    return null;
  }

  const gi = decoded.groupInfo;

  return {
    msgId,
    code: decoded.code || 0,
    msg: decoded.msg || "",
    group_info: gi
      ? {
          group_name: gi.groupName || "",
          group_owner_user_id: gi.groupOwnerUserId || "",
          group_owner_nickname: gi.groupOwnerNickname || "",
          group_size: gi.groupSize || 0,
        }
      : undefined,
  };
}

// ============ GetGroupMemberList 编解码 ============

/**
 * Encode get group member list request
 * @param data - Get group member list请求数据
 * @returns 编码后的二进制数据
 */
export function encodeGetGroupMemberListReq(data: WsGetGroupMemberListData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.GetGroupMemberListReq, {
    groupCode: data.group_code,
  });
}

/**
 * 解码Get group member list响应 proto bytes -> WsGetGroupMemberListResponse
 * @param data - 二进制响应数据
 * @param msgId - 请求消息 ID，用于关联响应
 * @returns 解码后的响应对象，失败返回 null
 */
export function decodeGetGroupMemberListRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsGetGroupMemberListResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.GetGroupMemberListRsp, data);
  if (!decoded) {
    return null;
  }

  const memberList = Array.isArray(decoded.memberList)
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protobuf 解码返回动态类型
      decoded.memberList.map((m: any) => ({
        user_id: m.userId || "",
        nick_name: m.nickName || "",
        user_type: m.userType || 0,
      }))
    : [];

  return {
    msgId,
    code: decoded.code || 0,
    message: decoded.message || "",
    member_list: memberList,
  };
}

/**
 * Decode direct chat reply status heartbeat response.
 *
 * 该解码函数在心跳回包阶段将二进制 protobuf 数据转换为统一的
 * `WsHeartbeatResponse` 结构，并保留请求侧传入的 `msgId`，用于上层
 * Stably correlate requests and responses in concurrent scenarios, avoiding heartbeat result mismatches.
 *
 * @param data - 私聊心跳回包的原始二进制数据（`Uint8Array` 或 `ArrayBuffer`）。
 * @param msgId - 请求消息 ID，会透传到返回结果中用于请求-响应关联。
 * @returns 解码成功时返回 `WsHeartbeatResponse`；当数据无法按目标协议解码时返回 `null`。
 *
 * @example
 * ```typescript
 * const rsp = decodeSendPrivateHeartbeatRsp(binaryData, 'msg-123');
 * if (rsp) {
 *   console.log(rsp.msgId, rsp.code);
 * }
 * ```
 */
export function decodeSendPrivateHeartbeatRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsHeartbeatResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.SendPrivateHeartbeatRsp, data);
  if (!decoded) {
    return null;
  }
  return {
    msgId,
    code: decoded.code || 0,
    msg: decoded.msg || "",
    message: decoded.msg || "",
  };
}

/**
 * Decode group chat reply status heartbeat response.
 *
 * 该函数用于把群聊心跳回包从 protobuf 二进制格式映射到统一响应对象，
 * 并携带原始 `msgId` 返回给调用方，确保 WebSocket 请求等待队列能按
 * 消息 ID 正确完成匹配与收敛。
 *
 * @param data - 群聊心跳回包的原始二进制数据（`Uint8Array` 或 `ArrayBuffer`）。
 * @param msgId - 请求消息 ID，会透传到返回结果中用于请求-响应关联。
 * @returns 解码成功时返回 `WsHeartbeatResponse`；当解码失败时返回 `null`。
 *
 * @example
 * ```typescript
 * const rsp = decodeSendGroupHeartbeatRsp(binaryData, 'msg-456');
 * if (rsp && rsp.code === 0) {
 *   console.log('group heartbeat ok');
 * }
 * ```
 */
export function decodeSendGroupHeartbeatRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsHeartbeatResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.SendGroupHeartbeatRsp, data);
  if (!decoded) {
    return null;
  }
  return {
    msgId,
    code: decoded.code || 0,
    msg: decoded.msg || "",
    message: decoded.msg || "",
  };
}

// ============ SyncInformation 编解码 ============

/**
 * 编码 SyncInformationReq（同步命令列表等信息到后台）
 *
 * @param data - 同步信息请求数据
 * @returns 编码后的二进制数据
 */
export function encodeSyncInformationReq(data: WsSyncInformationData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.SyncInformationReq, {
    syncType: data.syncType,
    botVersion: data.botVersion,
    pluginVersion: data.pluginVersion,
    ...(data.commandData ? { commandData: data.commandData } : {}),
  });
}

/**
 * 解码 SyncInformationRsp
 *
 * @param data - 二进制响应数据
 * @param msgId - 请求消息 ID
 * @returns 解码后的响应对象，失败返回 null
 */
export function decodeSyncInformationRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsSyncInformationResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.SyncInformationRsp, data);
  if (!decoded) {
    return null;
  }
  return {
    msgId,
    code: decoded.code || 0,
    msg: decoded.msg || "",
  };
}
