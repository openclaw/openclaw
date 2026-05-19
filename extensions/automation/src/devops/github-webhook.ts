import crypto from "node:crypto";

export type GitHubEvent = {
  type: string;
  action?: string;
  payload: any;
};

export function verifyGitHubSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function formatGitHubEvent(event: GitHubEvent): {
  text: string;
  topic: string;
  buttons?: Array<{ label: string; value: string }>;
} {
  switch (event.type) {
    case "push": {
      const { ref, commits, pusher } = event.payload;
      const branch = ref.replace("refs/heads/", "");
      return {
        text: `🔄 <b>Push</b> to <code>${branch}</code> by ${pusher.name}\n${commits.length} commit(s)`,
        topic: "deploy",
      };
    }

    case "pull_request": {
      const pr = event.payload.pull_request;
      const action = event.action;
      const emoji =
        action === "opened"
          ? "🆕"
          : action === "closed"
            ? pr.merged
              ? "🟣"
              : "🔴"
            : "🔵";
      return {
        text: `${emoji} <b>PR #${pr.number}</b> ${action}: ${pr.title}`,
        topic: "review",
        buttons:
          action === "opened"
            ? [
                { label: "🔍 Auto Review", value: `devops:review:${pr.number}` },
                { label: "📋 View", value: `devops:view-pr:${pr.number}` },
              ]
            : undefined,
      };
    }

    case "check_run":
    case "check_suite": {
      const check = event.payload.check_run ?? event.payload.check_suite;
      const conclusion = check.conclusion;
      const emoji =
        conclusion === "success"
          ? "✅"
          : conclusion === "failure"
            ? "❌"
            : "⏳";
      return {
        text: `${emoji} <b>CI</b> ${check.name ?? "check"}: ${conclusion ?? "in_progress"}`,
        topic: "deploy",
        buttons:
          conclusion === "failure"
            ? [
                { label: "🔁 Retry", value: `devops:retry:${check.id}` },
                { label: "🔍 Analyze", value: `devops:analyze-ci:${check.id}` },
              ]
            : undefined,
      };
    }

    case "issues": {
      const issue = event.payload.issue;
      return {
        text: `📋 <b>Issue #${issue.number}</b> ${event.action}: ${issue.title}`,
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
