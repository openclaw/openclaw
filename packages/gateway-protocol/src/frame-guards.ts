import { asNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { isNonEmptyProtocolString, isProtocolRecord } from "./protocol-value-normalization.js";
import type { EventFrame, ResponseFrame } from "./schema/frames.js";
export { GATEWAY_SERVER_CAPS } from "./server-capabilities.js";
export type {
  ConnectParams,
  ErrorShape,
  EventFrame,
  GatewayFrame,
  HelloOk,
  RequestFrame,
  ResponseFrame,
} from "./schema/frames.js";

function isGatewayErrorShape(value: unknown): boolean {
  if (!isProtocolRecord(value)) {
    return false;
  }
  if (!isNonEmptyProtocolString(value.code) || !isNonEmptyProtocolString(value.message)) {
    return false;
  }
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") {
    return false;
  }
  return value.retryAfterMs === undefined || asNonNegativeInteger(value.retryAfterMs) !== undefined;
}

// These lightweight guards validate dispatch-critical envelope fields without
// compiling the full schemas or rejecting additive payload fields.
export function isGatewayEventFrame(value: unknown): value is EventFrame {
  if (
    !isProtocolRecord(value) ||
    value.type !== "event" ||
    !isNonEmptyProtocolString(value.event)
  ) {
    return false;
  }
  return value.seq === undefined || asNonNegativeInteger(value.seq) !== undefined;
}

export function isGatewayResponseFrame(value: unknown): value is ResponseFrame {
  if (
    !isProtocolRecord(value) ||
    value.type !== "res" ||
    !isNonEmptyProtocolString(value.id) ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.error === undefined || isGatewayErrorShape(value.error);
}
