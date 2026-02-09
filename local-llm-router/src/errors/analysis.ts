/**
 * Daily error analysis — uses expensive cloud model to:
 * 1. Read the error journal (last 24h)
 * 2. Read previous analysis reports for trends
 * 3. Read current skills + config
 * 4. Identify patterns and root causes
 * 5. Generate fix proposals (diffs to skills/config)
 * 6. Notify user via Telegram
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ErrorEntry, ModelRef } from "../types.js";
import { ErrorJournal } from "./journal.js";
import { callModelSimple } from "../shared/pi-bridge.js";
import { loadAllSkills } from "../shared/skill-loader.js";

export interface AnalysisReport {
  date: string;
  errorCount: number;
  failureRate: number;
  patterns: AnalysisPattern[];
  proposals: Proposal[];
}

export interface AnalysisPattern {
  description: string;
  occurrences: number;
  rootCause: string;
  severity: "low" | "medium" | "high";
}

export interface Proposal {
  id: string;
  priority: "low" | "medium" | "high";
  confidence: number;
  problem: string;
  affectedFiles: string[];
  changes: ProposalChange[];
}

export interface ProposalChange {
  filePath: string;
  description: string;
  diff: string; // Markdown diff block
}

/**
 * Run the daily error analysis.
 */
export async function runDailyAnalysis(params: {
  projectRoot: string;
  errorJournal: ErrorJournal;
  analysisModel: ModelRef;
  totalTasksToday?: number;
}): Promise<AnalysisReport> {
  const { projectRoot, errorJournal, analysisModel } = params;
  const today = new Date().toISOString().split("T")[0];

  // 1. Gather recent errors
  const recentErrors = await errorJournal.readRecent(24);

  if (recentErrors.length === 0) {
    const emptyReport: AnalysisReport = {
      date: today,
      errorCount: 0,
      failureRate: 0,
      patterns: [],
      proposals: [],
    };
    await saveReport(projectRoot, today, emptyReport);
    return emptyReport;
  }

  // 2. Load previous reports for trend analysis
  const previousReports = await loadRecentReports(projectRoot, 7);

  // 3. Load current skills
  const skills = await loadAllSkills(path.join(projectRoot, "skills"));
  const skillSummary = Array.from(skills.values())
    .map((s) => `- ${s.name} (${s.tier}): ${s.description}`)
    .join("\n");

  // 4. Load current config
  const userMd = await safeReadFile(path.join(projectRoot, "config", "USER.md"));
  const routesJson = await safeReadFile(path.join(projectRoot, "config", "routes.json"));

  // 5. Build analysis prompt
  const prompt = buildAnalysisPrompt({
    errors: recentErrors,
    previousReports,
    skillSummary,
    userMd,
    routesJson,
    today,
    totalTasks: params.totalTasksToday ?? 0,
  });

  // 6. Call expensive model
  const raw = await callModelSimple(analysisModel, prompt, {
    systemPrompt: ANALYSIS_SYSTEM_PROMPT,
    maxTokens: 8192,
    temperature: 0.3,
  });

  // 7. Parse response
  const report = parseAnalysisResponse(raw, today, recentErrors.length, params.totalTasksToday ?? 0);

  // 8. Save report and proposals
  await saveReport(projectRoot, today, report);

  for (const proposal of report.proposals) {
    await saveProposal(projectRoot, proposal);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM_PROMPT = `You are an error analysis system for a personal AI assistant.
Analyze errors, identify patterns, find root causes, and propose concrete fixes.

Your output must be valid JSON matching this schema:
{
  "patterns": [
    {
      "description": "Brief description of the pattern",
      "occurrences": <number>,
      "rootCause": "Why this keeps happening",
      "severity": "low|medium|high"
    }
  ],
  "proposals": [
    {
      "id": "fix-NNN",
      "priority": "low|medium|high",
      "confidence": <0-1>,
      "problem": "What's wrong",
      "affectedFiles": ["path/to/file"],
      "changes": [
        {
          "filePath": "path/to/file",
          "description": "What to change",
          "diff": "diff block with - old line and + new line"
        }
      ]
    }
  ]
}

Focus on actionable fixes to skills (SKILL.md files), config (USER.md, routes.json), or routing rules.
Only propose changes you're confident about (>0.7).`;

function buildAnalysisPrompt(params: {
  errors: ErrorEntry[];
  previousReports: string[];
  skillSummary: string;
  userMd: string;
  routesJson: string;
  today: string;
  totalTasks: number;
}): string {
  const errorSummary = params.errors
    .map(
      (e) =>
        `[${e.type}] agent=${e.agent} skill=${e.skill ?? "none"} model=${e.model} task="${e.task}" context=${JSON.stringify(e.context)}`,
    )
    .join("\n");

  const previousSummary =
    params.previousReports.length > 0
      ? params.previousReports.join("\n---\n")
      : "No previous reports.";

  return `# Daily Error Analysis — ${params.today}

## Errors in last 24h (${params.errors.length} errors, ${params.totalTasks} total tasks)

${errorSummary}

## Previous Analysis Reports (last 7 days)

${previousSummary}

## Current Skills

${params.skillSummary}

## Current USER.md

${params.userMd}

## Current routes.json

${params.routesJson}

Analyze these errors. Identify recurring patterns, root causes, and propose specific fixes as JSON.`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseAnalysisResponse(
  raw: string,
  date: string,
  errorCount: number,
  totalTasks: number,
): AnalysisReport {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      date,
      errorCount,
      failureRate: totalTasks > 0 ? errorCount / totalTasks : 0,
      patterns: [],
      proposals: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      date,
      errorCount,
      failureRate: totalTasks > 0 ? errorCount / totalTasks : 0,
      patterns: parsed.patterns ?? [],
      proposals: parsed.proposals ?? [],
    };
  } catch {
    return {
      date,
      errorCount,
      failureRate: totalTasks > 0 ? errorCount / totalTasks : 0,
      patterns: [],
      proposals: [],
    };
  }
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

async function saveReport(
  projectRoot: string,
  date: string,
  report: AnalysisReport,
): Promise<void> {
  const dir = path.join(projectRoot, "errors", "analysis");
  await fs.mkdir(dir, { recursive: true });

  const markdown = [
    `# Daily Error Analysis — ${date}`,
    "",
    `## Summary`,
    `- Errors: ${report.errorCount}`,
    `- Failure rate: ${(report.failureRate * 100).toFixed(1)}%`,
    `- Patterns found: ${report.patterns.length}`,
    `- Proposals: ${report.proposals.length}`,
    "",
    ...(report.patterns.length > 0
      ? [
          "## Patterns",
          "",
          ...report.patterns.map(
            (p) =>
              `### ${p.description}\n- Occurrences: ${p.occurrences}\n- Root cause: ${p.rootCause}\n- Severity: ${p.severity}`,
          ),
          "",
        ]
      : []),
    ...(report.proposals.length > 0
      ? [
          "## Proposals",
          "",
          ...report.proposals.map(
            (p) =>
              `### ${p.id}: ${p.problem}\n- Priority: ${p.priority}\n- Confidence: ${(p.confidence * 100).toFixed(0)}%\n- Files: ${p.affectedFiles.join(", ")}`,
          ),
        ]
      : []),
  ].join("\n");

  await fs.writeFile(path.join(dir, `${date}.md`), markdown, "utf-8");
}

async function saveProposal(
  projectRoot: string,
  proposal: Proposal,
): Promise<void> {
  const dir = path.join(projectRoot, "errors", "proposals", "pending");
  await fs.mkdir(dir, { recursive: true });

  const markdown = [
    `# Proposal: ${proposal.id}`,
    `> **Priority**: ${proposal.priority}`,
    `> **Confidence**: ${(proposal.confidence * 100).toFixed(0)}%`,
    `> **Affects**: ${proposal.affectedFiles.join(", ")}`,
    "",
    `## Problem`,
    proposal.problem,
    "",
    "## Changes",
    "",
    ...proposal.changes.map(
      (c) => `### ${c.filePath}\n${c.description}\n\n${c.diff}`,
    ),
  ].join("\n");

  await fs.writeFile(
    path.join(dir, `${proposal.id}.md`),
    markdown,
    "utf-8",
  );
}

async function loadRecentReports(
  projectRoot: string,
  daysBack: number,
): Promise<string[]> {
  const dir = path.join(projectRoot, "errors", "analysis");
  const reports: string[] = [];

  const today = new Date();
  for (let i = 1; i <= daysBack; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];

    try {
      const content = await fs.readFile(path.join(dir, `${dateStr}.md`), "utf-8");
      reports.push(content);
    } catch {
      // No report for this day
    }
  }

  return reports;
}

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "(file not found)";
  }
}
