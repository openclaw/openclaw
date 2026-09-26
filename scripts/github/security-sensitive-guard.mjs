#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import {
  SupersededReviewError,
  finishGuard,
  openGuard,
  withApprovalRequest,
} from "./guard-review.mjs";
import { createIssueMutationHelpers, sanitizeGuardDisplayValue } from "./guard-shared.mjs";
import { loadSecurityReviewPolicy } from "./security-review-policy.mjs";

const marker = "<!-- openclaw:security-sensitive-guard -->";
const changedLabel = "security-sensitive-changed";
const reviewLabel = "security-review-required";

function code(value) {
  return `\`${sanitizeGuardDisplayValue(value).replaceAll("`", "\\`")}\``;
}

function renderComment({ changes, pullRequest, approval }) {
  if (changes.length > 0 && approval?.kind === "comment") {
    return [
      marker,
      "",
      "### ✅ Maintainer security changes approved",
      "",
      "A maintainer approved this revision with an explicit security approval comment.",
      "",
      `- Current SHA: ${code(approval.sha)}`,
      `- Maintainer: @${sanitizeGuardDisplayValue(approval.login)}`,
      `- Repository role: ${code(approval.role)}`,
      `- Approval comment: ${approval.url}`,
      "",
      "A later push requires a fresh approval comment for an external contributor's PR.",
    ].join("\n");
  }
  const heading =
    changes.length === 0
      ? "Security-sensitive guard cleared"
      : approval?.kind === "author"
        ? "⚠️ Security sensitive changes"
        : "⚠️ Maintainer security review required";
  const lines = [marker, "", `### ${heading}`, ""];
  if (changes.length > 0 && approval?.kind === "author") {
    lines.push(
      "This maintainer PR changes sensitive security components. This comment is informational because the PR author has repository Maintain or Admin access.",
      "",
      `- Current SHA: ${code(pullRequest.head.sha)}`,
      `- Maintainer: @${sanitizeGuardDisplayValue(approval.login)}`,
      `- Repository role: ${code(approval.role)}`,
    );
  } else if (changes.length > 0 && !approval) {
    lines.push(
      "This external contributor PR changes sensitive security components. A maintainer must review these changes before merging.",
      "",
      `Current SHA: ${code(pullRequest.head.sha)}`,
    );
  } else {
    lines.push(`Current revision: ${code(pullRequest.head.sha)}`);
  }
  if (changes.length === 0) {
    lines.push("", "This PR no longer changes files in the maintainer security-review tier.");
  } else {
    lines.push(
      "",
      approval?.kind === "author"
        ? "These security sensitive changes were made:"
        : "These sensitive security changes were made:",
      "",
    );
    for (const change of changes.slice(0, 25)) {
      lines.push(`- ${code(change.path)}: ${change.reason}`);
    }
    if (changes.length > 25) {
      lines.push(`- ${changes.length - 25} additional sensitive files; see the workflow summary.`);
    }
    lines.push("");
    if (approval?.kind === "author") {
      lines.push("Carefully review these changes before merging.");
    } else {
      lines.push(
        "After reviewing the changes, post a new PR comment containing only approval commands, each on its own line:",
        "",
        "```text",
        "/allow-security-sensitive-change",
        "```",
        "",
        "A later push requires a fresh approval comment.",
      );
    }
  }
  if (changes.length === 0) {
    lines.push(
      "",
      "Separate CODEOWNERS requirements still apply to security policy and enforcement files.",
    );
  }
  return lines.join("\n");
}

export async function reviewSecuritySensitiveChanges(prepared) {
  const guard = await openGuard(
    {
      context: "openclaw/security-sensitive-review",
      commentMarker: marker,
      approvalCommand: "/allow-security-sensitive-change",
    },
    prepared,
  );
  if (!guard) {
    return true;
  }
  const { api, owner, repo, issuePath, files, pullRequest } = guard;
  const { collectSecuritySensitiveChanges } = loadSecurityReviewPolicy();
  const changes = collectSecuritySensitiveChanges(files);
  const comments = await api.paginate(`${issuePath}/comments`);
  const labels = await api.paginate(`${issuePath}/labels`);
  const existing = comments.find(
    (comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(marker),
  );
  const { addLabelIfMissing, removeLabelIfPresent, upsertComment } = createIssueMutationHelpers({
    api,
    owner,
    repo,
    issuePath,
    labelNames: new Set(labels.map((label) => label.name)),
  });
  const allowed = await finishGuard(guard, {
    requiresApproval: changes.length > 0,
    description:
      changes.length > 0
        ? "Sensitive changes have maintainer authority"
        : "No sensitive product changes",
  });
  if (changes.length > 0) {
    await addLabelIfMissing(changedLabel);
  } else {
    await removeLabelIfPresent(changedLabel);
  }
  if (allowed) {
    await removeLabelIfPresent(reviewLabel);
  } else {
    await addLabelIfMissing(reviewLabel);
  }
  const body = withApprovalRequest(
    guard,
    renderComment({ changes, pullRequest, approval: guard.approval }),
  );
  if (changes.length > 0 || existing) {
    await upsertComment(existing, body);
  }
  const summary = [
    body,
    "",
    ...changes.slice(25).map((change) => `- ${code(change.path)}: ${change.reason}`),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } else {
    console.log(summary);
  }
  return allowed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reviewSecuritySensitiveChanges().catch(
    /** @param {unknown} error */ (error) => {
      if (error instanceof SupersededReviewError) {
        console.log(error.message);
        return;
      }
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
