import { asProtocolRecord, isNonEmptyProtocolString } from "./protocol-value-normalization.js";
import type { NodePermissionDetails } from "./schema/nodes.js";

export const NODE_PERMISSION_STATES = [
  "not-determined",
  "denied",
  "restart-required",
  "stale-grant",
  "disabled-in-openclaw",
] as const;

export type { NodePermissionDetails } from "./schema/nodes.js";

export type NodePermissionRequest = NodePermissionDetails & {
  nodeId: string;
  nodeName?: string;
  command: string;
};

/** Read native error details without loading the protocol schema registry in the UI. */
export function readNodePermissionDetails(value: unknown): NodePermissionDetails | undefined {
  const record = asProtocolRecord(value);
  const state = NODE_PERMISSION_STATES.find((candidate) => candidate === record?.state);
  if (
    !record ||
    !Array.isArray(record.capabilities) ||
    record.capabilities.length === 0 ||
    !record.capabilities.every(isNonEmptyProtocolString) ||
    new Set(record.capabilities).size !== record.capabilities.length ||
    !state
  ) {
    return undefined;
  }
  return { capabilities: record.capabilities, state };
}

export function readNodePermissionRequest(value: unknown): NodePermissionRequest | undefined {
  const record = asProtocolRecord(value);
  const details = readNodePermissionDetails(value);
  if (
    !record ||
    !details ||
    !isNonEmptyProtocolString(record.nodeId) ||
    !isNonEmptyProtocolString(record.command) ||
    (record.nodeName !== undefined && !isNonEmptyProtocolString(record.nodeName))
  ) {
    return undefined;
  }
  return {
    ...details,
    nodeId: record.nodeId,
    command: record.command,
    ...(record.nodeName !== undefined ? { nodeName: record.nodeName } : {}),
  };
}
