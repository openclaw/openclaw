import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/core";
import { loadUsage } from "./telemetry.js";
import type { UsageEntry } from "./telemetry.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function findWorkspaceDir(ctx: PluginCommandContext): string {
  // Resolve workspace from agent config or fall back
  const workspaceDir = (
    typeof (ctx as Record<string, unknown>).workspaceDir === "string"
      ? (ctx as Record<string, unknown>).workspaceDir
      : undefined
  ) as string | undefined;
  return workspaceDir ?? process.cwd();
}

interface CuratorStatus {
  last_run_at: string | null;
  counts: {
    total: number;
    active: number;
    stale: number;
    archived: number;
    pinned: number;
  };
  pinned: string[];
  lru_top_5: Array<{ name: string; last_used_at: string | null; use_count: number }>;
}

async function buildStatus(workspaceDir: string): Promise<CuratorStatus> {
  const usage = await loadUsage(workspaceDir);
  const skills = Object.values(usage.skills);

  const counts = {
    total: skills.length,
    active: skills.filter((s) => s.state === "active").length,
    stale: skills.filter((s) => s.state === "stale").length,
    archived: skills.filter((s) => s.state === "archived").length,
    pinned: skills.filter((s) => s.pinned).length,
  };

  const pinned = skills.filter((s) => s.pinned).map((s) => s.name);

  // LRU top 5: sort by last_used_at ascending (oldest first = least recently used)
  const byLru = [...skills]
    .sort((a, b) => {
      const aTime = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
      const bTime = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
      return aTime - bTime;
    })
    .slice(0, 5)
    .map((s) => ({
      name: s.name,
      last_used_at: s.last_used_at,
      use_count: s.use_count,
    }));

  return {
    last_run_at: usage.updated_at,
    counts,
    pinned,
    lru_top_5: byLru,
  };
}

// ── Command registration ───────────────────────────────────────────────────

export function registerCuratorCli(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "curator",
    description: "Skill curator commands",
    subcommands: [
      {
        name: "status",
        description: "Show curator status: last run, counts, pinned list, LRU top 5",
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            const status = await buildStatus(workspaceDir);
            return {
              json: status,
              display: JSON.stringify(status, null, 2),
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator status error: ${message}` };
          }
        },
      },
    ],
  });
}
