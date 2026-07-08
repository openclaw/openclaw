// Persists the composed plan document under ~/.openclaw/agents/<agentId>/plans/.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentDir } from "../agent-scope-config.js";

const MAX_SLUG_LEN = 48;

function slugify(summary: string): string {
  const firstLine = summary.split(/\r?\n/, 1)[0] ?? "";
  const slug = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "");
  return slug || "plan";
}

function dateStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Resolves the plans directory (sibling of the agent workspace dir). */
export function resolvePlansDir(config: OpenClawConfig | undefined, agentId: string): string {
  const agentDir = resolveAgentDir(config ?? {}, agentId);
  return path.join(path.dirname(agentDir), "plans");
}

/**
 * Writes the plan document and returns its absolute path. The file name is
 * `plan-YYYY-MM-DD-<slug>.md`; re-composing a plan with the same first line the same day
 * overwrites the prior file intentionally, keeping one document per plan.
 */
export async function persistPlanFile(params: {
  config?: OpenClawConfig;
  agentId: string;
  summary: string;
  now?: number;
}): Promise<string> {
  const now =
    typeof params.now === "number" && Number.isFinite(params.now) ? params.now : Date.now();
  const dir = resolvePlansDir(params.config, params.agentId);
  await mkdir(dir, { recursive: true });
  const fileName = `plan-${dateStamp(now)}-${slugify(params.summary)}.md`;
  const filePath = path.join(dir, fileName);
  const body = `# Plan\n\n_Composed ${new Date(now).toISOString()}_\n\n${params.summary.trim()}\n`;
  await writeFile(filePath, body, "utf8");
  return filePath;
}
