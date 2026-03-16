import type { NodeEvent } from "../../gateway/server-node-events-types.js";
import { AcpGatewayStore, AcpGatewayStoreError } from "./store.js";
import type {
  AcpGatewayLeaseRecord,
  AcpGatewayNonTerminalEvent,
  AcpGatewayRecoveryReason,
  AcpWorkerEventEnvelope,
  AcpWorkerHeartbeatEnvelope,
  AcpWorkerTerminalEnvelope,
} from "./types.js";

export type AcpGatewayNodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

export type AcpGatewayNodeInvoker = (params: {
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}) => Promise<AcpGatewayNodeInvokeResult>;

export type AcpGatewayNodeSessionStatus = {
  nodeId: string;
  ok: true;
  sessionKey: string;
  leaseId: string;
  leaseEpoch: number;
  state: "idle" | "running" | "cancelling" | "missing" | "error";
  nodeRuntimeSessionId?: string;
  nodeWorkerRunId?: string;
  workerProtocolVersion?: number;
  details?: Record<string, unknown>;
};

export class AcpGatewayNodeTransportError extends Error {
  constructor(
    readonly code: "ACP_NODE_TRANSPORT_FAILED" | "ACP_NODE_INVALID_STATUS",
    message: string,
  ) {
    super(message);
    this.name = "AcpGatewayNodeTransportError";
  }
}

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

function parseInvokePayloadObject(result: AcpGatewayNodeInvokeResult): Record<string, unknown> {
  const source =
    typeof result.payloadJSON === "string"
      ? (() => {
          try {
            return JSON.parse(result.payloadJSON) as unknown;
          } catch (error) {
            throw new AcpGatewayNodeTransportError(
              "ACP_NODE_INVALID_STATUS",
              `ACP node invoke payloadJSON must be valid JSON: ${String(error)}`,
            );
          }
        })()
      : result.payload;
  if (!isRecord(source)) {
    throw new AcpGatewayNodeTransportError(
      "ACP_NODE_INVALID_STATUS",
      "ACP node invoke payload must decode to an object.",
    );
  }
  return source;
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

  async expireSuspectLeases(params?: { now?: number }) {
    return await this.store.expireSuspectLeases(params);
  }

  async querySessionStatus(params: {
    invokeNode: AcpGatewayNodeInvoker;
    nodeId: string;
    sessionKey: string;
    leaseId: string;
    leaseEpoch: number;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<AcpGatewayNodeSessionStatus> {
    const result = await params.invokeNode({
      nodeId: params.nodeId,
      command: "acp.session.status",
      params: {
        sessionKey: params.sessionKey,
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
      },
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    });
    if (!result.ok) {
      throw new AcpGatewayNodeTransportError(
        "ACP_NODE_TRANSPORT_FAILED",
        result.error?.message || "ACP node status request failed.",
      );
    }
    const payload = parseInvokePayloadObject(result);
    const state = requireString(payload.state, "state");
    if (
      state !== "idle" &&
      state !== "running" &&
      state !== "cancelling" &&
      state !== "missing" &&
      state !== "error"
    ) {
      throw new AcpGatewayNodeTransportError(
        "ACP_NODE_INVALID_STATUS",
        `ACP node status state "${state}" is not supported.`,
      );
    }
    return {
      nodeId: requireString(payload.nodeId, "nodeId"),
      ok: true,
      sessionKey: requireString(payload.sessionKey, "sessionKey"),
      leaseId: requireString(payload.leaseId, "leaseId"),
      leaseEpoch: requireInteger(payload.leaseEpoch, "leaseEpoch", 0),
      state,
      ...(optionalString(payload.nodeRuntimeSessionId)
        ? { nodeRuntimeSessionId: optionalString(payload.nodeRuntimeSessionId) }
        : {}),
      ...(optionalString(payload.nodeWorkerRunId)
        ? { nodeWorkerRunId: optionalString(payload.nodeWorkerRunId) }
        : {}),
      ...(typeof payload.workerProtocolVersion === "number" &&
      Number.isFinite(payload.workerProtocolVersion) &&
      Math.trunc(payload.workerProtocolVersion) === payload.workerProtocolVersion
        ? { workerProtocolVersion: payload.workerProtocolVersion }
        : {}),
      ...(isRecord(payload.details) ? { details: payload.details } : {}),
    };
  }

  async reconcileConnectedNodeLeases(params: {
    nodeId: string;
    invokeNode: AcpGatewayNodeInvoker;
    now?: number;
  }): Promise<{
    reconciled: AcpGatewayLeaseRecord[];
    lost: AcpGatewayLeaseRecord[];
  }> {
    const now = params.now ?? Date.now();
    const snapshot = await this.store.loadSnapshot();
    const reconciled: AcpGatewayLeaseRecord[] = [];
    const lost: AcpGatewayLeaseRecord[] = [];
    const candidateLeases = Object.values(snapshot.leases).filter(
      (lease) => lease.nodeId === params.nodeId && lease.state === "suspect",
    );
    for (const lease of candidateLeases) {
      const status = await this.querySessionStatus({
        invokeNode: params.invokeNode,
        nodeId: params.nodeId,
        sessionKey: lease.sessionKey,
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
      });
      if (
        status.nodeId === params.nodeId &&
        status.sessionKey === lease.sessionKey &&
        status.leaseId === lease.leaseId &&
        status.leaseEpoch === lease.leaseEpoch &&
        (status.state === "idle" || status.state === "running" || status.state === "cancelling")
      ) {
        const next = await this.store.reconcileSuspectLease({
          sessionKey: lease.sessionKey,
          nodeId: params.nodeId,
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          now,
          ...(status.nodeRuntimeSessionId
            ? { nodeRuntimeSessionId: status.nodeRuntimeSessionId }
            : {}),
          ...(status.nodeWorkerRunId ? { nodeWorkerRunId: status.nodeWorkerRunId } : {}),
          ...(typeof status.workerProtocolVersion === "number"
            ? { workerProtocolVersion: status.workerProtocolVersion }
            : {}),
        });
        reconciled.push(next.lease);
        continue;
      }
      const next = await this.store.markStatusMismatch({
        sessionKey: lease.sessionKey,
        now,
      });
      lost.push(next.lease);
    }
    return { reconciled, lost };
  }

  async ensureSession(params: {
    invokeNode: AcpGatewayNodeInvoker;
    nodeId: string;
    sessionKey: string;
    leaseId: string;
    leaseEpoch: number;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    runtimeOptions?: Record<string, unknown>;
    resume?: Record<string, unknown>;
    timeoutMs?: number;
    idempotencyKey?: string;
  }) {
    return await params.invokeNode({
      nodeId: params.nodeId,
      command: "acp.session.ensure",
      params: {
        sessionKey: params.sessionKey,
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
        agent: params.agent,
        mode: params.mode,
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.runtimeOptions ? { runtimeOptions: params.runtimeOptions } : {}),
        ...(params.resume ? { resume: params.resume } : {}),
      },
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    });
  }

  async loadSession(params: {
    invokeNode: AcpGatewayNodeInvoker;
    nodeId: string;
    sessionKey: string;
    leaseId: string;
    leaseEpoch: number;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    runtimeOptions?: Record<string, unknown>;
    resume?: Record<string, unknown>;
    timeoutMs?: number;
    idempotencyKey?: string;
  }) {
    return await params.invokeNode({
      nodeId: params.nodeId,
      command: "acp.session.load",
      params: {
        sessionKey: params.sessionKey,
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
        agent: params.agent,
        mode: params.mode,
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.runtimeOptions ? { runtimeOptions: params.runtimeOptions } : {}),
        ...(params.resume ? { resume: params.resume } : {}),
      },
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    });
  }

  async startTurn(params: {
    invokeNode: AcpGatewayNodeInvoker;
    nodeId: string;
    sessionKey: string;
    runId: string;
    leaseId: string;
    leaseEpoch: number;
    requestId: string;
    mode: "prompt" | "steer";
    text: string;
    attachments?: Array<{ mediaType: string; data: string }>;
    timeoutMs?: number;
    idempotencyKey?: string;
  }) {
    return await params.invokeNode({
      nodeId: params.nodeId,
      command: "acp.turn.start",
      params: {
        sessionKey: params.sessionKey,
        runId: params.runId,
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
        requestId: params.requestId,
        mode: params.mode,
        text: params.text,
        ...(params.attachments ? { attachments: params.attachments } : {}),
      },
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    });
  }

  async cancelTurn(params: {
    invokeNode: AcpGatewayNodeInvoker;
    nodeId: string;
    sessionKey: string;
    runId: string;
    leaseId: string;
    leaseEpoch: number;
    reason?: string;
    timeoutMs?: number;
    idempotencyKey?: string;
  }) {
    return await params.invokeNode({
      nodeId: params.nodeId,
      command: "acp.turn.cancel",
      params: {
        sessionKey: params.sessionKey,
        runId: params.runId,
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
        ...(params.reason ? { reason: params.reason } : {}),
      },
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    });
  }

  async closeSession(params: {
    invokeNode: AcpGatewayNodeInvoker;
    nodeId: string;
    sessionKey: string;
    leaseId: string;
    leaseEpoch: number;
    reason?: string;
    timeoutMs?: number;
    idempotencyKey?: string;
  }) {
    return await params.invokeNode({
      nodeId: params.nodeId,
      command: "acp.session.close",
      params: {
        sessionKey: params.sessionKey,
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
        ...(params.reason ? { reason: params.reason } : {}),
      },
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    });
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
