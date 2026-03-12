import { loadAllSubagentRunsFromDb, saveAllSubagentRunsToDb } from "./subagent-registry-sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type PersistedSubagentRegistryVersion = 1 | 2;

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  return loadAllSubagentRunsFromDb();
}

export function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>) {
  saveAllSubagentRunsToDb(runs);
}
