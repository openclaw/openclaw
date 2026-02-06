/**
 * void-reflection · reflector
 *
 * The core "空" logic: reads accumulated observations and session memory,
 * sends them to an LLM for pattern analysis, and persists the resulting
 * reflection as both `current.md` (for prompt injection) and an archived
 * snapshot.
 *
 * Since extensions cannot directly import internal openclaw modules,
 * we resolve `runEmbeddedPiAgent` at runtime via dynamic import.
 * If the import fails, a pure statistical (no-LLM) reflection is generated
 * as a graceful fallback.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { VoidStore } from "./store.js";
import type { Observation, VoidReflectionConfig } from "./types.js";

export type Reflector = ReturnType<typeof createReflector>;

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

function buildReflectionPrompt(
  observationsSummary: string,
  memorySummary: string,
  previousReflection: string | null,
): string {
  const parts: string[] = [];

  parts.push(`You are performing a **self-reflection** on your own recent behaviour as an AI agent.
Your goal is to discover patterns, identify recurring errors, recognise strengths,
and produce concrete improvement suggestions for your future self.

Write in **first person** ("I noticed…", "I should…").
Be concise — aim for 300-600 words.
Use markdown with clear headings.`);

  parts.push(`\n## Recent Run Observations (newest last)\n\n${observationsSummary}`);

  if (memorySummary) {
    parts.push(`\n## Recent Conversation Memories\n\n${memorySummary}`);
  }

  if (previousReflection) {
    parts.push(`\n## My Previous Reflection\n\n${previousReflection}`);
    parts.push(
      `\nCompare the current data with your previous reflection.
Note what has improved and what still needs work.`,
    );
  }

  parts.push(`\n## Output Format

Produce a markdown document with these sections:

### Patterns Observed
- What kinds of tasks am I handling most?
- Are there recurring topics or domains?

### Error Analysis
- What types of errors appeared? How often?
- Are there patterns in failures (e.g. always the same tool, same kind of request)?

### Strengths
- What am I consistently good at?

### Improvement Suggestions
- Concrete, actionable items I should focus on in future runs.
- If possible, suggest prompt adjustments or tool usage changes.

### Self-Assessment Score
Rate myself 1-10 on: reliability, speed, helpfulness, tool efficiency.
`);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Observation summariser (pure text — no LLM)
// ---------------------------------------------------------------------------

function summariseObservations(observations: Observation[]): string {
  if (observations.length === 0) return "(no observations yet)";

  const total = observations.length;
  const successes = observations.filter((o) => o.success).length;
  const failures = total - successes;
  const withDuration = observations.filter((o) => o.durationMs != null);
  const avgDuration =
    withDuration.reduce((s, o) => s + (o.durationMs ?? 0), 0) / (withDuration.length || 1);
  const totalTools = observations.reduce((s, o) => s + o.toolCount, 0);
  const totalMessages = observations.reduce((s, o) => s + o.messageCount, 0);

  // Error breakdown
  const errorCounts: Record<string, number> = {};
  for (const o of observations) {
    if (o.error) {
      const key = o.error.slice(0, 80);
      errorCounts[key] = (errorCounts[key] ?? 0) + 1;
    }
  }

  // Session breakdown
  const sessionCounts: Record<string, number> = {};
  for (const o of observations) {
    sessionCounts[o.sessionKey] = (sessionCounts[o.sessionKey] ?? 0) + 1;
  }

  const lines: string[] = [
    `**Period**: ${observations[0].timestamp} → ${observations[total - 1].timestamp}`,
    `**Total runs**: ${total}  |  **Success**: ${successes}  |  **Failures**: ${failures}  |  **Success rate**: ${((successes / total) * 100).toFixed(1)}%`,
    `**Avg duration**: ${Math.round(avgDuration)}ms  |  **Total tool calls**: ${totalTools}  |  **Total messages**: ${totalMessages}`,
  ];

  if (Object.keys(errorCounts).length > 0) {
    lines.push("\n**Error breakdown**:");
    for (const [msg, count] of Object.entries(errorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)) {
      lines.push(`- (${count}x) ${msg}`);
    }
  }

  if (Object.keys(sessionCounts).length > 1) {
    lines.push("\n**Sessions**:");
    for (const [key, count] of Object.entries(sessionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)) {
      lines.push(`- ${key}: ${count} runs`);
    }
  }

  // Recent 5 observations verbatim (for LLM to see raw data)
  lines.push("\n**Latest 5 runs**:");
  for (const o of observations.slice(-5)) {
    const status = o.success ? "OK" : `FAIL: ${o.error ?? "unknown"}`;
    lines.push(
      `- ${o.timestamp} | ${o.sessionKey} | ${status} | ${o.durationMs ?? "?"}ms | tools:${o.toolCount} msgs:${o.messageCount}`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dynamic internal module resolver
// ---------------------------------------------------------------------------

/**
 * Attempt to dynamically import `runEmbeddedPiAgent` and agent-scope helpers
 * from the compiled openclaw dist. This is necessary because extensions can
 * only import `openclaw` and `openclaw/plugin-sdk` via package.json exports,
 * but the agent runner lives in internal modules.
 */
async function resolveInternals(): Promise<{
  runEmbeddedPiAgent: (params: Record<string, unknown>) => Promise<{
    payloads?: Array<{ text?: string }>;
  }>;
  resolveDefaultAgentId: (cfg: Record<string, unknown>) => string;
  resolveAgentWorkspaceDir: (cfg: Record<string, unknown>, agentId: string) => string;
  resolveAgentDir: (cfg: Record<string, unknown>, agentId: string) => string;
} | null> {
  try {
    const require = createRequire(import.meta.url);
    const openclawMain = require.resolve("openclaw");
    // openclawMain → .../openclaw/dist/index.js
    const distRoot = path.dirname(openclawMain);

    const runnerPath = path.join(distRoot, "agents", "pi-embedded-runner", "run.js");
    const scopePath = path.join(distRoot, "agents", "agent-scope.js");

    const [runnerMod, scopeMod] = await Promise.all([
      import(runnerPath),
      import(scopePath),
    ]);

    return {
      runEmbeddedPiAgent: runnerMod.runEmbeddedPiAgent,
      resolveDefaultAgentId: scopeMod.resolveDefaultAgentId,
      resolveAgentWorkspaceDir: scopeMod.resolveAgentWorkspaceDir,
      resolveAgentDir: scopeMod.resolveAgentDir,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback: pure statistical reflection (no LLM)
// ---------------------------------------------------------------------------

function buildStatisticalReflection(observations: Observation[], memorySummary: string): string {
  const summary = summariseObservations(observations);
  const lines: string[] = [
    "### Patterns Observed",
    "",
    summary,
    "",
  ];

  if (memorySummary) {
    lines.push("### Recent Memory Context", "", memorySummary, "");
  }

  lines.push(
    "### Note",
    "",
    "_This is a statistical summary only. LLM-based deep analysis was unavailable._",
    "_The next reflection cycle will attempt LLM analysis again._",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reflector
// ---------------------------------------------------------------------------

export function createReflector(
  store: VoidStore,
  config: VoidReflectionConfig,
  api: OpenClawPluginApi,
) {
  const log = api.logger;

  /**
   * Perform a full reflection cycle:
   *   1. Read observations + memory
   *   2. Build prompt
   *   3. Call LLM (or fallback to statistical)
   *   4. Write current.md + archive
   */
  async function reflect(workspaceDir: string): Promise<void> {
    let tempSessionFile: string | null = null;

    try {
      // 1. Gather data
      const observations = await store.readObservations(workspaceDir, config.maxObservations);
      if (observations.length === 0) {
        log.info("No observations to reflect on — skipping.");
        return;
      }

      const observationsSummary = summariseObservations(observations);

      // Read recent memory files for broader context
      const memoryFiles = await store.readRecentMemoryFiles(workspaceDir, 5);
      let memorySummary = "";
      for (const f of memoryFiles) {
        const content = await store.readMemoryFile(workspaceDir, f);
        if (content) {
          memorySummary += `### ${f}\n${content.slice(0, 500)}\n\n`;
        }
      }

      // Previous reflection (for continuity)
      const previousReflection = await store.readCurrent(workspaceDir);

      // 2. Attempt LLM reflection
      let reflectionText: string | null = null;

      const internals = await resolveInternals();
      const cfg = api.config;

      if (internals && cfg) {
        try {
          const prompt = buildReflectionPrompt(observationsSummary, memorySummary, previousReflection);
          const agentId = internals.resolveDefaultAgentId(cfg);
          const agentWorkspaceDir = internals.resolveAgentWorkspaceDir(cfg, agentId);
          const agentDir = internals.resolveAgentDir(cfg, agentId);

          // Temporary session file for the one-off LLM call
          const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-void-"));
          tempSessionFile = path.join(tempDir, "session.jsonl");

          const result = await internals.runEmbeddedPiAgent({
            sessionId: `void-reflection-${Date.now()}`,
            sessionKey: "temp:void-reflection",
            sessionFile: tempSessionFile,
            workspaceDir: agentWorkspaceDir,
            agentDir,
            config: cfg,
            prompt,
            disableTools: true,
            timeoutMs: 60_000,
            runId: `void-reflect-${Date.now()}`,
            ...(config.reflectionModel ? { model: config.reflectionModel } : {}),
          });

          if (result.payloads && result.payloads.length > 0) {
            reflectionText = result.payloads
              .map((p: { text?: string }) => p.text ?? "")
              .filter(Boolean)
              .join("\n\n");
          }
        } catch (err) {
          log.warn(
            `LLM reflection failed, falling back to statistical: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // 3. Fallback to statistical reflection if LLM unavailable
      if (!reflectionText?.trim()) {
        reflectionText = buildStatisticalReflection(observations, memorySummary);
        log.info("Generated statistical reflection (LLM unavailable).");
      }

      // 4. Add metadata header and persist
      const now = new Date();
      const header = [
        `# Void Reflection (空) — ${now.toISOString().split("T")[0]}`,
        "",
        `> Auto-generated self-reflection based on ${observations.length} observations.`,
        `> Period: ${observations[0].timestamp} → ${observations[observations.length - 1].timestamp}`,
        "",
      ].join("\n");

      const fullReflection = header + reflectionText;

      await store.writeCurrent(workspaceDir, fullReflection);
      const archivePath = await store.writeReflectionArchive(workspaceDir, fullReflection);

      log.info(`Reflection complete. Analysed ${observations.length} observations. Archived → ${archivePath}`);
    } catch (err) {
      log.warn(
        `Reflection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (tempSessionFile) {
        try {
          await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  return { reflect };
}
