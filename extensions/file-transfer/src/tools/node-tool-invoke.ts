import crypto from "node:crypto";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asNullableRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { bindFileTransferAudit } from "../shared/audit-context.js";
import type { FileTransferAuditOp } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import { readGatewayCallOptions } from "../shared/params.js";

type ErrorAuditExtra = {
  sha256?: string;
  sizeBytes?: number;
};

export function readRequiredNodePath(params: Record<string, unknown>): {
  node: string;
  requestedPath: string;
} {
  const node = normalizeOptionalString(params.node);
  const requestedPath = normalizeOptionalString(params.path);
  if (!node) {
    throw new Error("node required");
  }
  if (!requestedPath) {
    throw new Error("path required");
  }
  return { node, requestedPath };
}

export async function invokeNodeToolPayload(input: {
  errorAuditExtra?: ErrorAuditExtra;
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
  payload: Record<string, unknown>;
}> {
  const gatewayOpts = readGatewayCallOptions(input.params);
  const nodes: NodeListNode[] = await listNodes(gatewayOpts);
  if (nodes.length === 0) {
    throw new Error(
      "no paired nodes available; file-transfer tools require a paired node from nodes status. Use local file/exec tools for local workspace paths.",
    );
  }
  const nodeId = resolveNodeIdFromList(nodes, input.node, false);
  const nodeMeta = nodes.find((n) => n.nodeId === nodeId);
  const nodeDisplayName = nodeMeta?.displayName ?? input.node;
  const startedAt = Date.now();
  const audit = bindFileTransferAudit(
    { op: input.command, nodeId, nodeDisplayName, requestedPath: input.requestedPath },
    startedAt,
  );

  const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
    nodeId,
    command: input.command,
    params: input.commandParams,
    idempotencyKey: crypto.randomUUID(),
  });

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

  return { audit, payload };
}
