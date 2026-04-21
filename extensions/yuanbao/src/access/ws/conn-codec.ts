import protobuf from "protobufjs";
import { createLog } from "../../logger.js";
import jsonDescriptor from "./proto/conn.json" with { type: "json" };

let root: protobuf.Root | null = null;

function getRoot(): protobuf.Root {
  if (!root) {
    root = protobuf.Root.fromJSON(jsonDescriptor);
  }
  return root;
}

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

export function decodePB(key: string, data: Uint8Array | ArrayBuffer): unknown {
  try {
    const type = getRoot().lookupType(key);
    return type.decode(data instanceof Uint8Array ? data : new Uint8Array(data));
  } catch {
    return null;
  }
}

export const PB_MSG_TYPES = {
  ConnMsg: "trpc.yuanbao.conn_common.ConnMsg",
  AuthBindReq: "trpc.yuanbao.conn_common.AuthBindReq",
  AuthBindRsp: "trpc.yuanbao.conn_common.AuthBindRsp",
  PingReq: "trpc.yuanbao.conn_common.PingReq",
  PingRsp: "trpc.yuanbao.conn_common.PingRsp",
  KickoutMsg: "trpc.yuanbao.conn_common.KickoutMsg",
  DirectedPush: "trpc.yuanbao.conn_common.DirectedPush",
  PushMsg: "trpc.yuanbao.conn_common.PushMsg",
} as const;

export const CMD_TYPE = {
  Request: 0,
  Response: 1,
  Push: 2,
  PushAck: 3,
} as const;

export const CMD = {
  AuthBind: "auth-bind",
  Ping: "ping",
  Kickout: "kickout",
  UpdateMeta: "update-meta",
} as const;

export const MODULE = {
  ConnAccess: "conn_access",
} as const;

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

let seqCounter = 0;
const SEQ_NO_OVERFLOW_RESET = Number.MAX_SAFE_INTEGER;

export function nextSeqNo(): number {
  const next = seqCounter++;
  if (next >= SEQ_NO_OVERFLOW_RESET) {
    return 0;
  }
  return next;
}

export function createHead(cmd: string, module: string, msgId: string): PBHead {
  return {
    cmdType: CMD_TYPE.Request,
    cmd,
    seqNo: nextSeqNo(),
    msgId,
    module,
  };
}

export function encodeConnMsg(head: PBHead, innerData: Uint8Array | null): Uint8Array | null {
  return encodePB(PB_MSG_TYPES.ConnMsg, {
    head,
    data: innerData ?? new Uint8Array(0),
  });
}

export function decodeConnMsg(raw: Uint8Array | ArrayBuffer): PBConnMsg | null {
  return decodePB(PB_MSG_TYPES.ConnMsg, raw) as PBConnMsg | null;
}

const OPENCLAW_ID = 16;

interface AuthBindParams {
  bizId: string;
  uid: string;
  source: string;
  token: string;
  msgId: string;
  routeEnv?: string;
  appVersion: string;
  operationSystem: string;
  botVersion: string;
}

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

export function buildPingMsg(msgId: string): Uint8Array | null {
  const pingData = encodePB(PB_MSG_TYPES.PingReq, {});
  if (!pingData) {
    return null;
  }

  const head = createHead(CMD.Ping, MODULE.ConnAccess, msgId);
  return encodeConnMsg(head, pingData);
}

export function buildPushAck(originalHead: PBHead): Uint8Array | null {
  const ackHead: PBHead = {
    ...originalHead,
    cmdType: CMD_TYPE.PushAck,
    seqNo: nextSeqNo(),
  };
  return encodeConnMsg(ackHead, null);
}

export function buildBusinessConnMsg(
  cmd: string,
  module: string,
  bizData: Uint8Array,
  msgId: string,
): Uint8Array | null {
  const head = createHead(cmd, module, msgId);
  return encodeConnMsg(head, bizData);
}
