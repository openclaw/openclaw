import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  AcpEventLedger,
  AcpEventLedgerReplay,
  AcpMutableLedgerState,
} from "./event-ledger.types.js";

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
export type AcpReplayWorkerOperations = {
  "acpReplay.start": { input: AcpReplayStartInput; output: void };
  "acpReplay.append": { input: AcpReplayAppendInput; output: void };
  "acpReplay.incomplete": {
    input: { sessionId: string; sessionKey: string; now: number };
    output: void;
  };
  "acpReplay.read": { input: AcpReplayReadInput; output: AcpEventLedgerReplay };
};
