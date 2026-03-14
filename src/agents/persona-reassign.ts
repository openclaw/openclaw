/**
 * Persona re-assignment — apply a different persona to an existing agent.
 *
 * Backs up existing workspace files before overwriting, keeps last 3 snapshots.
 */
import { readdir, mkdir, copyFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expandPersona, loadPersonaBySlug, type ExpansionResult } from "./persona-expansion.js";

// ── Workspace backup ────────────────────────────────────────────────────────

const MAX_SNAPSHOTS = 3;

/**
 * Backup workspace files to a timestamped snapshot directory.
 * Keeps last MAX_SNAPSHOTS snapshots, prunes older ones.
 */
export async function backupWorkspace(workspaceDir: string): Promise<string | null> {
  // Check if workspace exists
  try {
    await stat(workspaceDir);
  } catch {
    return null; // Nothing to backup
  }

  const bakRoot = join(workspaceDir + ".bak");
  await mkdir(bakRoot, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = join(bakRoot, timestamp);
  await mkdir(snapshotDir, { recursive: true });

  // Copy workspace files
  let filesCopied = 0;
  try {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        await copyFile(join(workspaceDir, entry.name), join(snapshotDir, entry.name));
        filesCopied++;
      }
    }
  } catch {
    // Workspace may be empty
  }

  if (filesCopied === 0) {
    // Clean up empty snapshot
    await rm(snapshotDir, { recursive: true }).catch(() => {});
    return null;
  }

  // Prune old snapshots — keep only MAX_SNAPSHOTS
  try {
    const snapshots = await readdir(bakRoot, { withFileTypes: true });
    const dirs = snapshots
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .toSorted()
      .toReversed(); // newest first

    for (let i = MAX_SNAPSHOTS; i < dirs.length; i++) {
      await rm(join(bakRoot, dirs[i]), { recursive: true }).catch(() => {});
    }
  } catch {
    // Prune failure is non-critical
  }

  return snapshotDir;
}

// ── Persona re-assignment ───────────────────────────────────────────────────

export interface ReassignResult {
  backupDir: string | null;
  expansion: ExpansionResult;
}

/**
 * Apply a different persona to an existing agent.
 *
 * 1. Backs up current workspace files
 * 2. Loads the new persona
 * 3. Expands into new workspace files + AGENT.md
 * 4. Returns results for the caller to write
 */
export async function reassignPersona(params: {
  personasDir: string;
  personaSlug: string;
  agentName: string;
  agentId: string;
  workspaceDir: string;
  overrides?: Record<string, unknown>;
}): Promise<ReassignResult | { error: string }> {
  // Load the new persona
  const persona = await loadPersonaBySlug(params.personasDir, params.personaSlug);
  if ("error" in persona) {
    return persona;
  }

  // Backup existing workspace
  const backupDir = await backupWorkspace(params.workspaceDir);

  // Expand new persona
  const expansion = await expandPersona(persona, {
    agentName: params.agentName,
    agentId: params.agentId,
    overrides: params.overrides,
  });
  if ("error" in expansion) {
    return expansion;
  }

  return { backupDir, expansion };
}

/**
 * Write expansion results to disk (AGENT.md + workspace files).
 */
export async function writeExpansionResult(params: {
  agentDir: string;
  workspaceDir: string;
  expansion: ExpansionResult;
}): Promise<void> {
  // Write AGENT.md
  await mkdir(params.agentDir, { recursive: true });
  await writeFile(join(params.agentDir, "AGENT.md"), params.expansion.agentMd, "utf-8");

  // Write workspace files
  await mkdir(params.workspaceDir, { recursive: true });
  for (const file of params.expansion.workspaceFiles) {
    await writeFile(join(params.workspaceDir, file.name), file.content, "utf-8");
  }
}
