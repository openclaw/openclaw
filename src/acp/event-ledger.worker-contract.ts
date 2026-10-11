import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { AcpEventLedger, AcpMutableLedgerState } from "./event-ledger.types.js";
import type { acpReplayOperations } from "./event-ledger.worker.js";

export type AcpReplayLimits = Omit<AcpMutableLedgerState, "now">;
export type AcpReplayStartInput = {
  session: Parameters<AcpEventLedger["startSession"]>[0];
  limits: AcpReplayLimits;
  now: number;
};
export type AcpReplayAppendInput = {
  session: { sessionId: string; sessionKey: string; runId?: string };
  limits: AcpReplayLimits;
  events: Array<{ update: SessionUpdate; createdAt: number; at: number }>;
};
export type AcpReplayReadInput =
  | { kind: "id"; sessionId: string }
  | { kind: "bound"; sessionId: string; sessionKey: string }
  | { kind: "key"; sessionKey: string };
export type AcpReplayWorkerOperations = WorkerOperations<typeof acpReplayOperations>;
