import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseReleaseContextRef } from "./release-context.mjs";

/** Release targets must not need size-only refactors or baseline edits for backports. */
export function releaseBranchForChecks(root = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  let ref = env.OPENCLAW_RELEASE_CONTEXT_REF;
  if (!ref && env.GITHUB_ACTIONS === "true") {
    if (env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_EVENT_PATH) {
      const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as {
        inputs?: {
          target_context_ref?: string;
          release_candidate_ref?: string;
          target_ref?: string;
        };
      };
      ref =
        event.inputs?.target_context_ref ||
        event.inputs?.release_candidate_ref ||
        event.inputs?.target_ref;
    }
    // PR policy follows its destination, never a release-named contributor branch.
    ref ||= env.GITHUB_BASE_REF || env.GITHUB_REF;
  } else if (!ref) {
    try {
      ref = execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  }
  const context = typeof ref === "string" ? parseReleaseContextRef(ref) : null;
  return context && context.kind !== "release tag" ? context.ref : undefined;
}

export type LimitViolation = {
  file: string;
  title: string;
  message: string;
  line?: number;
};

export function limitsAreAdvisory(env: NodeJS.ProcessEnv = process.env) {
  // Local check runners also set CI=1. Only GitHub Actions changes limit severity.
  return env.GITHUB_ACTIONS === "true";
}

function escapeCommand(value: string, property = false) {
  const escaped = value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return property ? escaped.replaceAll(":", "%3A").replaceAll(",", "%2C") : escaped;
}

function summaryText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

/** Reports measured limit violations and returns whether they block this check. */
export function reportLimitViolations(
  violations: readonly LimitViolation[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const advisory = limitsAreAdvisory(env);
  for (const { file, title, message, line = 1 } of violations) {
    if (advisory) {
      console.error(
        `::warning file=${escapeCommand(file, true)},line=${line},col=0,title=${escapeCommand(title, true)}::${escapeCommand(message)}`,
      );
    } else {
      console.error(`${title}\n  ${file}: ${message}`);
    }
  }
  if (advisory && violations.length > 0 && env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      violations
        .map(
          ({ file, title, message }) =>
            `<p><strong>Warning: ${summaryText(title)}</strong> <code>${summaryText(file)}</code>: ${summaryText(message)}</p>\n`,
        )
        .join(""),
    );
  }
  return !advisory && violations.length > 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [file, title, message, ...extra] = process.argv.slice(2);
  if (!file || !title || !message || extra.length > 0) {
    console.error("Usage: node scripts/lib/check-limits.mts <file> <title> <message>");
    process.exitCode = 1;
  } else {
    process.exitCode = reportLimitViolations([{ file, title, message }]) ? 1 : 0;
  }
}
