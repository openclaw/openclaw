import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { findGitRoot, resolveGitHeadPath } from "../infra/git-root.js";
import type { RepoSlotRecord } from "./repo-slots.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getLatestSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import { persistSubagentRunsToDisk } from "./subagent-registry-state.js";
import type { SubagentOperatorState, SubagentRunRecord } from "./subagent-registry.types.js";

function dedupeFiles(paths: string[] | undefined): string[] | undefined {
  if (!Array.isArray(paths) || paths.length === 0) {
    return undefined;
  }
  return [...new Set(paths.map((entry) => entry.trim()).filter(Boolean))].slice(-12);
}

export function updateSubagentOperatorState(
  childSessionKey: string,
  mutate: (current: SubagentOperatorState) => SubagentOperatorState,
): boolean {
  const entry = getLatestSubagentRunByChildSessionKey(childSessionKey);
  if (!entry) {
    return false;
  }
  const nextState = mutate({ ...entry.operatorState });
  const nextEntry: SubagentRunRecord = {
    ...entry,
    operatorState: {
      ...nextState,
      ...(nextState.filesTouched ? { filesTouched: dedupeFiles(nextState.filesTouched) } : {}),
    },
  };
  subagentRuns.set(entry.runId, nextEntry);
  persistSubagentRunsToDisk(subagentRuns);
  return true;
}

export async function mirrorSubagentOperatorStateToSession(
  childSessionKey: string,
  operatorState: SubagentOperatorState,
): Promise<void> {
  const cfg = loadConfig();
  const parsed = childSessionKey.match(/^agent:([^:]+):/);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: parsed?.[1],
  });
  await updateSessionStore(storePath, (store) => {
    const current = store[childSessionKey];
    if (!current) {
      return current;
    }
    store[childSessionKey] = {
      ...current,
      pluginDebugEntries: [
        ...(current.pluginDebugEntries ?? []).filter(
          (entry) => entry.pluginId !== "subagent-operator-state",
        ),
        {
          pluginId: "subagent-operator-state",
          lines: buildSubagentOperatorStatusLines(operatorState),
        },
      ],
    };
    return store[childSessionKey];
  });
}

export function buildSubagentOperatorStatusLines(state: SubagentOperatorState): string[] {
  const lines: string[] = [];
  if (state.stage) {
    lines.push(`Subagent stage: ${state.stage}`);
  }
  if (state.lastToolName) {
    lines.push(
      `Last tool: ${state.lastToolName}${state.lastToolAction ? ` (${state.lastToolAction})` : ""}`,
    );
  }
  if (state.waitingReason) {
    lines.push(`Waiting: ${state.waitingReason}`);
  }
  if (state.blocker) {
    lines.push(`Blocker: ${state.blocker}`);
  }
  if (state.filesTouched?.length) {
    lines.push(`Files: ${state.filesTouched.join(", ")}`);
  }
  if (state.verificationStatus) {
    lines.push(
      `Verification: ${state.verificationStatus}${state.verificationNote ? ` (${state.verificationNote})` : ""}`,
    );
  }
  if (state.progressNote) {
    lines.push(`Progress: ${state.progressNote}`);
  }
  return lines;
}

function readRepoSlotRecordForWorkspace(workspaceDir: string): RepoSlotRecord | null {
  const slotPath = path.join(path.dirname(workspaceDir), "slot.json");
  try {
    return JSON.parse(fs.readFileSync(slotPath, "utf8")) as RepoSlotRecord;
  } catch {
    return null;
  }
}

export function resolveWorkspaceGitSummary(workspaceDir?: string): {
  workspaceDir?: string;
  workspaceSlot?: string;
  repo?: string;
  branch?: string;
} {
  const trimmed = workspaceDir?.trim();
  if (!trimmed) {
    return {};
  }
  const repoSlotRecord = readRepoSlotRecordForWorkspace(trimmed);
  const workspaceSlot = repoSlotRecord?.slot ?? path.basename(trimmed);
  const repoRoot = findGitRoot(trimmed) ?? undefined;
  const headPath = resolveGitHeadPath(trimmed) ?? undefined;
  let branch: string | undefined;
  if (headPath) {
    try {
      const raw = fs.readFileSync(headPath, "utf8").trim();
      const match = raw.match(/^ref:\s+refs\/heads\/(.+)$/);
      branch = match?.[1]?.trim() || undefined;
    } catch {
      branch = undefined;
    }
  }
  return {
    workspaceDir: trimmed,
    workspaceSlot,
    repo: repoSlotRecord?.repoName ?? (repoRoot ? path.basename(repoRoot) : workspaceSlot),
    branch: branch ?? repoSlotRecord?.branch,
  };
}
