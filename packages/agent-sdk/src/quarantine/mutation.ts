// @openclaw/agent-sdk — Mutation detection + quarantine for instruction files.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { hashFile } from "../hash.js";
// Instruction files list — kept in sync with index.ts
const INSTRUCTION_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "HEARTBEAT.md"] as const;
import type { IntegrityManifest } from "../index.js";

const INSTRUCTION_FILE_SET = new Set<string>(INSTRUCTION_FILES);

export interface MutationCheckResult {
  /** Whether all tracked files match their expected hashes. */
  clean: boolean;
  /** Files that have been modified since pack. */
  mutated: MutatedFile[];
  /** Files that are missing. */
  missing: string[];
  /** Files that are clean. */
  cleanFiles: string[];
}

export interface MutatedFile {
  path: string;
  expectedHash: string;
  actualHash: string;
}

export interface QuarantineRecord {
  packageName: string;
  quarantinedAt: string;
  reason: string;
  mutations: MutatedFile[];
  missingFiles: string[];
}

/**
 * Check all tracked instruction files against the integrity manifest.
 * Returns detailed result for each file.
 */
export function checkMutation(
  integrity: IntegrityManifest,
  workspacePath: string,
): MutationCheckResult {
  const mutated: MutatedFile[] = [];
  const missing: string[] = [];
  const cleanFiles: string[] = [];

  for (const [filePath, expectedHash] of Object.entries(integrity.files)) {
    const fullPath = resolve(workspacePath, filePath);

    if (!existsSync(fullPath)) {
      missing.push(filePath);
      continue;
    }

    const actualHash = hashFile(fullPath);
    if (actualHash !== expectedHash) {
      mutated.push({ path: filePath, expectedHash, actualHash });
    } else {
      cleanFiles.push(filePath);
    }
  }

  return {
    clean: mutated.length === 0 && missing.length === 0,
    mutated,
    missing,
    cleanFiles,
  };
}

/**
 * Quarantine a package: write quarantine record, restrict tools to read-only.
 */
export function quarantinePackage(
  packageName: string,
  integrity: IntegrityManifest,
  workspacePath: string,
): QuarantineRecord {
  const check = checkMutation(integrity, workspacePath);

  const record: QuarantineRecord = {
    packageName,
    quarantinedAt: new Date().toISOString(),
    reason: buildQuarantineReason(check),
    mutations: check.mutated,
    missingFiles: check.missing,
  };

  // Write quarantine record to workspace
  const quarantinePath = resolve(workspacePath, "agent-sdk-quarantine.json");
  writeFileSync(quarantinePath, JSON.stringify(record, null, 2) + "\n", "utf8");

  return record;
}

/**
 * Check if a package is currently quarantined.
 */
export function isQuarantined(workspacePath: string): boolean {
  const quarantinePath = resolve(workspacePath, "agent-sdk-quarantine.json");
  return existsSync(quarantinePath);
}

/**
 * Get the current quarantine record, if any.
 */
export function getQuarantineRecord(workspacePath: string): QuarantineRecord | null {
  const quarantinePath = resolve(workspacePath, "agent-sdk-quarantine.json");
  if (!existsSync(quarantinePath)) return null;
  try {
    return JSON.parse(readFileSync(quarantinePath, "utf8")) as QuarantineRecord;
  } catch {
    return null;
  }
}

/**
 * Lift quarantine: remove the quarantine record.
 * Should only be called after operator review.
 */
export function liftQuarantine(workspacePath: string): boolean {
  const quarantinePath = resolve(workspacePath, "agent-sdk-quarantine.json");
  if (!existsSync(quarantinePath)) return false;
  writeFileSync(quarantinePath, "", "utf8"); // Clear but keep file as audit trail
  writeFileSync(
    resolve(workspacePath, "agent-sdk-quarantine-lifted.json"),
    JSON.stringify({ liftedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
  return true;
}

/**
 * Get the list of tools allowed in quarantine mode (read-only).
 */
export function getQuarantineToolAllowlist(): string[] {
  return ["read", "memory_get", "memory_search"];
}

/**
 * Check if a tool is allowed in quarantine mode.
 */
export function isToolAllowedInQuarantine(toolName: string): boolean {
  return getQuarantineToolAllowlist().includes(toolName);
}

function buildQuarantineReason(check: MutationCheckResult): string {
  const parts: string[] = [];
  if (check.mutated.length > 0) {
    parts.push(`${check.mutated.length} instruction file(s) modified`);
  }
  if (check.missing.length > 0) {
    parts.push(`${check.missing.length} instruction file(s) missing`);
  }
  return parts.join("; ") || "unknown";
}
