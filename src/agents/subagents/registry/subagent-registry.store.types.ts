import type { SessionStateNotice } from "../../../sessions/session-state-events.kernel.js";
import type { SessionStateEventWrite } from "../../../sessions/session-state-events.worker-contract.js";
import type { SubagentRunSqliteRow } from "./subagent-registry.store.row.js";

export type SubagentRegistryWrite = {
  writeId: string;
  values: readonly SubagentRunSqliteRow[];
  deleteRunIds: readonly string[];
  terminalEvents?: readonly Pick<
    SessionStateEventWrite,
    "event" | "now" | "sessionEntryCurrentSource"
  >[];
};

export type SubagentRegistryWriteReceipt = {
  writeId: string;
  notices: SessionStateNotice[];
};
