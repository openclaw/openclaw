import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SHIELD_FILENAME } from "./workspace.js";

/**
 * Load and parse SHIELD.md directly from a workspace directory.
 * This reads the file from disk rather than relying on bootstrap context
 * (which may be filtered for lightweight/heartbeat/cron runs).
 */
export function loadShieldPolicyFromWorkspace(
  workspaceDir: string | undefined,
): ShieldPolicy | undefined {
  if (!workspaceDir) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(path.join(workspaceDir, DEFAULT_SHIELD_FILENAME), "utf-8");
    return parseShieldPolicy(content);
  } catch {
    return undefined;
  }
}

/**
 * Parse SHIELD.md content and extract tool policy rules from YAML frontmatter.
 *
 * Expected format:
 * ```
 * ---
 * tools:
 *   deny:
 *     - exec
 *     - browser
 * ---
 * ```
 */
export type ShieldPolicy = {
  deny: string[];
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseShieldPolicy(content: string | undefined): ShieldPolicy | undefined {
  if (!content?.trim()) {
    return undefined;
  }

  const match = FRONTMATTER_RE.exec(content);
  if (!match?.[1]) {
    return undefined;
  }

  // Simple YAML parsing for the deny list — avoid adding a YAML dependency.
  // Parse: tools:\n  deny:\n    - tool1\n    - tool2
  const yaml = match[1];
  const denyItems: string[] = [];
  let inDeny = false;

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "deny:" || trimmed === "deny: []") {
      inDeny = trimmed !== "deny: []";
      continue;
    }
    if (inDeny) {
      if (trimmed.startsWith("- ")) {
        denyItems.push(trimmed.slice(2).trim());
      } else {
        inDeny = false;
      }
    }
  }

  if (denyItems.length === 0) {
    return undefined;
  }
  return { deny: denyItems };
}
