// @openclaw/agent-sdk — Declarative upgrade: compute diff between old and new manifests.

import type { AgentPackageManifest, ConfigDiff, PolicyDeclaration } from "../index.js";
import { compileManifest } from "./compiler.js";

export interface UpgradeOptions {
  onUpgrade?: "preserve-custom" | "reset" | "prompt";
}

export interface UpgradeResult {
  oldVersion: string;
  newVersion: string;
  diff: ConfigDiff;
  preserved: string[];
  reset: string[];
  added: string[];
  removed: string[];
}

/**
 * Compute the upgrade diff from an old manifest to a new one.
 * No scripts, no hooks — purely declarative field-level diff.
 */
export function computeUpgrade(
  oldManifest: AgentPackageManifest,
  newManifest: AgentPackageManifest,
  options: UpgradeOptions = {},
): UpgradeResult {
  const onUpgrade = options.onUpgrade ?? newManifest.policy?.onUpgrade ?? "preserve-custom";

  const oldDiff = compileManifest(oldManifest, { strict: false });
  const newDiff = compileManifest(newManifest, { strict: false });

  const preserved: string[] = [];
  const reset: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  const allKeys = new Set([...Object.keys(oldDiff.changes), ...Object.keys(newDiff.changes)]);

  for (const key of allKeys) {
    const oldValue = oldDiff.changes[key];
    const newValue = newDiff.changes[key];

    if (!(key in newDiff.changes)) {
      // Field was in old but not in new
      removed.push(key);
    } else if (!(key in oldDiff.changes)) {
      // Field is new
      added.push(key);
    } else if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      // Field changed
      if (onUpgrade === "preserve-custom") {
        // Keep the old (user-customized) value
        preserved.push(key);
        // Remove from new diff so it doesn't get applied
        delete newDiff.changes[key];
      } else if (onUpgrade === "reset") {
        // Use the new (package default) value
        reset.push(key);
      } else {
        // prompt — in non-interactive mode, default to preserve
        preserved.push(key);
        delete newDiff.changes[key];
      }
    }
    // If values are equal, no action needed
  }

  // Add upgrade metadata
  newDiff.changes["agentPackages.upgradedAt"] = new Date().toISOString();
  newDiff.changes["agentPackages.previousVersion"] = oldManifest.version || "unknown";

  return {
    oldVersion: oldManifest.version || "unknown",
    newVersion: newManifest.version || "unknown",
    diff: newDiff,
    preserved,
    reset,
    added,
    removed,
  };
}

/**
 * Validate that an upgrade is safe (no destructive changes).
 */
export function validateUpgrade(result: UpgradeResult): { safe: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // Warn about removed fields
  if (result.removed.length > 0) {
    warnings.push(`Fields removed in upgrade: ${result.removed.join(", ")}`);
  }

  // Warn about version downgrade
  if (result.oldVersion !== "unknown" && result.newVersion !== "unknown") {
    const oldParts = result.oldVersion.split(".").map(Number);
    const newParts = result.newVersion.split(".").map(Number);
    if (newParts[0] < oldParts[0]) {
      warnings.push(`Major version downgrade: ${result.oldVersion} → ${result.newVersion}`);
    }
  }

  return {
    safe: warnings.length === 0,
    warnings,
  };
}
