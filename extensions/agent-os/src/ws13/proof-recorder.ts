// Agent OS WS13 — L1 proof: sanitized markdown evidence renderer.
//
// Turns a Ws13ProofResult into a metadata-only markdown report. It contains
// only opaque IDs, hook names, scenario labels, timestamps, status/health
// transitions, correlation strength, and coarse error categories. The render
// throws if any content-bearing needle is detected (defense in depth). This
// module does NOT write files and does NOT execute scenarios.

import { hasNoContentBearingEvidence } from "./privacy.js";
import type {
  Ws13ProofResult,
  Ws13ScenarioResult,
  Ws13TransitionEvidence,
} from "./types.js";

function renderTransition(t: Ws13TransitionEvidence): string {
  const parts = [
    t.evidenceId,
    t.hookName ?? "-",
    t.from ?? "-",
    "→",
    t.to ?? "-",
    t.status ?? "-",
    t.correlationStrength ?? "-",
    t.health ?? "-",
    t.errorCategoryOnly ?? "-",
  ];
  return `| ${parts.join(" | ")} |`;
}

function renderScenario(r: Ws13ScenarioResult): string {
  const lines: string[] = [];
  lines.push(`### Scenario ${r.scenario} — ${r.status.toUpperCase()}`);
  lines.push("");
  lines.push(`- obligationId: \`${r.obligationId ?? "n/a"}\``);
  lines.push(`- finalStatus: \`${r.finalObligationStatus ?? "n/a"}\``);
  lines.push(`- correlationStrength: \`${r.correlationStrength}\``);
  lines.push(`- health: \`${r.health}\``);
  if (r.slackDeliveryClass) {
    lines.push(`- slackDeliveryClass: \`${r.slackDeliveryClass}\``);
  }
  if (r.alertCapability) {
    lines.push(`- alertCapability: \`${r.alertCapability}\``);
  }
  if (r.errorCategoryOnly) {
    lines.push(`- errorCategoryOnly: \`${r.errorCategoryOnly}\``);
  }
  lines.push("");
  for (const n of r.notes) {
    lines.push(`- note: ${n}`);
  }
  if (r.statusTransitions.length > 0) {
    lines.push("");
    lines.push(
      "| evidenceId | hook | from | → | to | scen | corr | health | err |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const t of r.statusTransitions) {
      lines.push(renderTransition(t));
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderEvidenceMarkdown(proof: Ws13ProofResult): string {
  if (!hasNoContentBearingEvidence(proof)) {
    throw new Error("ws13_privacy_violation_content_in_evidence");
  }

  const header = [
    "# Agent OS Phase 4 WS13 — Pure Plugin Prototype Evidence (L1)",
    "",
    `- generatedAt: \`${proof.generatedAt}\``,
    `- executionMode: \`${proof.executionMode}\``,
    `- privacyMode: \`${proof.privacyMode}\``,
    `- closureWindowMs: \`${proof.closureWindow.verificationWindowMs}\``,
    `- requiredHooks: \`${proof.requiredHooks.join(", ")}\``,
    `- overallStatus: \`${proof.overallStatus}\``,
    "",
    "All values below are metadata only. No task text, prompts, transcripts,",
    "assistant output, reply bodies, message content, images, attachments,",
    "human-readable labels, or raw error text are present.",
    "",
    "## Scenario Results",
    "",
  ].join("\n");

  const body = proof.results.map(renderScenario).join("\n");
  return `${header}\n${body}`;
}
