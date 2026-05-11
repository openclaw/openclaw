import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/core";
import { resolveConfig, type CuratorConfig } from "./config.js";
import { writeRunLog } from "./logs.js";
import {
  adoptSkill,
  curatorRun,
  disownSkill,
  pauseCurator,
  pinSkill,
  resumeCurator,
  restoreSkill,
  unpinSkill,
} from "./run.js";
import { rotateSnapshots } from "./snapshot.js";
import { loadUsage } from "./telemetry.js";
import type { UsageEntry } from "./telemetry.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function findWorkspaceDir(ctx: PluginCommandContext): string {
  const workspaceDir = (
    typeof (ctx as Record<string, unknown>).workspaceDir === "string"
      ? (ctx as Record<string, unknown>).workspaceDir
      : undefined
  ) as string | undefined;
  return workspaceDir ?? process.cwd();
}

function resolveCuratorConfig(api: OpenClawPluginApi): CuratorConfig {
  return resolveConfig(api.pluginConfig);
}

interface CuratorStatus {
  last_run_at: string | null;
  paused: boolean;
  counts: {
    total: number;
    active: number;
    stale: number;
    archived: number;
    pinned: number;
    agent_created: number;
    user_created: number;
    unknown: number;
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
    agent_created: skills.filter((s) => s.created_by === "agent").length,
    user_created: skills.filter((s) => s.created_by === "user").length,
    unknown: skills.filter((s) => s.created_by === "unknown").length,
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
    last_run_at: usage.last_run_at,
    paused: usage.paused,
    counts,
    pinned,
    lru_top_5: byLru,
  };
}

// ── Command registration ───────────────────────────────────────────────────

export function registerCuratorCli(api: OpenClawPluginApi): void {
  const resolveConfig = () => resolveCuratorConfig(api);

  api.registerCommand({
    name: "curator",
    description: "Skill curator commands — manage skill lifecycle, telemetry, and archival",
    subcommands: [
      // ── status ─────────────────────────────────────────────────────────
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

      // ── run ────────────────────────────────────────────────────────────
      {
        name: "run",
        description: "Trigger curator review now",
        options: {
          sync: {
            type: "boolean",
            description: "Block until run completes",
          },
          "dry-run": {
            type: "boolean",
            description: "Preview only, no mutations",
          },
        },
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            const config = resolveConfig();
            const dryRun = (ctx.options?.["dry-run"] ?? false) as boolean;

            const result = await curatorRun({ workspaceDir, config, dryRun });

            // Write run logs if not a dry run
            let logDir: string | undefined;
            if (!dryRun) {
              try {
                logDir = await writeRunLog(result);
              } catch {
                // Non-critical — don't fail the command over log write
              }
            }

            const lines: string[] = [];
            lines.push(dryRun ? "DRY RUN — no mutations applied" : "Curator run complete");
            lines.push(`Timestamp: ${result.timestamp}`);

            if (result.error) {
              lines.push(`Info: ${result.error}`);
            }

            if (result.snapshotPath) {
              lines.push(`Snapshot: ${result.snapshotPath}`);
            }

            if (result.transitions.length > 0) {
              lines.push(`\nTransitions (${result.transitions.length}):`);
              for (const t of result.transitions) {
                lines.push(
                  `  ${t.name}: ${t.action} → ${t.newState} (unused ${t.daysSinceUsed.toFixed(0)}d)`,
                );
              }
            }

            if (result.mutations.length > 0) {
              lines.push(`\nMutations applied (${result.mutations.length}):`);
              for (const m of result.mutations) {
                lines.push(`  ${m.name}: ${m.oldState} → ${m.newState} (${m.action})`);
              }
            }

            if (result.transitions.length === 0 && !result.error) {
              lines.push("\nNo transitions needed. All skills are up to date.");
            }

            if (logDir) {
              lines.push(`\nRun log: ${logDir}`);
            }

            return { display: lines.join("\n") };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator run error: ${message}` };
          }
        },
      },

      // ── backup ─────────────────────────────────────────────────────────
      {
        name: "backup",
        description: "Manual snapshot of skills/",
        options: {
          reason: {
            type: "string",
            description: "Reason for manual backup",
          },
        },
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            const config = resolveConfig();
            const reason = (ctx.options?.reason as string) ?? undefined;

            const { createSnapshot } = await import("./snapshot.js");
            const snap = await createSnapshot(workspaceDir);
            await rotateSnapshots(workspaceDir, config.backup.keep);

            const lines = [
              `Backup created: ${snap.archivePath}`,
              `Size: ${(snap.sizeBytes / 1024).toFixed(1)} KB`,
              `Timestamp: ${snap.timestamp}`,
            ];
            if (reason) lines.push(`Reason: ${reason}`);

            return { display: lines.join("\n") };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator backup error: ${message}` };
          }
        },
      },

      // ── rollback ───────────────────────────────────────────────────────
      {
        name: "rollback",
        description: "Restore from a snapshot",
        options: {
          list: {
            type: "boolean",
            description: "List available snapshots",
          },
          id: {
            type: "string",
            description: "Snapshot timestamp to restore",
          },
        },
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            const backupsPath = path.join(workspaceDir, "skills", ".curator_backups");
            const list = (ctx.options?.list ?? false) as boolean;
            const id = ctx.options?.id as string | undefined;

            // List mode
            if (list) {
              let entries: string[] = [];
              try {
                const dirents = await fs.readdir(backupsPath, { withFileTypes: true });
                entries = dirents
                  .filter((e) => e.isDirectory() && e.name !== ".in-progress")
                  .map((e) => e.name)
                  .sort()
                  .reverse();
              } catch {
                // No backups dir
              }
              if (entries.length === 0) {
                return { display: "No snapshots found." };
              }
              const lines = ["Available snapshots:"];
              for (const entry of entries) {
                const stat = await fs
                  .stat(path.join(backupsPath, entry, "skills.tar.gz"))
                  .catch(() => null);
                const sizeStr = stat ? `${(stat.size / 1024).toFixed(1)} KB` : "?";
                lines.push(`  ${entry}  (${sizeStr})`);
              }
              return { display: lines.join("\n") };
            }

            // Restore mode
            if (!id) {
              return { display: "Usage: curator rollback --id <timestamp>" };
            }

            const archivePath = path.join(backupsPath, id, "skills.tar.gz");
            await fs.access(archivePath); // throws if not found

            // Pre-rollback snapshot
            const preRollbackSnap = await (
              await import("./snapshot.js")
            ).createSnapshot(workspaceDir);

            // Clean current skills/ (preserve .curator_backups and .archive)
            // so the extracted tree is byte-identical to the snapshot.
            const skillsDir = path.join(workspaceDir, "skills");
            const keepDirs = new Set([".curator_backups", ".archive"]);
            try {
              const entries = await fs.readdir(skillsDir, { withFileTypes: true });
              for (const entry of entries) {
                if (keepDirs.has(entry.name)) continue;
                await fs.rm(path.join(skillsDir, entry.name), {
                  recursive: true,
                  force: true,
                });
              }
            } catch {
              // skills/ may not exist yet — that's fine
            }

            // Extract tar.gz
            const { spawn } = await import("node:child_process");
            await new Promise<void>((resolve, reject) => {
              const child = spawn("tar", ["-xzf", archivePath, "-C", path.dirname(skillsDir)], {
                stdio: ["ignore", "ignore", "pipe"],
              });
              let stderr = "";
              child.stderr?.on("data", (d: Buffer) => {
                stderr += d.toString();
              });
              child.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`tar exited ${code}: ${stderr}`));
              });
              child.on("error", reject);
            });

            return {
              display: [
                `Rollback complete: restored ${id}`,
                `Pre-rollback snapshot saved at: ${preRollbackSnap.archivePath}`,
              ].join("\n"),
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator rollback error: ${message}` };
          }
        },
      },

      // ── pause / resume ─────────────────────────────────────────────────
      {
        name: "pause",
        description: "Pause the curator — no automatic runs until resumed",
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            await pauseCurator(workspaceDir);
            return { display: "Curator paused. No automatic runs will occur until resumed." };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator pause error: ${message}` };
          }
        },
      },
      {
        name: "resume",
        description: "Resume the curator after a pause",
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            await resumeCurator(workspaceDir);
            return { display: "Curator resumed. Next run at next interval check." };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator resume error: ${message}` };
          }
        },
      },

      // ── pin / unpin ────────────────────────────────────────────────────
      {
        name: "pin",
        description: "Pin a skill — immune to archival and deletion",
        options: {
          skill: {
            type: "string",
            description: "Skill name to pin",
            required: true,
          },
        },
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            const skillName = ctx.options?.skill as string;
            if (!skillName) return { display: "Usage: curator pin <skill>" };

            // Verify skill exists in usage
            const usage = await loadUsage(workspaceDir);
            const entry = usage.skills[skillName];
            if (!entry) {
              return { display: `Skill "${skillName}" not found in workspace.` };
            }

            // Refuse to pin bundled/hub skills
            if (entry.source === "bundled" || entry.source === "hub") {
              return { display: `Cannot pin ${entry.source} skill "${skillName}".` };
            }

            await pinSkill(workspaceDir, skillName);
            return { display: `Pinned: ${skillName}` };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator pin error: ${message}` };
          }
        },
      },
      {
        name: "unpin",
        description: "Unpin a skill — allows archival and deletion",
        options: {
          skill: {
            type: "string",
            description: "Skill name to unpin",
            required: true,
          },
        },
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            const skillName = ctx.options?.skill as string;
            if (!skillName) return { display: "Usage: curator unpin <skill>" };

            await unpinSkill(workspaceDir, skillName);
            return { display: `Unpinned: ${skillName}` };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator unpin error: ${message}` };
          }
        },
      },

      // ── restore ────────────────────────────────────────────────────────
      {
        name: "restore",
        description: "Restore a skill from archive",
        options: {
          skill: {
            type: "string",
            description: "Skill name to restore",
            required: true,
          },
        },
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            const skillName = ctx.options?.skill as string;
            if (!skillName) return { display: "Usage: curator restore <skill>" };

            await restoreSkill(workspaceDir, skillName);
            return { display: `Restored: ${skillName} (back to active)` };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator restore error: ${message}` };
          }
        },
      },

      // ── adopt ──────────────────────────────────────────────────────────
      {
        name: "adopt",
        description: "Mark a skill as agent-created so the curator manages it",
        options: {
          skill: {
            type: "string",
            description: "Skill name to adopt",
            required: true,
          },
        },
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            const skillName = ctx.options?.skill as string;
            if (!skillName) return { display: "Usage: curator adopt <skill>" };

            const usage = await loadUsage(workspaceDir);
            const entry = usage.skills[skillName];
            if (!entry) {
              return { display: `Skill "${skillName}" not found in workspace.` };
            }
            if (entry.source === "bundled" || entry.source === "hub") {
              return { display: `Cannot adopt ${entry.source} skill "${skillName}".` };
            }

            await adoptSkill(workspaceDir, skillName);
            return { display: `Adopted: ${skillName} (now agent-managed)` };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator adopt error: ${message}` };
          }
        },
      },

      // ── disown ─────────────────────────────────────────────────────────
      {
        name: "disown",
        description: "Mark a skill as user-owned — curator will leave it alone",
        options: {
          skill: {
            type: "string",
            description: "Skill name to disown",
            required: true,
          },
        },
        async run(ctx: PluginCommandContext): Promise<PluginCommandResult> {
          try {
            const workspaceDir = findWorkspaceDir(ctx);
            const skillName = ctx.options?.skill as string;
            if (!skillName) return { display: "Usage: curator disown <skill>" };

            await disownSkill(workspaceDir, skillName);
            return { display: `Disowned: ${skillName} (now user-managed)` };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { display: `curator disown error: ${message}` };
          }
        },
      },
    ],
  });
}
