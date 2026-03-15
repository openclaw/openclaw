import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "./workspace";

export type SubagentRegistryEntry = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  label?: string;
  createdAt?: number;
  endedAt?: number;
  outcome?: { status: string; error?: string };
};

export function readSubagentRegistry(): SubagentRegistryEntry[] {
  const registryPath = join(resolveOpenClawStateDir(), "subagents", "runs.json");
  if (!existsSync(registryPath)) {
    return [];
  }

  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      runs?: Record<string, SubagentRegistryEntry>;
    };
    return Object.values(raw.runs ?? {});
  } catch {
    return [];
  }
}

export function resolveSubagentStatus(
  entry: SubagentRegistryEntry,
): "running" | "completed" | "error" {
  if (typeof entry.endedAt !== "number") {
    return "running";
  }
  if (entry.outcome?.status === "error") {
    return "error";
  }
  return "completed";
}

export function listSubagentsForRequesterSession(
  requesterSessionKey: string,
): Array<SubagentRegistryEntry & { status: "running" | "completed" | "error" }> {
  return readSubagentRegistry()
    .filter((entry) => entry.requesterSessionKey === requesterSessionKey)
    .map((entry) => ({
      ...entry,
      status: resolveSubagentStatus(entry),
    }))
    .toSorted((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}
