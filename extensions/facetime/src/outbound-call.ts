import { isWhitelistedFaceTimeHandle, type FaceTimeCallStatusEvent } from "./call-events.js";

const FACETIME_DIAL_MODES = ["audio", "video"] as const;
export type FaceTimeDialMode = (typeof FACETIME_DIAL_MODES)[number];

export type FaceTimeDialRequest = {
  handle: string;
  mode: FaceTimeDialMode;
};

export type FaceTimeDialResult = FaceTimeDialRequest & {
  dialID: string;
  state: "pending" | "ringing";
  callUUID?: string;
  proxyIdentifier?: string;
  helper: Record<string, unknown>;
};

export type PendingFaceTimeDial = FaceTimeDialRequest & {
  dialID: string;
  delivery: "in-flight" | "accepted" | "ambiguous";
  requestedAt: string;
  callUUID?: string;
  callUUIDAliases?: Set<string>;
  proxyIdentifier?: string;
};

type FaceTimeOutboundIdentityEvent = {
  event: "ft-outbound-call-identified";
  data: {
    dial_id: string;
    call_uuid?: string;
    proxy_identifier?: string;
  };
};

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeFaceTimeOutboundIdentityEvent(
  value: unknown,
): FaceTimeOutboundIdentityEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.event !== "ft-outbound-call-identified") {
    return undefined;
  }
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  const dialID = readOptionalString(data.dial_id);
  if (!dialID) {
    return undefined;
  }
  const callUUID = readOptionalString(data.call_uuid);
  const proxyIdentifier = readOptionalString(data.proxy_identifier);
  if (!callUUID && !proxyIdentifier) {
    return undefined;
  }
  return {
    event: "ft-outbound-call-identified",
    data: {
      dial_id: dialID,
      ...(callUUID ? { call_uuid: callUUID } : {}),
      ...(proxyIdentifier ? { proxy_identifier: proxyIdentifier } : {}),
    },
  };
}

function readHandle(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("handle must be a string");
  }
  const handle = value.trim();
  if (!handle) {
    throw new Error("handle is required");
  }
  if (handle.length > 320) {
    throw new Error("handle is too long");
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(handle)) {
    throw new Error("handle must not include a URL scheme");
  }
  if (/[\u0000-\u001f\u007f/?#\\]/u.test(handle)) {
    throw new Error("handle contains unsupported characters");
  }
  if (handle.includes("@")) {
    if (!/^[^@\s]+@[^@\s]+$/u.test(handle)) {
      throw new Error("handle must be a valid FaceTime email address or phone number");
    }
    return handle;
  }
  if (!/^[+\d\s().-]+$/u.test(handle) || !/\d/u.test(handle)) {
    throw new Error("handle must be a valid FaceTime email address or phone number");
  }
  return handle;
}

function readMode(value: unknown): FaceTimeDialMode {
  if (value === undefined) {
    return "audio";
  }
  if (value === "audio" || value === "video") {
    return value;
  }
  throw new Error("mode must be audio or video");
}

export function resolveFaceTimeDialRequest(params: {
  handle: unknown;
  mode?: unknown;
  whitelistHandles: readonly string[];
}): FaceTimeDialRequest {
  const handle = readHandle(params.handle);
  if (!isWhitelistedFaceTimeHandle({ handle, whitelistHandles: params.whitelistHandles })) {
    throw new Error("outbound FaceTime handle is not allowlisted");
  }
  return { handle, mode: readMode(params.mode) };
}

export function resolveFaceTimeDialResult(params: {
  dialID: string;
  request: FaceTimeDialRequest;
  helper: Record<string, unknown>;
}): FaceTimeDialResult {
  const callUUID = readOptionalString(params.helper.call_uuid);
  const proxyIdentifier = readOptionalString(params.helper.proxy_identifier);
  return {
    ...params.request,
    dialID: params.dialID,
    state: callUUID ? "ringing" : "pending",
    ...(callUUID ? { callUUID } : {}),
    ...(proxyIdentifier ? { proxyIdentifier } : {}),
    helper: params.helper,
  };
}

export function doesFaceTimeCallMatchPendingDial(params: {
  event: FaceTimeCallStatusEvent;
  pending: PendingFaceTimeDial;
}): boolean {
  if (params.event.data.dial_id) {
    return params.event.data.dial_id === params.pending.dialID;
  }
  if (params.pending.callUUID) {
    const eventCallUUID = params.event.data.call_uuid;
    return (
      typeof eventCallUUID === "string" &&
      doesPendingFaceTimeDialHaveCallUUID(params.pending, eventCallUUID)
    );
  }
  if (params.pending.proxyIdentifier) {
    return params.event.data.proxy_identifier === params.pending.proxyIdentifier;
  }
  return params.event.data.dial_id === params.pending.dialID;
}

export function retainFaceTimeDialCallUUID(
  pending: PendingFaceTimeDial,
  callUUID: string | undefined,
): void {
  if (!callUUID) {
    return;
  }
  pending.callUUIDAliases ??= new Set<string>();
  if (pending.callUUID) {
    pending.callUUIDAliases.add(pending.callUUID);
  }
  pending.callUUIDAliases.add(callUUID);
  pending.callUUID = callUUID;
}

export function doesPendingFaceTimeDialHaveCallUUID(
  pending: PendingFaceTimeDial,
  callUUID: string,
): boolean {
  return pending.callUUID === callUUID || pending.callUUIDAliases?.has(callUUID) === true;
}
