#!/usr/bin/env node
/**
 * PR Triage — AI-powered duplicate detection and categorization.
 *
 * Single Claude call per PR with cached context of all open PRs
 * and recent merge/close decisions. Outputs silent labels only — no
 * public bot comments (political risk: matplotlib/crabby-rathbun Feb 2026).
 *
 * Default model: Claude Opus 4.6 (1M context). Override with TRIAGE_MODEL env var.
 * Cost tracking built-in — logs per-call and cumulative costs.
 */

import { appendFileSync } from "node:fs";

const REPO = process.env.REPO;
const PR_NUMBER = Number(process.env.PR_NUMBER) || 0;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const DRY_RUN = !ANTHROPIC_API_KEY || process.env.DRY_RUN === "1";
if (DRY_RUN) {
  console.log("DRY RUN: no ANTHROPIC_API_KEY or DRY_RUN=1 — will skip LLM call and label application");
}
if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const GITHUB_API = "https://api.github.com";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.TRIAGE_MODEL || "claude-opus-4-6";
const MAX_OPEN_PRS = Number(process.env.MAX_OPEN_PRS) || 500;
const MAX_HISTORY = Number(process.env.MAX_HISTORY) || 100;
const MAX_DIFF_CHARS = Number(process.env.MAX_DIFF_CHARS) || 8000;

// Cost tracking (per 1M tokens, as of Feb 2026)
const PRICING = {
  "claude-opus-4-6":          { input: 15.00, cache_read: 1.50, output: 75.00 },
  "claude-sonnet-4-5-20250929": { input: 3.00, cache_read: 0.30, output: 15.00 },
  "claude-haiku-4-5-20251001":  { input: 1.00, cache_read: 0.10, output: 5.00 },
};
let totalCost = 0;

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

async function gh(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...opts.headers,
    },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${path} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function ghPaginate(path, maxItems = 100) {
  const items = [];
  let page = 1;
  while (items.length < maxItems) {
    const perPage = Math.min(100, maxItems - items.length);
    const sep = path.includes("?") ? "&" : "?";
    const data = await gh(`${path}${sep}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    if (data.length < perPage) break;
    page++;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

async function getTargetPR(prNumber) {
  const pr = await gh(`/repos/${REPO}/pulls/${prNumber}`);
  let diff = "";
  try {
    const res = await fetch(`${GITHUB_API}/repos/${REPO}/pulls/${prNumber}`, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3.diff",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.ok) {
      diff = await res.text();
      if (diff.length > MAX_DIFF_CHARS) {
        diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... (truncated)";
      }
    }
  } catch {}

  const files = await gh(`/repos/${REPO}/pulls/${prNumber}/files?per_page=100`);
  return {
    number: pr.number,
    title: pr.title,
    body: (pr.body || "").slice(0, 2000),
    author: pr.user?.login,
    branch: pr.head?.ref,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    created_at: pr.created_at,
    files: files.map((f) => f.filename),
    diff,
  };
}

function summarizePR(pr) {
  const issueRefs = extractIssueRefs(pr.title + " " + (pr.body || ""));
  return [
    `#${pr.number}: ${pr.title}`,
    `  author:${pr.user?.login || pr.author} +${pr.additions}/-${pr.deletions} ${pr.changed_files ?? pr.files?.length ?? "?"} files`,
    pr.files?.length
      ? `  files: ${pr.files.slice(0, 8).join(", ")}${pr.files.length > 8 ? ` (+${pr.files.length - 8} more)` : ""}`
      : "",
    issueRefs.length ? `  refs: ${issueRefs.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function getOpenPRSummaries() {
  const prs = await ghPaginate(`/repos/${REPO}/pulls?state=open&sort=created&direction=desc`, MAX_OPEN_PRS);
  const summaries = [];
  for (const pr of prs) {
    let files = [];
    try {
      files = (await gh(`/repos/${REPO}/pulls/${pr.number}/files?per_page=30`)).map((f) => f.filename);
    } catch {}
    summaries.push(
      summarizePR({
        ...pr,
        author: pr.user?.login,
        files,
      }),
    );
  }
  return summaries;
}

async function getRecentDecisions() {
  // Last N merged PRs
  const merged = await ghPaginate(
    `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc`,
    MAX_HISTORY * 2,
  );

  const mergedPRs = merged
    .filter((pr) => pr.merged_at)
    .slice(0, MAX_HISTORY)
    .map((pr) => `MERGED #${pr.number}: ${pr.title} (by ${pr.user?.login}, +${pr.additions}/-${pr.deletions})`);

  const rejectedPRs = merged
    .filter((pr) => !pr.merged_at)
    .slice(0, MAX_HISTORY)
    .map((pr) => `CLOSED #${pr.number}: ${pr.title} (by ${pr.user?.login}, +${pr.additions}/-${pr.deletions})`);

  return { mergedPRs, rejectedPRs };
}

// ---------------------------------------------------------------------------
// Issue reference extraction
// ---------------------------------------------------------------------------

function extractIssueRefs(text) {
  if (!text) return [];
  const matches = text.match(/#(\d{3,6})/g) || [];
  return [...new Set(matches)];
}

function computeFileOverlap(filesA, filesB) {
  if (!filesA.length || !filesB.length) return 0;
  const setA = new Set(filesA);
  const intersection = filesB.filter((f) => setA.has(f));
  const union = new Set([...filesA, ...filesB]);
  return intersection.length / union.size; // Jaccard
}

// ---------------------------------------------------------------------------
// Deterministic pre-enrichment
// ---------------------------------------------------------------------------

function deterministicSignals(targetPR, openPRSummaries) {
  const targetRefs = extractIssueRefs(targetPR.title + " " + targetPR.body);
  const targetFiles = targetPR.files || [];

  const signals = [];

  // Parse open PR summaries back into structured data for comparison
  for (const summary of openPRSummaries) {
    const numMatch = summary.match(/^#(\d+):/);
    if (!numMatch) continue;
    const num = Number(numMatch[1]);
    if (num === targetPR.number) continue;

    const refsMatch = summary.match(/refs: (.+)/);
    const prRefs = refsMatch ? refsMatch[1].split(", ") : [];
    const filesMatch = summary.match(/files: (.+)/);
    const prFiles = filesMatch
      ? filesMatch[1]
          .replace(/ \(\+\d+ more\)/, "")
          .split(", ")
      : [];

    // Shared issue references
    const sharedRefs = targetRefs.filter((r) => prRefs.includes(r));

    // File overlap
    const jaccard = computeFileOverlap(targetFiles, prFiles);

    if (sharedRefs.length > 0 || jaccard > 0.3) {
      signals.push({
        pr: num,
        sharedRefs,
        jaccard: Math.round(jaccard * 100) / 100,
        summary: summary.split("\n")[0],
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// LLM triage call
// ---------------------------------------------------------------------------

async function triagePR(targetPR, openPRSummaries, decisions, deterministicHints) {
  const contributingMd = await loadContributing();

  const systemPrompt = `You are an AI PR triage assistant for the ${REPO} open-source project.
Your job: analyze the NEW PR below and detect duplicates, overlaps, and categorize it.

## All Open PRs (${openPRSummaries.length} total)
${openPRSummaries.join("\n\n")}

## Recent Maintainer Decisions (implicit preferences — learn from these)
### Merged (approved):
${decisions.mergedPRs.slice(0, 25).join("\n")}

### Closed without merge (rejected):
${decisions.rejectedPRs.slice(0, 25).join("\n")}

## Project Focus (from CONTRIBUTING.md)
${contributingMd}

## Rules
- Compare the NEW PR against ALL open PRs above
- Detect: exact duplicates, partial overlaps, related work, superset/subset relationships
- Categorize: bug, feature, refactor, test, docs, chore
- Assess quality signals: size appropriateness, test inclusion, focused scope
- Learn from the merged/closed decisions above — what does this maintainer value?
- Be conservative: only flag duplicates at HIGH confidence
- Output valid JSON only, no markdown fences`;

  const deterministicContext =
    deterministicHints.length > 0
      ? `\n\nDeterministic pre-analysis found these potential overlaps:\n${deterministicHints.map((h) => `- PR #${h.pr}: shared refs=${h.sharedRefs.join(",") || "none"}, file overlap=${h.jaccard}`).join("\n")}`
      : "";

  const userPrompt = `## NEW PR to triage

Title: ${targetPR.title}
Author: ${targetPR.author}
Branch: ${targetPR.branch}
Size: +${targetPR.additions}/-${targetPR.deletions}, ${targetPR.changed_files} files changed
Created: ${targetPR.created_at}
Files: ${targetPR.files.join(", ")}

Description:
${targetPR.body || "(no description)"}

Diff (excerpt):
${targetPR.diff || "(diff unavailable)"}
${deterministicContext}

Respond with a single JSON object:
{
  "duplicate_of": [list of PR numbers this is a duplicate of, or empty],
  "related_to": [list of PR numbers this is related to but not duplicate, or empty],
  "category": "bug" | "feature" | "refactor" | "test" | "docs" | "chore",
  "confidence": "high" | "medium" | "low",
  "quality_signals": {
    "focused_scope": true/false,
    "has_tests": true/false,
    "appropriate_size": true/false,
    "references_issue": true/false
  },
  "suggested_action": "needs-review" | "likely-duplicate" | "needs-discussion" | "auto-label-only",
  "reasoning": "one sentence explaining the triage decision"
}`;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();

  // Cost tracking
  const usage = data.usage || {};
  const prices = PRICING[MODEL] || PRICING["claude-haiku-4-5-20251001"];
  const inputCost = ((usage.input_tokens || 0) / 1_000_000) * prices.input;
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * prices.cache_read;
  const cacheCreateCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * prices.input;
  const outputCost = ((usage.output_tokens || 0) / 1_000_000) * prices.output;
  const callCost = inputCost + cacheReadCost + cacheCreateCost + outputCost;
  totalCost += callCost;

  console.log(`Tokens: ${usage.input_tokens || 0} input (${usage.cache_read_input_tokens || 0} cached, ${usage.cache_creation_input_tokens || 0} cache-write), ${usage.output_tokens || 0} output`);
  console.log(`Cost: $${callCost.toFixed(4)} this call | $${totalCost.toFixed(4)} total`);

  const text = data.content?.[0]?.text || "";

  // Parse JSON from response (handle potential markdown fences)
  const jsonStr = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    console.error("Failed to parse LLM response:", text.slice(0, 500));
    return null;
  }
}

async function loadContributing() {
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile("CONTRIBUTING.md", "utf-8");
    // Extract just the focus/roadmap section
    const focusMatch = content.match(/## Current Focus.*?\n([\s\S]*?)(?=\n## |$)/);
    return focusMatch ? focusMatch[1].trim() : content.slice(0, 1000);
  } catch {
    return "Priorities: Stability, UX, Skills (ClawHub), Performance";
  }
}

// ---------------------------------------------------------------------------
// Label application
// ---------------------------------------------------------------------------

const CATEGORY_LABELS = {
  bug: "auto:bug",
  feature: "auto:feature",
  refactor: "auto:refactor",
  test: "auto:test",
  docs: "auto:docs",
  chore: "auto:chore",
};

const TRIAGE_LABEL_COLOR = "c2e0c6";
const CATEGORY_LABEL_COLOR = "d4c5f9";
const OVERLAP_LABEL_COLOR = "fbca04";

async function ensureLabel(name, color) {
  try {
    await gh(`/repos/${REPO}/labels/${encodeURIComponent(name)}`);
  } catch {
    try {
      await gh(`/repos/${REPO}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
    } catch {}
  }
}

async function applyLabels(prNumber, triage) {
  if (!triage) return;

  const labels = [];

  // Category label
  const catLabel = CATEGORY_LABELS[triage.category];
  if (catLabel) {
    await ensureLabel(catLabel, CATEGORY_LABEL_COLOR);
    labels.push(catLabel);
  }

  // Duplicate/overlap labels — only at high confidence
  if (triage.confidence === "high" && triage.duplicate_of?.length > 0) {
    const label = "possible-overlap";
    await ensureLabel(label, OVERLAP_LABEL_COLOR);
    labels.push(label);

    // Add cluster labels for each referenced issue
    for (const dupNum of triage.duplicate_of) {
      const clusterLabel = `cluster:#${dupNum}`;
      await ensureLabel(clusterLabel, OVERLAP_LABEL_COLOR);
      labels.push(clusterLabel);
    }
  }

  // Triage action label
  if (triage.suggested_action === "likely-duplicate") {
    await ensureLabel("triage:likely-duplicate", OVERLAP_LABEL_COLOR);
    labels.push("triage:likely-duplicate");
  } else if (triage.suggested_action === "needs-discussion") {
    await ensureLabel("triage:needs-discussion", TRIAGE_LABEL_COLOR);
    labels.push("triage:needs-discussion");
  }

  // Quality signal labels
  if (triage.quality_signals) {
    if (!triage.quality_signals.references_issue) {
      await ensureLabel("triage:no-issue-ref", TRIAGE_LABEL_COLOR);
      labels.push("triage:no-issue-ref");
    }
    if (!triage.quality_signals.has_tests && triage.category !== "docs") {
      await ensureLabel("triage:no-tests", TRIAGE_LABEL_COLOR);
      labels.push("triage:no-tests");
    }
  }

  if (labels.length > 0) {
    try {
      await gh(`/repos/${REPO}/issues/${prNumber}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels }),
      });
      console.log(`Applied labels to #${prNumber}: ${labels.join(", ")}`);
    } catch (err) {
      console.warn(`Failed to apply labels (likely missing write access): ${err.message}`);
      console.log(`Would apply to #${prNumber}: ${labels.join(", ")}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary output (GitHub Actions step summary)
// ---------------------------------------------------------------------------

function writeSummary(prNumber, triage, deterministicHints, costInfo) {
  if (!triage) return;

  const lines = [
    `## PR #${prNumber} Triage`,
    "",
    `**Category:** ${triage.category} | **Confidence:** ${triage.confidence} | **Action:** ${triage.suggested_action}`,
    "",
    `**Reasoning:** ${triage.reasoning}`,
    "",
  ];

  if (triage.duplicate_of?.length > 0) {
    lines.push(`**Possible duplicates:** ${triage.duplicate_of.map((n) => `#${n}`).join(", ")}`);
  }
  if (triage.related_to?.length > 0) {
    lines.push(`**Related PRs:** ${triage.related_to.map((n) => `#${n}`).join(", ")}`);
  }

  if (deterministicHints.length > 0) {
    lines.push("", "**Deterministic signals:**");
    for (const h of deterministicHints) {
      lines.push(`- #${h.pr}: refs=${h.sharedRefs.join(",") || "none"}, file overlap=${h.jaccard}`);
    }
  }

  const qs = triage.quality_signals || {};
  lines.push(
    "",
    "**Quality:**",
    `- Focused scope: ${qs.focused_scope ? "yes" : "no"}`,
    `- Has tests: ${qs.has_tests ? "yes" : "no"}`,
    `- Appropriate size: ${qs.appropriate_size ? "yes" : "no"}`,
    `- References issue: ${qs.references_issue ? "yes" : "no"}`,
  );

  if (costInfo) {
    lines.push("", `**Model:** ${costInfo.model} | **Cost:** $${costInfo.totalCost.toFixed(4)}`);
  }

  const summary = lines.join("\n");
  console.log(summary);

  // Write to GitHub Actions step summary if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const prNumber = PR_NUMBER || 0;
  if (!prNumber) {
    console.error("No PR number provided (set PR_NUMBER env var)");
    process.exit(1);
  }

  console.log(`Triaging PR #${prNumber} on ${REPO}...`);

  // 1. Fetch target PR details
  console.log("Fetching target PR...");
  const targetPR = await getTargetPR(prNumber);
  console.log(`Target: "${targetPR.title}" by ${targetPR.author}, ${targetPR.files.length} files`);

  // 2. Fetch all open PR summaries (cached in LLM system prompt)
  console.log("Fetching open PRs for context...");
  const openPRSummaries = await getOpenPRSummaries();
  console.log(`Loaded ${openPRSummaries.length} open PRs as context`);

  // 3. Fetch recent merge/close decisions (implicit preferences)
  console.log("Fetching recent decisions...");
  const decisions = await getRecentDecisions();
  console.log(`Loaded ${decisions.mergedPRs.length} merged + ${decisions.rejectedPRs.length} rejected PRs`);

  // 4. Run deterministic pre-analysis
  const deterministicHints = deterministicSignals(targetPR, openPRSummaries);
  if (deterministicHints.length > 0) {
    console.log(`Deterministic: found ${deterministicHints.length} potential overlaps`);
  }

  // 5. Single LLM call with cached context
  let triage;
  if (DRY_RUN) {
    console.log("\n=== DRY RUN — LLM call skipped ===");
    console.log(`System prompt would be ~${openPRSummaries.join("\n").length + decisions.mergedPRs.join("\n").length + decisions.rejectedPRs.join("\n").length} chars (cached)`);
    console.log(`User prompt would be ~${targetPR.title.length + targetPR.body.length + targetPR.diff.length + targetPR.files.join(", ").length} chars (fresh)`);
    console.log(`Deterministic hints: ${JSON.stringify(deterministicHints, null, 2)}`);
    console.log("=== END DRY RUN ===\n");
    triage = {
      duplicate_of: deterministicHints.filter((h) => h.sharedRefs.length > 0 || h.jaccard > 0.5).map((h) => h.pr),
      related_to: deterministicHints.filter((h) => h.sharedRefs.length === 0 && h.jaccard <= 0.5).map((h) => h.pr),
      category: "unknown",
      confidence: "dry-run",
      quality_signals: { focused_scope: true, has_tests: false, appropriate_size: true, references_issue: extractIssueRefs(targetPR.title + " " + targetPR.body).length > 0 },
      suggested_action: "auto-label-only",
      reasoning: "DRY RUN — deterministic signals only",
    };
  } else {
    console.log(`Calling ${MODEL} for triage...`);
    triage = await triagePR(targetPR, openPRSummaries, decisions, deterministicHints);
  }

  if (!triage) {
    console.error("LLM triage failed — no valid response");
    process.exit(1);
  }

  console.log(`Result: ${triage.category} | ${triage.confidence} | ${triage.suggested_action}`);
  if (triage.duplicate_of?.length) {
    console.log(`Duplicates: ${triage.duplicate_of.map((n) => `#${n}`).join(", ")}`);
  }

  // 6. Apply labels (silent — no public comments)
  if (!DRY_RUN) {
    console.log("Applying labels...");
    await applyLabels(prNumber, triage);
  } else {
    console.log("DRY RUN — skipping label application");
  }

  // 7. Write summary (visible only in Actions run log)
  writeSummary(prNumber, triage, deterministicHints, { model: MODEL, totalCost });

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
