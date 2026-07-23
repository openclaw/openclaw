// PR preflight policy shared by the local CLI and tests.
import { hasAuthoredPullRequestSection } from "./real-behavior-proof-policy.mjs";

const ALLOWED_TITLE_TYPES = new Set(["feat", "fix", "improve", "refactor", "docs", "chore"]);
const PLACEHOLDER_PATTERNS = [
  /<!--[\s\S]*?-->/,
  /\bDescribe the concrete\b/i,
  /\bIn one or two sentences\b/i,
  /\bState what users\b/i,
  /\bShow the most useful proof\b/i,
  /\bIf there is no user-visible impact, say so plainly\b/i,
];

function normalizeLineEndings(text = "") {
  return text.replace(/\r\n?/g, "\n");
}

function parseTitle(title) {
  const trimmed = String(title ?? "").trim();
  const match = trimmed.match(/^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?:\s+(?<description>\S.*)$/u);
  if (!match?.groups) {
    return { ok: false, reason: "Title must use `type: user-facing description`." };
  }

  const type = match.groups.type;
  if (!ALLOWED_TITLE_TYPES.has(type)) {
    return {
      ok: false,
      reason: `Title type must be one of ${Array.from(ALLOWED_TITLE_TYPES).join(", ")}.`,
    };
  }

  const description = match.groups.description.trim();
  if (description.length < 8) {
    return { ok: false, reason: "Title description is too short to describe the user-facing change." };
  }

  return {
    ok: true,
    type,
    scope: match.groups.scope?.trim() || undefined,
    description,
  };
}

function hasVisibleIssueReference(body) {
  return normalizeLineEndings(body)
    .split("\n")
    .some((line) => /^(?:Closes\s*#\d+|Related:\s*#\d+)$/i.test(line.trim()));
}

function collectMissingSections(body) {
  return ["What Problem This Solves", "Why This Change Was Made", "User Impact", "Evidence"].filter(
    (heading) => !hasAuthoredPullRequestSection(heading, body),
  );
}

function collectPlaceholderFindings(body) {
  return PLACEHOLDER_PATTERNS.filter((pattern) => pattern.test(body)).map((pattern) =>
    String(pattern),
  );
}

export function validatePullRequestDraft({ title, body }) {
  const normalizedBody = normalizeLineEndings(body);
  const errors = [];
  const warnings = [];

  const titleResult = parseTitle(title);
  if (!titleResult.ok) {
    errors.push(titleResult.reason);
  }

  const missingSections = collectMissingSections(normalizedBody);
  if (missingSections.length > 0) {
    errors.push(`Missing required PR sections: ${missingSections.join(", ")}.`);
  }

  if (collectPlaceholderFindings(normalizedBody).length > 0) {
    errors.push("PR body still contains template placeholder text or HTML comments.");
  }

  if (!hasVisibleIssueReference(normalizedBody)) {
    warnings.push("Add a `Closes #<issue>` or `Related: #<issue>` line when the work maps to an issue.");
  }

  if (!/\bAI-assisted\b/i.test(`${title}\n${normalizedBody}`)) {
    warnings.push(
      "Mark the PR as AI-assisted in the title or body so reviewers know what to expect.",
    );
  }

  return {
    errors,
    warnings,
    title: titleResult.ok ? titleResult : undefined,
  };
}
