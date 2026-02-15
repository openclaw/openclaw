/**
 * Label application and summary output for PR triage.
 * Handles GitHub label creation, PR labeling, and Action summary generation.
 */

import { appendFileSync } from "node:fs";

const CATEGORY_LABELS = {
  bug: "auto:bug",
  feature: "auto:feature",
  refactor: "auto:refactor",
  test: "auto:test",
  docs: "auto:docs",
  chore: "auto:chore",
};

async function ensureLabel(gh, repo, name, color) {
  try {
    await gh(`/repos/${repo}/labels/${encodeURIComponent(name)}`);
  } catch {
    try {
      await gh(`/repos/${repo}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
    } catch {}
  }
}

export async function applyLabels(gh, repo, prNumber, triage) {
  if (!triage) {
    return;
  }
  const labels = [];
  const catLabel = CATEGORY_LABELS[triage.category];
  if (catLabel) {
    await ensureLabel(gh, repo, catLabel, "d4c5f9");
    labels.push(catLabel);
  }

  if (triage.confidence === "high" && triage.duplicate_of?.length > 0) {
    await ensureLabel(gh, repo, "possible-overlap", "fbca04");
    labels.push("possible-overlap");
    for (const dupNum of triage.duplicate_of) {
      const clusterLabel = `cluster:#${dupNum}`;
      await ensureLabel(gh, repo, clusterLabel, "fbca04");
      labels.push(clusterLabel);
    }
  }

  if (triage.suggested_action === "likely-duplicate") {
    await ensureLabel(gh, repo, "triage:likely-duplicate", "fbca04");
    labels.push("triage:likely-duplicate");
  } else if (triage.suggested_action === "needs-discussion") {
    await ensureLabel(gh, repo, "triage:needs-discussion", "c2e0c6");
    labels.push("triage:needs-discussion");
  }

  if (triage.quality_signals) {
    if (!triage.quality_signals.references_issue) {
      await ensureLabel(gh, repo, "triage:no-issue-ref", "c2e0c6");
      labels.push("triage:no-issue-ref");
    }
    if (!triage.quality_signals.has_tests && triage.category !== "docs") {
      await ensureLabel(gh, repo, "triage:no-tests", "c2e0c6");
      labels.push("triage:no-tests");
    }
  }

  if (labels.length > 0) {
    try {
      await gh(`/repos/${repo}/issues/${prNumber}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels }),
      });
      console.log(`Applied labels to #${prNumber}: ${labels.join(", ")}`);
    } catch (err) {
      console.warn(`Failed to apply labels: ${err.message}`);
      console.log(`Would apply to #${prNumber}: ${labels.join(", ")}`);
    }
  }
}

export function writeSummary(prNumber, triage, deterministicHints, costInfo) {
  if (!triage) {
    return;
  }
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
      lines.push(`- #${h.pr}: file overlap=${h.jaccard}`);
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
    lines.push(
      "",
      `**Model:** ${costInfo.model} | **Effort:** ${costInfo.effort} | **Cost:** $${costInfo.totalCost.toFixed(4)}`,
    );
  }
  const summary = lines.join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
    } catch {}
  }
}
