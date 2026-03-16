import type { NodeEvent } from "../../gateway/server-node-events-types.js";
import { AcpGatewayStore, AcpGatewayStoreError } from "./store.js";
import type {
  AcpGatewayNonTerminalEvent,
  AcpGatewayRecoveryReason,
  AcpWorkerEventEnvelope,
  AcpWorkerHeartbeatEnvelope,
  AcpWorkerTerminalEnvelope,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AcpGatewayStoreError(
      "ACP_NODE_INVALID_EVENT",
      `ACP worker payload field "${field}" must be a non-empty string.`,
    );
  }
  return value.trim();
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.trunc(value) !== value ||
    value < minimum
  ) {
    throw new AcpGatewayStoreError(
      "ACP_NODE_INVALID_EVENT",
      `ACP worker payload field "${field}" must be an integer >= ${minimum}.`,
    );
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePayloadObject(payloadJSON?: string | null): Record<string, unknown> {
  if (!payloadJSON) {
    throw new AcpGatewayStoreError("ACP_NODE_INVALID_EVENT", "ACP worker payloadJSON is required.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJSON) as unknown;
  } catch (error) {
    throw new AcpGatewayStoreError(
      "ACP_NODE_INVALID_EVENT",
      `ACP worker payloadJSON must be valid JSON: ${String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new AcpGatewayStoreError(
      "ACP_NODE_INVALID_EVENT",
      "ACP worker payloadJSON must decode to an object.",
    );
  }
  return parsed;
}

function parseBaseEnvelope(payloadJSON?: string | null): Record<
  "nodeId" | "sessionKey" | "runId" | "leaseId",
  string
> & {
  leaseEpoch: number;
  raw: Record<string, unknown>;
} {
  const raw = parsePayloadObject(payloadJSON);
  return {
    nodeId: requireString(raw.nodeId, "nodeId"),
    sessionKey: requireString(raw.sessionKey, "sessionKey"),
    runId: requireString(raw.runId, "runId"),
    leaseId: requireString(raw.leaseId, "leaseId"),
    leaseEpoch: requireInteger(raw.leaseEpoch, "leaseEpoch", 1),
    raw,
  };
}

function parseRuntimeEvent(value: unknown): AcpGatewayNonTerminalEvent {
  if (!isRecord(value)) {
    throw new AcpGatewayStoreError(
      "ACP_NODE_INVALID_EVENT",
      'ACP worker "event" must be an object.',
    );
  }
  const type = requireString(value.type, "event.type");
  switch (type) {
    case "text_delta": {
      const stream = value.stream;
      if (stream !== undefined && stream !== "output" && stream !== "thought") {
        throw new AcpGatewayStoreError(
          "ACP_NODE_INVALID_EVENT",
          'ACP worker text_delta "stream" must be "output" or "thought".',
        );
      }
      const tag = optionalString(value.tag);
      return {
        type: "text_delta",
        text: requireString(value.text, "event.text"),
        ...(stream ? { stream } : {}),
        ...(tag ? { tag } : {}),
      };
    }
    case "status": {
      const tag = optionalString(value.tag);
      const used =
        typeof value.used === "number" && Number.isFinite(value.used) ? value.used : undefined;
      const size =
        typeof value.size === "number" && Number.isFinite(value.size) ? value.size : undefined;
      return {
        type: "status",
        text: requireString(value.text, "event.text"),
        ...(tag ? { tag } : {}),
        ...(used !== undefined ? { used } : {}),
        ...(size !== undefined ? { size } : {}),
      };
    }
    case "tool_call": {
      const tag = optionalString(value.tag);
      return {
        type: "tool_call",
        text: requireString(value.text, "event.text"),
        ...(tag ? { tag } : {}),
        ...(optionalString(value.toolCallId)
          ? { toolCallId: optionalString(value.toolCallId) }
          : {}),
        ...(optionalString(value.status) ? { status: optionalString(value.status) } : {}),
        ...(optionalString(value.title) ? { title: optionalString(value.title) } : {}),
      };
    }
    case "error":
      return {
        type: "error",
        message: requireString(value.message, "event.message"),
        ...(optionalString(value.code) ? { code: optionalString(value.code) } : {}),
        ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
      };
    case "done":
      throw new AcpGatewayStoreError(
        "ACP_NODE_INVALID_EVENT",
        "acp.worker.event does not accept event.type=done; use acp.worker.terminal instead.",
      );
    default:
      throw new AcpGatewayStoreError(
        "ACP_NODE_INVALID_EVENT",
        `ACP worker event type "${type}" is not supported.`,
      );
  }
}

function parseWorkerEventEnvelope(payloadJSON?: string | null): AcpWorkerEventEnvelope {
  const base = parseBaseEnvelope(payloadJSON);
  return {
    nodeId: base.nodeId,
    sessionKey: base.sessionKey,
    runId: base.runId,
    leaseId: base.leaseId,
    leaseEpoch: base.leaseEpoch,
    seq: requireInteger(base.raw.seq, "seq", 1),
    event: parseRuntimeEvent(base.raw.event),
  };
}

function parseWorkerTerminalEnvelope(payloadJSON?: string | null): AcpWorkerTerminalEnvelope {
  const base = parseBaseEnvelope(payloadJSON);
  const terminal = base.raw.terminal;
  if (!isRecord(terminal)) {
    throw new AcpGatewayStoreError(
      "ACP_NODE_INVALID_EVENT",
      'ACP worker "terminal" must be an object.',
    );
  }
  const kind = requireString(terminal.kind, "terminal.kind");
  if (kind !== "completed" && kind !== "failed" && kind !== "cancelled") {
    throw new AcpGatewayStoreError(
      "ACP_NODE_INVALID_EVENT",
      `ACP worker terminal kind "${kind}" is not supported.`,
    );
  }
  return {
    nodeId: base.nodeId,
    sessionKey: base.sessionKey,
    runId: base.runId,
    leaseId: base.leaseId,
    leaseEpoch: base.leaseEpoch,
    terminalEventId: requireString(base.raw.terminalEventId, "terminalEventId"),
    finalSeq: requireInteger(base.raw.finalSeq, "finalSeq", 0),
    terminal: {
      kind,
      ...(optionalString(terminal.stopReason)
        ? { stopReason: optionalString(terminal.stopReason) }
        : {}),
      ...(optionalString(terminal.errorCode)
        ? { errorCode: optionalString(terminal.errorCode) }
        : {}),
      ...(optionalString(terminal.errorMessage)
        ? { errorMessage: optionalString(terminal.errorMessage) }
        : {}),
    },
  };
}

function parseWorkerHeartbeatEnvelope(payloadJSON?: string | null): AcpWorkerHeartbeatEnvelope {
  const base = parseBaseEnvelope(payloadJSON);
  const state = requireString(base.raw.state, "state");
  if (state !== "idle" && state !== "running" && state !== "cancelling") {
    throw new AcpGatewayStoreError(
      "ACP_NODE_INVALID_EVENT",
      `ACP worker heartbeat state "${state}" is not supported.`,
    );
  }
  return {
    nodeId: base.nodeId,
    sessionKey: base.sessionKey,
    runId: base.runId,
    leaseId: base.leaseId,
    leaseEpoch: base.leaseEpoch,
    state,
    ts: requireInteger(base.raw.ts, "ts", 0),
    ...(optionalString(base.raw.nodeRuntimeSessionId)
      ? { nodeRuntimeSessionId: optionalString(base.raw.nodeRuntimeSessionId) }
      : {}),
    ...(optionalString(base.raw.nodeWorkerRunId)
      ? { nodeWorkerRunId: optionalString(base.raw.nodeWorkerRunId) }
      : {}),
    ...(typeof base.raw.workerProtocolVersion === "number" &&
    Number.isFinite(base.raw.workerProtocolVersion) &&
    Math.trunc(base.raw.workerProtocolVersion) === base.raw.workerProtocolVersion
      ? { workerProtocolVersion: base.raw.workerProtocolVersion }
      : {}),
  };
}

export class AcpGatewayNodeRuntime {
  constructor(readonly store = new AcpGatewayStore()) {}

  async ingestNodeEvent(nodeId: string, evt: NodeEvent): Promise<boolean> {
    switch (evt.event) {
      case "acp.worker.event": {
        const envelope = parseWorkerEventEnvelope(evt.payloadJSON);
        this.assertNodeIdentity(nodeId, envelope.nodeId);
        await this.store.appendWorkerEvent(envelope);
        return true;
      }
      case "acp.worker.terminal": {
        const envelope = parseWorkerTerminalEnvelope(evt.payloadJSON);
        this.assertNodeIdentity(nodeId, envelope.nodeId);
        await this.store.resolveTerminal(envelope);
        return true;
      }
      case "acp.worker.heartbeat": {
        const envelope = parseWorkerHeartbeatEnvelope(evt.payloadJSON);
        this.assertNodeIdentity(nodeId, envelope.nodeId);
        await this.store.recordHeartbeat(envelope);
        return true;
      }
      default:
        return false;
    }
  }

  async markNodeDisconnected(params: {
    nodeId: string;
    reason: AcpGatewayRecoveryReason;
    now?: number;
  }) {
    return await this.store.markNodeDisconnected(params);
  }

  async reconcileSuspectLease(params: {
    sessionKey: string;
    nodeId: string;
    leaseId: string;
    leaseEpoch: number;
    now?: number;
    nodeRuntimeSessionId?: string;
    nodeWorkerRunId?: string;
    workerProtocolVersion?: number;
  }) {
    return await this.store.reconcileSuspectLease(params);
  }

  private assertNodeIdentity(connectionNodeId: string, payloadNodeId: string): void {
    if (connectionNodeId !== payloadNodeId) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_NODE_MISMATCH",
        `ACP worker payload nodeId "${payloadNodeId}" does not match the authenticated connection node "${connectionNodeId}".`,
      );
    }
  }
}

let acpGatewayNodeRuntimeSingleton: AcpGatewayNodeRuntime | null = null;

export function getAcpGatewayNodeRuntime(): AcpGatewayNodeRuntime {
  if (!acpGatewayNodeRuntimeSingleton) {
    acpGatewayNodeRuntimeSingleton = new AcpGatewayNodeRuntime();
  }
  return acpGatewayNodeRuntimeSingleton;
}

export const __testing = {
  resetAcpGatewayNodeRuntimeForTests() {
    acpGatewayNodeRuntimeSingleton = null;
  },
  setAcpGatewayNodeRuntimeForTests(runtime: AcpGatewayNodeRuntime) {
    acpGatewayNodeRuntimeSingleton = runtime;
  },
};
