import { isAgentCreated, loadUsage, type UsageEntry } from "./telemetry.js";
import type { TransitionThresholds } from "./transitions.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ReviewSkillEntry {
  name: string;
  description: string;
  last_used_at: string | null;
  use_count: number;
  view_count: number;
  state: string;
}

export type ReviewAction =
  | { action: "keep" }
  | { action: "patch"; old_string: string; new_string: string }
  | { action: "consolidate"; merge_target: string; new_content: string }
  | { action: "archive"; reason: string };

export interface ReviewResponse {
  decisions: ReviewAction[];
}

export interface ReviewManifest {
  skills: ReviewSkillEntry[];
  workspaceDir: string;
}

// ── System prompt ───────────────────────────────────────────────────────────

export const CURATOR_SYSTEM_PROMPT = `You are a curator. Your job is to maintain a clean, useful set of workspace skills for an AI agent.

For each skill listed below, decide one of:
- **keep** — the skill is still useful as-is
- **patch** — the skill has a specific issue you can fix with a small edit (provide old_string + new_string)
- **consolidate** — this skill overlaps with another; merge them (provide merge_target + new_content)
- **archive** — this skill is no longer useful (provide a brief reason)

**Rules:**
- Be conservative. When in doubt, keep.
- Do NOT archive or mutate pinned skills (they won't be in the manifest).
- Do NOT propose patches without providing exact old_string and new_string.
- old_string must match exactly one occurrence in the skill content.
- Do NOT reference paths outside the workspace skills/ directory.
- Do NOT propose archiving the .archive directory itself.

Respond with a single JSON object containing a "decisions" array. Example:
{
  "decisions": [
    { "action": "keep" },
    { "action": "archive", "reason": "No longer relevant — workflow was specific to a one-time migration." },
    { "action": "patch", "old_string": "Use port 3000", "new_string": "Use port 8080" },
    { "action": "consolidate", "merge_target": "git-workflow", "new_content": "# Combined Git Workflow\\n\\n..." }
  ]
}

Only include entries in the decisions array for skills that need action (keep is implicit when absent).`;

// ── Manifest builder ────────────────────────────────────────────────────────

/**
 * Build a manifest of agent-created, non-pinned, non-archived skills
 * suitable for sending to the LLM reviewer.
 */
export async function buildReviewManifest(workspaceDir: string): Promise<ReviewManifest> {
  const usage = await loadUsage(workspaceDir);
  const skills: ReviewSkillEntry[] = [];

  for (const entry of Object.values(usage.skills)) {
    // Skip pinned, archived, bundled, hub, and non-agent-created
    if (entry.pinned) continue;
    if (entry.state === "archived") continue;
    if (entry.source === "bundled" || entry.source === "hub") continue;
    if (!isAgentCreated(entry)) continue;

    skills.push({
      name: entry.name,
      description: `Skill "${entry.name}" (used ${entry.use_count} times, last used ${entry.last_used_at ?? "never"})`,
      last_used_at: entry.last_used_at,
      use_count: entry.use_count,
      view_count: entry.view_count,
      state: entry.state,
    });
  }

  return { skills, workspaceDir };
}

// ── Response parser / validator ─────────────────────────────────────────────

const VALID_ACTIONS = new Set(["keep", "patch", "consolidate", "archive"]);

/**
 * Parse and validate the LLM's JSON response.
 * Returns validated decisions, rejecting malformed actions.
 */
export function parseReviewResponse(raw: string): ReviewResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse curator review response as JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Curator review response must be a JSON object with a 'decisions' array");
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.decisions)) {
    throw new Error("Curator review response missing 'decisions' array");
  }

  const decisions: ReviewAction[] = [];

  for (let i = 0; i < obj.decisions.length; i++) {
    const item = obj.decisions[i];
    if (!item || typeof item !== "object") {
      throw new Error(`Decision ${i} is not an object`);
    }

    const d = item as Record<string, unknown>;
    const action = d.action;

    if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
      throw new Error(`Decision ${i}: invalid action "${String(action)}"`);
    }

    if (action === "keep") {
      decisions.push({ action: "keep" });
    } else if (action === "patch") {
      if (typeof d.old_string !== "string" || typeof d.new_string !== "string") {
        throw new Error(`Decision ${i}: patch requires old_string and new_string`);
      }
      if (d.old_string === d.new_string) {
        throw new Error(`Decision ${i}: patch old_string and new_string must differ`);
      }
      // Reject path traversal attempts
      if (d.old_string.includes("../") || d.new_string.includes("../")) {
        throw new Error(`Decision ${i}: path traversal rejected`);
      }
      decisions.push({
        action: "patch",
        old_string: d.old_string,
        new_string: d.new_string,
      });
    } else if (action === "consolidate") {
      if (typeof d.merge_target !== "string" || typeof d.new_content !== "string") {
        throw new Error(`Decision ${i}: consolidate requires merge_target and new_content`);
      }
      if (d.merge_target.includes("../")) {
        throw new Error(`Decision ${i}: merge_target path traversal rejected`);
      }
      decisions.push({
        action: "consolidate",
        merge_target: d.merge_target,
        new_content: d.new_content,
      });
    } else if (action === "archive") {
      const reason = typeof d.reason === "string" ? d.reason : "No reason provided";
      decisions.push({ action: "archive", reason });
    }
  }

  return { decisions };
}

/**
 * Validate that a patch operation can be safely applied:
 * - old_string must appear exactly once in content
 * - target path must be within skills/
 */
export function validatePatchAction(
  content: string,
  oldString: string,
  skillName: string,
): { valid: true } | { valid: false; error: string } {
  // Reject path traversal
  if (oldString.includes("../") || skillName.includes("../") || skillName.includes(".archive")) {
    return { valid: false, error: "Path traversal or .archive reference rejected" };
  }

  // Count exact matches
  const parts = content.split(oldString);
  const count = parts.length - 1;

  if (count === 0) {
    return { valid: false, error: `old_string not found in ${skillName}` };
  }
  if (count > 1) {
    return {
      valid: false,
      error: `old_string matches ${count} times in ${skillName} (must match exactly once)`,
    };
  }

  // Guard against edits to bundled/hub skills via path manipulation
  if (skillName.startsWith(".")) {
    return { valid: false, error: "Cannot patch hidden directory skills" };
  }

  return { valid: true };
}
