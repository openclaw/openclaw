import fs from "node:fs";
import { pathToFileURL } from "node:url";

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
