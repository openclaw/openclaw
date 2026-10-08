import { html, nothing } from "lit";
import type { ControlUiLinkReaderPreview } from "openclaw/plugin-sdk/control-ui-link-reader";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../control-ui-contract.js";
import type { GitHubPresentationHost } from "./presentation-host.js";

/** Activity presentation consumes the host's canonical session PR snapshot. */
export function createGitHubActivityRenderer(
  host: Pick<GitHubPresentationHost, "t"> & {
    icons: Record<
      | "gitPullRequest"
      | "gitPullRequestDraft"
      | "gitMerge"
      | "gitPullRequestClosed"
      | "gitBranch"
      | "alertTriangle",
      unknown
    >;
  },
) {
  const { t, icons } = host;
  function renderDiff(item: { additions?: number; deletions?: number }) {
    return html`${
      item.additions === undefined
        ? nothing
        : html`<span class="activity-feed__additions">+${item.additions.toLocaleString()}</span>`
    }${
      item.deletions === undefined
        ? nothing
        : html`<span class="activity-feed__deletions">−${item.deletions.toLocaleString()}</span>`
    }`;
  }

  function pullRequestPreview(pr: ControlUiSessionPullRequest): ControlUiLinkReaderPreview {
    return {
      url: pr.url,
      title: pr.title,
      subtitle: pr.owner + "/" + pr.repo + " #" + pr.number,
      badge: {
        label: t("activity.git." + pr.state),
        tone:
          pr.state === "merged"
            ? "accent"
            : pr.state === "open"
              ? "positive"
              : pr.state === "closed"
                ? "negative"
                : "neutral",
      },
      author: pr.author?.login,
      authorUrl: pr.author?.login
        ? "https://github.com/" + encodeURIComponent(pr.author.login)
        : undefined,
      metadata: [
        ...(pr.additions === undefined
          ? []
          : [{ label: "", value: "+" + pr.additions, tone: "positive" as const }]),
        ...(pr.deletions === undefined
          ? []
          : [{ label: "", value: "−" + pr.deletions, tone: "negative" as const }]),
      ],
    };
  }

  function renderPullRequest(pr: ControlUiSessionPullRequest) {
    const icon = {
      open: icons.gitPullRequest,
      draft: icons.gitPullRequestDraft,
      merged: icons.gitMerge,
      closed: icons.gitPullRequestClosed,
    }[pr.state];
    return html`<a
      class="activity-feed__pr"
      data-state=${pr.state}
      href=${pr.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label=${t("activity.git.pullRequest", {
        repository: `${pr.owner}/${pr.repo}`,
        number: String(pr.number),
        title: pr.title,
        state: t(`activity.git.${pr.state}`),
      })}
    >
      <span class="activity-feed__git-icon" aria-hidden="true">${icon}</span>
      <span class="activity-feed__git-label">${pr.repo}#${pr.number}</span>
      ${renderDiff(pr)}
    </a>`;
  }

  return (snapshot: ControlUiSessionPullRequestSnapshot, connected: boolean) => {
    const branch = snapshot.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft")
      ? undefined
      : snapshot.branch;
    if (!branch && snapshot.pullRequests.length === 0) {
      return null;
    }
    const stale = snapshot.status !== "ready" || !connected;
    return {
      previews: snapshot.pullRequests.map(pullRequestPreview),
      content: html`
        <div class="activity-feed__git">
          ${
            branch
              ? html`<span
                  class="activity-feed__branch"
                  title=${t("activity.git.branchDiff", { branch: branch.branch })}
                >
                  <span class="activity-feed__git-icon" aria-hidden="true">${icons.gitBranch}</span>
                  <span class="activity-feed__git-label">${branch.branch}</span>
                  ${renderDiff(branch)}
                </span>`
              : nothing
          }
          ${snapshot.pullRequests.map(renderPullRequest)}
          ${
            stale
              ? html`<span
                  class="activity-feed__git-stale"
                  role="img"
                  aria-label=${t("activity.git.stale")}
                  title=${t("activity.git.stale")}
                  >${icons.alertTriangle}</span
                >`
              : nothing
          }
        </div>
      `,
    };
  };
}
