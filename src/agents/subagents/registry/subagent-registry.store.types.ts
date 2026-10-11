import type { SessionStateNotice } from "../../../sessions/session-state-events.kernel.js";
import type { SessionStateWorkerOperations } from "../../../sessions/session-state-events.worker-contract.js";
import type { SubagentRunSqliteRow } from "./subagent-registry.store.row.js";

export type SubagentRegistryWrite = {
  writeId: string;
  values: readonly SubagentRunSqliteRow[];
  deleteRunIds: readonly string[];
  versions: readonly { runId: string; version: string | null }[];
  registrationCohort?: {
    childSessionKey: string;
    childAgentId: string;
    runIds: readonly string[];
  };
  terminalEvents?: readonly Pick<
    SessionStateWorkerOperations["sessionState.record"]["input"],
    "event" | "now" | "acpControl" | "sessionEntryCurrentSource"
  >[];
};

export type SubagentRegistryWriteReceipt =
  | { writeId: string; conflictRunIds: string[] }
  | { writeId: string; versions: Map<string, string | null>; notices: SessionStateNotice[] };
