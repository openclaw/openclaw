/**
 * Connection-layer Protobuf codec
 *
 * Loads the conn.json descriptor via protobufjs and provides
 * encode / decode helpers for the ConnMsg wire protocol.
 */

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

/**
 * Encode a protobuf message.
 * @param key - Fully-qualified message type, e.g. "trpc.yuanbao.conn_common.ConnMsg"
 * @param value - Object to encode
 * @returns Encoded Uint8Array, or null on failure
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
 * Decode a protobuf message.
 */
export function decodePB(key: string, data: Uint8Array | ArrayBuffer): unknown {
  try {
    const type = getRoot().lookupType(key);
    return type.decode(data instanceof Uint8Array ? data : new Uint8Array(data));
  } catch {
    // Decode failure is expected when data doesn't match the message type; silently return null.
    return null;
  }
}

export const PB_MSG_TYPES = {
  /** Outer ConnMsg wrapper */
  ConnMsg: "trpc.yuanbao.conn_common.ConnMsg",
  /** Auth request */
  AuthBindReq: "trpc.yuanbao.conn_common.AuthBindReq",
  /** Auth response */
  AuthBindRsp: "trpc.yuanbao.conn_common.AuthBindRsp",
  /** Heartbeat request */
  PingReq: "trpc.yuanbao.conn_common.PingReq",
  /** Heartbeat response */
  PingRsp: "trpc.yuanbao.conn_common.PingRsp",
  /** Kickout notification */
  KickoutMsg: "trpc.yuanbao.conn_common.KickoutMsg",
  /** Directed push */
  DirectedPush: "trpc.yuanbao.conn_common.DirectedPush",
  /** Business push */
  PushMsg: "trpc.yuanbao.conn_common.PushMsg",
} as const;

/** ConnMsg.Head.cmdType enum */
export const CMD_TYPE = {
  /** Upstream request */
  Request: 0,
  /** Response to an upstream request */
  Response: 1,
  /** Downstream push */
  Push: 2,
  /** ACK for a downstream push */
  PushAck: 3,
} as const;

/** Built-in command names */
export const CMD = {
  AuthBind: "auth-bind",
  Ping: "ping",
  Kickout: "kickout",
  UpdateMeta: "update-meta",
} as const;

/** Built-in module names */
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

/** Maximum safe sequence number before overflow */
const SEQ_NO_OVERFLOW_RESET = Number.MAX_SAFE_INTEGER;

/**
 * Generate the next incrementing sequence number.
 * Resets to 0 when approaching Number.MAX_SAFE_INTEGER to avoid precision loss.
 */
export function nextSeqNo(): number {
  const next = seqCounter++;
  if (next >= SEQ_NO_OVERFLOW_RESET) {
    return 0;
  }
  return next;
}

// --- Message construction helpers ---

/**
 * Build a ConnMsg head.
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
 * Encode a complete ConnMsg (head + data) into binary.
 */
export function encodeConnMsg(head: PBHead, innerData: Uint8Array | null): Uint8Array | null {
  return encodePB(PB_MSG_TYPES.ConnMsg, {
    head,
    data: innerData ?? new Uint8Array(0),
  });
}

/**
 * Decode a ConnMsg binary frame.
 */
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
  /** Internal routing environment identifier */
  routeEnv?: string;
  /** Current plugin version */
  appVersion: string;
  /** Current operating system */
  operationSystem: string;
  /** openclaw version */
  botVersion: string;
}

/**
 * Build an auth-bind request binary frame.
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
 * Build a ping request binary frame.
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
 * Build a push ACK response.
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
 * Build a business request ConnMsg.
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
