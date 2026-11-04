import crypto from "node:crypto";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { asNullableRecord, readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { bindFileTransferAudit } from "../shared/audit-context.js";
import type { FileTransferAuditOp } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import { readGatewayCallOptions } from "../shared/params.js";
import { invokeAttachedFileTool } from "./attached-node-tool-invoke.js";

type ErrorAuditExtra = {
  sha256?: string;
  sizeBytes?: number;
};

export function readRequiredNodePath(params: Record<string, unknown>, allowResourceHandle = false) {
  const environmentId = readNonBlankString(params.environmentId);
  const selectedNode = readNonBlankString(params.node);
  if (params.environmentId !== undefined && !environmentId) {
    throw new Error("environmentId must be nonempty");
  }
  if (environmentId && params.node !== undefined) {
    throw new Error("Choose node or environmentId, not both");
  }
  const resourceHandle = readNonBlankString(params.resourceHandle);
  const path = readNonBlankString(params.path);
  if (
    params.resourceHandle !== undefined &&
    (!allowResourceHandle || !environmentId || !resourceHandle || path)
  ) {
    throw new Error("Choose an attached resourceHandle or a path, not both");
  }
  const node = environmentId ?? selectedNode;
  const requestedPath = path ?? (resourceHandle ? "resource:" + resourceHandle : undefined);
  if (!node) {
    throw new Error("node or environmentId required");
  }
  if (!requestedPath) {
    throw new Error("path required");
  }
  return { node, requestedPath };
}

export async function invokeNodeToolPayload(input: {
  errorAuditExtra?: ErrorAuditExtra;
  assertDispatchCurrent?: () => void;
  invalidPayloadError?: string;
  invalidPayloadMessage?: string;
  node: string;
  params: Record<string, unknown>;
  command: FileTransferAuditOp;
  commandParams: Record<string, unknown>;
  requireOk?: boolean;
  requestedPath: string;
}): Promise<{
  audit: ReturnType<typeof bindFileTransferAudit>;
  assertCurrent?: () => Promise<void>;
  payload: Record<string, unknown>;
}> {
  input.assertDispatchCurrent?.();
  const startedAt = Date.now();
  const environmentId = readNonBlankString(input.params.environmentId);
  let nodeId: string;
  let nodeDisplayName: string;
  let raw: { payload?: unknown };
  let assertCurrent: (() => Promise<void>) | undefined;
  if (environmentId) {
    const attached = await invokeAttachedFileTool(input, environmentId);
    ({ nodeId, nodeDisplayName, raw, assertCurrent } = attached);
  } else {
    const gatewayOpts = readGatewayCallOptions(input.params);
    const nodes: NodeListNode[] = await listNodes(gatewayOpts);
    if (nodes.length === 0) {
      throw new Error("no paired nodes available; use node status or an owned environmentId");
    }
    nodeId = resolveNodeIdFromList(nodes, input.node, false);
    nodeDisplayName = nodes.find((node) => node.nodeId === nodeId)?.displayName ?? input.node;
    raw = await callGatewayTool<{ payload: unknown }>(
      "node.invoke",
      gatewayOpts,
      {
        nodeId,
        command: input.command,
        params: input.commandParams,
        idempotencyKey: crypto.randomUUID(),
      },
      input.assertDispatchCurrent
        ? {
            dispatchAuthority: {
              version: 2,
              kind: "source-bound",
              assertCurrent: input.assertDispatchCurrent,
            },
          }
        : undefined,
    );
  }
  const audit = bindFileTransferAudit(
    { op: input.command, nodeId, nodeDisplayName, requestedPath: input.requestedPath },
    startedAt,
  );
  const payload = asNullableRecord(raw?.payload);
  if (!payload) {
    await audit({
      decision: "error",
      errorMessage: input.invalidPayloadMessage ?? "invalid payload",
      ...input.errorAuditExtra,
    });
    throw new Error(input.invalidPayloadError ?? `invalid ${input.command} payload`);
  }
  if (payload.ok === false || (input.requireOk === true && payload.ok !== true)) {
    await audit({
      canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
      decision: "error",
      errorCode: typeof payload.code === "string" ? payload.code : undefined,
      errorMessage: typeof payload.message === "string" ? payload.message : undefined,
      ...input.errorAuditExtra,
    });
    throwFromNodePayload(input.command, payload);
  }

  return { audit, payload, assertCurrent };
}
