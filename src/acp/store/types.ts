import type { AcpRuntimeEvent } from "../runtime/types.js";

export type AcpGatewaySessionState = "idle" | "running" | "recovering";

export type AcpGatewayRunState =
  | "accepted"
  | "running"
  | "cancelling"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled";

export type AcpGatewayLeaseState = "active" | "suspect" | "lost" | "released";

export type AcpGatewayRecoveryReason =
  | "start_accepted_no_events"
  | "start_unknown_transport"
  | "node_disconnected"
  | "gateway_restart_reconcile"
  | "status_mismatch"
  | "lease_expired";

export type AcpGatewayTerminalKind = "completed" | "failed" | "cancelled";

export type AcpGatewayNonTerminalEvent = Exclude<AcpRuntimeEvent, { type: "done" }>;

export type AcpGatewayTerminal = {
  terminalEventId: string;
  finalSeq: number;
  kind: AcpGatewayTerminalKind;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  acceptedAt: number;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
};

export type AcpGatewaySessionRecord = {
  sessionKey: string;
  backend: "acp-node";
  state: AcpGatewaySessionState;
  createdAt: number;
  updatedAt: number;
  activeRunId?: string;
  lastRunId?: string;
  activeLeaseId?: string;
  lastRecoveryReason?: AcpGatewayRecoveryReason;
};

export type AcpGatewayRunRecord = {
  runId: string;
  sessionKey: string;
  requestId: string;
  startedByNodeId: string;
  startedByLeaseId: string;
  startedByLeaseEpoch: number;
  state: AcpGatewayRunState;
  createdAt: number;
  updatedAt: number;
  highestAcceptedSeq: number;
  eventCount: number;
  recoveryReason?: AcpGatewayRecoveryReason;
  cancelRequestedAt?: number;
  terminal?: AcpGatewayTerminal;
};

export type AcpGatewayRunEventRecord = {
  eventId: string;
  runId: string;
  sessionKey: string;
  seq: number;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
  acceptedAt: number;
  event: AcpGatewayNonTerminalEvent;
};

export type AcpGatewayLeaseRecord = {
  sessionKey: string;
  leaseId: string;
  leaseEpoch: number;
  nodeId: string;
  state: AcpGatewayLeaseState;
  acquiredAt: number;
  updatedAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
  nodeRuntimeSessionId?: string;
  nodeWorkerRunId?: string;
  workerProtocolVersion?: number;
};

export type AcpGatewayLeaseReconcileRecord = {
  session: AcpGatewaySessionRecord;
  run?: AcpGatewayRunRecord;
  lease: AcpGatewayLeaseRecord;
};

export type AcpGatewayCheckpointRecord = {
  checkpointKey: string;
  sessionKey: string;
  runId: string;
  cursorSeq: number;
  updatedAt: number;
};

export type AcpGatewayIdempotencyRecord = {
  key: string;
  scope: string;
  createdAt: number;
  sessionKey?: string;
  runId?: string;
  status?: string;
};

export type AcpGatewayStoreData = {
  version: 1;
  sessions: Record<string, AcpGatewaySessionRecord>;
  runs: Record<string, AcpGatewayRunRecord>;
  events: Record<string, AcpGatewayRunEventRecord[]>;
  leases: Record<string, AcpGatewayLeaseRecord>;
  checkpoints: Record<string, AcpGatewayCheckpointRecord>;
  idempotency: Record<string, AcpGatewayIdempotencyRecord>;
};

export type AcpWorkerEnvelopeBase = {
  nodeId: string;
  sessionKey: string;
  runId: string;
  leaseId: string;
  leaseEpoch: number;
};

export type AcpWorkerEventEnvelope = AcpWorkerEnvelopeBase & {
  seq: number;
  event: AcpGatewayNonTerminalEvent;
};

export type AcpWorkerTerminalEnvelope = AcpWorkerEnvelopeBase & {
  terminalEventId: string;
  finalSeq: number;
  terminal: {
    kind: AcpGatewayTerminalKind;
    stopReason?: string;
    errorCode?: string;
    errorMessage?: string;
  };
};

export type AcpWorkerHeartbeatEnvelope = AcpWorkerEnvelopeBase & {
  state: "idle" | "running" | "cancelling";
  ts: number;
  nodeRuntimeSessionId?: string;
  nodeWorkerRunId?: string;
  workerProtocolVersion?: number;
};
