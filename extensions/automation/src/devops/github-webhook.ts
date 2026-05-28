import crypto from "node:crypto";

export type GitHubEvent = {
  type: string;
  action?: string;
  payload: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function verifyGitHubSignature(body: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function formatGitHubEvent(event: GitHubEvent): {
  text: string;
  topic: string;
  buttons?: Array<{ label: string; value: string }>;
} {
  const payload = isRecord(event.payload) ? event.payload : {};

  switch (event.type) {
    case "push": {
      const ref = asText(payload.ref);
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      const pusher = isRecord(payload.pusher) ? payload.pusher : {};
      const branch = ref.replace("refs/heads/", "");
      return {
        text: `🔄 <b>Push</b> to <code>${branch}</code> by ${asText(pusher.name, "unknown")}\n${commits.length} commit(s)`,
        topic: "deploy",
      };
    }

    case "pull_request": {
      const pr = isRecord(payload.pull_request) ? payload.pull_request : {};
      const action = event.action;
      const emoji =
        action === "opened"
          ? "🆕"
          : action === "closed"
            ? asBoolean(pr.merged)
              ? "🟣"
              : "🔴"
            : "🔵";
      const prNumber = asText(pr.number, "unknown");
      return {
        text: `${emoji} <b>PR #${prNumber}</b> ${action}: ${asText(pr.title, "untitled")}`,
        topic: "review",
        buttons:
          action === "opened"
            ? [
                { label: "🔍 Auto Review", value: `devops:review:${prNumber}` },
                { label: "📋 View", value: `devops:view-pr:${prNumber}` },
              ]
            : undefined,
      };
    }

    case "check_run":
    case "check_suite": {
      const checkRun = isRecord(payload.check_run) ? payload.check_run : undefined;
      const checkSuite = isRecord(payload.check_suite) ? payload.check_suite : undefined;
      const check = checkRun ?? checkSuite ?? {};
      const conclusion = asText(check.conclusion, "in_progress");
      const emoji = conclusion === "success" ? "✅" : conclusion === "failure" ? "❌" : "⏳";
      const checkId = asText(check.id, "unknown");
      return {
        text: `${emoji} <b>CI</b> ${asText(check.name, "check")}: ${conclusion}`,
        topic: "deploy",
        buttons:
          conclusion === "failure"
            ? [
                { label: "🔁 Retry", value: `devops:retry:${checkId}` },
                { label: "🔍 Analyze", value: `devops:analyze-ci:${checkId}` },
              ]
            : undefined,
      };
    }

    case "issues": {
      const issue = isRecord(payload.issue) ? payload.issue : {};
      return {
        text: `📋 <b>Issue #${asText(issue.number, "unknown")}</b> ${event.action}: ${asText(issue.title, "untitled")}`,
        topic: "general",
      };
    }

    default:
      return {
        text: `📡 GitHub: ${event.type} ${event.action ?? ""}`,
        topic: "general",
      };
  }
}
