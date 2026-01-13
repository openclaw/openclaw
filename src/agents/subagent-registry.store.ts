import path from "node:path";

import { STATE_DIR_CLAWDBOT } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { SubagentRunRecord } from "./subagent-registry.js";

export type PersistedSubagentRegistryVersion = 1;

type PersistedSubagentRegistry = {
  version: 1;
  runs: Record<string, SubagentRunRecord>;
};

const REGISTRY_VERSION = 1 as const;

export function resolveSubagentRegistryPath(): string {
  return path.join(STATE_DIR_CLAWDBOT, "subagents", "runs.json");
}

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  const pathname = resolveSubagentRegistryPath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") return new Map();
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== REGISTRY_VERSION) return new Map();
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") return new Map();
  const out = new Map<string, SubagentRunRecord>();
  for (const [runId, entry] of Object.entries(runsRaw)) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as SubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") continue;
    out.set(runId, typed);
  }
  return out;
}

export function saveSubagentRegistryToDisk(
  runs: Map<string, SubagentRunRecord>,
) {
  const pathname = resolveSubagentRegistryPath();
  const out: PersistedSubagentRegistry = {
    version: REGISTRY_VERSION,
    runs: Object.fromEntries(runs.entries()),
  };
  saveJsonFile(pathname, out);
}
