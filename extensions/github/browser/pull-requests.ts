import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
  GitHubPublicationView,
} from "../control-ui-contract.js";
import {
  GITHUB_MERGE_LABEL_KEYS,
  renderGitHubMergeStatus,
  resolveGitHubMergeStatus,
  type GitHubMergeStatus,
} from "./merge-status.js";
import type { GitHubPresentationHost } from "./presentation-host.js";
import { createGitHubPublicationRenderer } from "./publication.js";
import { chatPullRequestId } from "./pull-request-dismissals.js";

export type GitHubPullRequestsProps<Context> = {
  pullRequests: ControlUiSessionPullRequest[];
  context: Context;
  branch?: ControlUiSessionBranch;
  /** Hides the branch row and idle offer while preserving publication outcomes. */
  branchDismissed?: boolean;
  onDismissBranch?: (branch: ControlUiSessionBranch) => void;
  status: ControlUiSessionPullRequestSnapshot["status"];
  onDismiss: (pullRequest: ControlUiSessionPullRequest) => void;
  onOpenSessionDiff?: () => void;
  publication?: GitHubPublicationView;
};

export function createGitHubPullRequestRenderer<Context>(
  host: GitHubPresentationHost & {
    syncChecksOverlay: (element: HTMLDetailsElement, context: Context) => void;
    checksPopupActive: (details: () => HTMLDetailsElement | undefined, context: Context) => unknown;
    renderCi: (pullRequest: ControlUiSessionPullRequest, context: Context) => unknown;
  },
) {
  const { t, icons } = host;
  const { renderGitHubPublicationAction, renderGitHubPublicationDetails } =
    createGitHubPublicationRenderer(host);
  const STATE_LABEL_KEYS = {
    merged: "chat.pullRequests.merged",
    draft: "chat.pullRequests.draft",
    closed: "chat.pullRequests.closed",
    open: "chat.pullRequests.open",
  } as const;

  const CHECK_LABEL_KEYS = {
    passing: "chat.pullRequests.checksPassing",
    failing: "chat.pullRequests.checksFailing",
    pending: "chat.pullRequests.checksPending",
  } as const;

  function renderChecksRow(label: string, count: number, modifier: string) {
    if (count === 0) {
      return nothing;
    }
    return html`
      <div class="chat-pr__checks-row chat-pr__checks-row--${modifier}">
        <span class="chat-pr__checks-row-dot" aria-hidden="true"></span>
        <span class="chat-pr__checks-row-label">${label}</span>
        <span class="chat-pr__checks-row-count">${count}</span>
      </div>
    `;
  }

  function renderChecks(
    pullRequest: ControlUiSessionPullRequest,
    context: Context,
    merge?: GitHubMergeStatus,
  ) {
    const checks = pullRequest.checks;
    const checksLabel = checks
      ? t(CHECK_LABEL_KEYS[checks.state])
      : t("chat.pullRequests.ciMonitoring");
    const label = merge
      ? `${checksLabel}. ${t(GITHUB_MERGE_LABEL_KEYS[merge.phase])} ${merge.message}`
      : checksLabel;
    let details: HTMLDetailsElement | undefined;
    const syncChecksOverlay = (element: EventTarget | null | undefined) => {
      if (element instanceof HTMLDetailsElement) {
        details = element;
        host.syncChecksOverlay(element, context);
      }
    };
    return html`
      <details
        class="chat-pr__checks"
        data-checks=${checks?.state ?? "none"}
        data-merge=${merge?.phase ?? nothing}
        ${ref(syncChecksOverlay)}
        @toggle=${(event: Event) => syncChecksOverlay(event.currentTarget)}
      >
        <summary class="chat-pr__checks-pill" aria-label=${label} title=${label}>
          <span class="chat-pr__checks-dot" aria-hidden="true"></span>
          ${t("chat.pullRequests.checks")}
          <span class="chat-pr__checks-chevron" aria-hidden="true">${icons.chevronDown}</span>
        </summary>
        <wa-popup data-anchored-overlay .active=${host.checksPopupActive(() => details, context)}>
          <div
            class="chat-pr__checks-menu"
            role="group"
            aria-label=${t("chat.pullRequests.ciMonitoring")}
          >
            <div class="chat-pr__checks-menu-header">
              <span>${t("chat.pullRequests.ciMonitoring")}</span>
              <a
                href=${pullRequest.checksUrl ?? pullRequest.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label=${t("chat.pullRequests.openChecks")}
              >
                ${icons.externalLink}
              </a>
            </div>
            <div class="chat-pr__checks-counts">
              ${renderChecksRow(t("chat.pullRequests.checksFailed"), checks?.failed ?? 0, "failed")}
              ${renderChecksRow(t("chat.pullRequests.checksPassed"), checks?.passed ?? 0, "passed")}
              ${renderChecksRow(
                t("chat.pullRequests.checksRunning"),
                checks?.running ?? 0,
                "running",
              )}
              ${renderChecksRow(
                t("chat.pullRequests.checksSkipped"),
                checks?.skipped ?? 0,
                "skipped",
              )}
              ${!checks ? t("chat.pullRequests.automationNoChecks") : nothing}
            </div>
            ${renderGitHubMergeStatus(merge, t)} ${host.renderCi(pullRequest, context)}
          </div>
        </wa-popup>
      </details>
    `;
  }

  function renderDiffStats(
    item: { additions?: number; deletions?: number },
    onOpenSessionDiff?: () => void,
  ) {
    if (typeof item.additions !== "number" && typeof item.deletions !== "number") {
      return nothing;
    }
    const additions = html`<span class="chat-pr__additions"
      >+${(item.additions ?? 0).toLocaleString()}</span
    >`;
    const deletions = html`<span class="chat-pr__deletions"
      >−${(item.deletions ?? 0).toLocaleString()}</span
    >`;
    if (onOpenSessionDiff) {
      return html`
        <button
          class="chat-pr__diff"
          type="button"
          aria-label=${t("chat.sessionDiff.show")}
          @click=${onOpenSessionDiff}
        >
          ${additions} ${deletions}
        </button>
      `;
    }
    return html` <span class="chat-pr__diff">${additions} ${deletions}</span> `;
  }

  function renderStatusWarning(status: ControlUiSessionPullRequestSnapshot["status"]) {
    if (status === "ready") {
      return nothing;
    }
    const message = t(
      status === "rate-limited" ? "chat.pullRequests.rateLimited" : "chat.pullRequests.unavailable",
    );
    return html`
      <openclaw-tooltip content=${message}>
        <span class="chat-pr__warning" role="img" aria-label=${message}>
          ${icons.alertTriangle}
        </span>
      </openclaw-tooltip>
    `;
  }

  function renderCreatePullRequestLink(branch: ControlUiSessionBranch) {
    return branch.createUrl
      ? html`
          <a
            class="chat-pr__create"
            href=${branch.createUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${t("chat.pullRequests.createPrLabel", { branch: branch.branch })}
          >
            ${t("chat.pullRequests.createPr")}
          </a>
        `
      : nothing;
  }

  // Pre-PR state: the branch row mirrors PR chips and offers Gateway-owned
  // publication when available. When status is stale, "no PR found" is unreliable,
  // so the warning stays visible here.
  function renderWorkRow(
    branch: ControlUiSessionBranch | undefined,
    status: ControlUiSessionPullRequestSnapshot["status"],
    onOpenSessionDiff?: () => void,
    publication?: GitHubPublicationView,
    onDismissBranch?: (branch: ControlUiSessionBranch) => void,
  ) {
    const published =
      !branch && publication?.result?.status === "published" ? publication.result : undefined;
    return html`
      <article
        class="chat-pr"
        data-state=${published ? "published" : branch ? "branch" : "publication"}
      >
        <span class="chat-pr__link chat-pr__link--static">
          <span class="chat-pr__icon" aria-hidden="true"
            >${published || !branch ? icons.gitPullRequest : icons.gitBranch}</span
          >
          <span class="chat-pr__identity">
            <span class="chat-pr__repo"
              >${published?.repository ?? branch?.repo ?? t("chat.pullRequests.publishPr")}</span
            >
            <span class="chat-pr__branch">${published?.branch ?? branch?.branch}</span>
          </span>
        </span>
        <span class="chat-pr__meta">
          ${branch && !published ? renderDiffStats(branch, onOpenSessionDiff) : nothing}
          ${renderStatusWarning(status)}
          ${
            publication
              ? renderGitHubPublicationAction(publication)
              : branch
                ? renderCreatePullRequestLink(branch)
                : nothing
          }
          ${
            branch && !published && onDismissBranch
              ? html`<button
                  class="chat-pr__dismiss"
                  type="button"
                  ?disabled=${publication?.activity != null}
                  aria-label=${t("chat.pullRequests.dismissBranch", { branch: branch.branch })}
                  @click=${() => onDismissBranch(branch)}
                >
                  ${icons.x}
                </button>`
              : nothing
          }
        </span>
        ${publication ? renderGitHubPublicationDetails(publication) : nothing}
      </article>
    `;
  }

  function renderChatPullRequests(props: GitHubPullRequestsProps<Context>) {
    const { publication } = props;
    const published = publication?.result?.status === "published" ? publication.result : undefined;
    const retainedPublication = publication?.result || publication?.locked || publication?.error;
    // Session-only publishers cannot read the broader PR subscription's branch facts.
    const sharedAction =
      !props.branchDismissed &&
      publication?.canPublishShared &&
      !publication.canPublishPersonal &&
      publication.options?.shared;
    const branch = props.branchDismissed ? undefined : props.branch;
    // Gateway branch facts describe unpublished work, including changes after a merge.
    // PR metadata takes precedence over retained publication history.
    if (branch || (props.pullRequests.length === 0 && (retainedPublication || sharedAction))) {
      return html`<div class="chat-prs" aria-live="polite">
        ${renderWorkRow(branch, props.status, props.onOpenSessionDiff, publication, props.onDismissBranch)}
      </div>`;
    }
    if (props.pullRequests.length === 0) {
      return nothing;
    }
    const recovery =
      retainedPublication && (!published || publication?.error) ? publication : undefined;
    const visible = [
      ...props.pullRequests.filter((item) => item.state === "open" || item.state === "draft"),
      ...props.pullRequests.filter((item) => item.state !== "open" && item.state !== "draft"),
    ];
    return html`
      <div class="chat-prs" aria-live="polite">
        ${repeat(visible, chatPullRequestId, (pullRequest) => {
          const merged = pullRequest.state === "merged";
          return html`
            <article class="chat-pr" data-state=${pullRequest.state}>
              <a
                class="chat-pr__link"
                href=${pullRequest.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label=${t("chat.pullRequests.linkLabel", {
                  number: String(pullRequest.number),
                  title: pullRequest.title,
                })}
              >
                <span class="chat-pr__icon" aria-hidden="true">
                  ${merged ? icons.gitMerge : icons.gitPullRequest}
                </span>
                <span class="chat-pr__number">#${pullRequest.number}</span>
                <span class="chat-pr__identity">
                  <span class="chat-pr__repo">${pullRequest.repo}</span>
                  <span class="chat-pr__branch">${pullRequest.branch}</span>
                </span>
              </a>
              <span class="chat-pr__meta">
                ${renderDiffStats(pullRequest)}
                ${renderChecks(pullRequest, props.context, resolveGitHubMergeStatus(pullRequest, props.status, t))}
                ${
                  pullRequest.state === "open"
                    ? nothing
                    : html`<span class="chat-pr__state"
                        >${t(STATE_LABEL_KEYS[pullRequest.state])}</span
                      >`
                }
                ${
                  !merged || props.status === "unavailable"
                    ? renderStatusWarning(props.status)
                    : nothing
                }
                <button
                  class="chat-pr__dismiss"
                  type="button"
                  ?disabled=${Boolean(published) && publication?.activity !== null}
                  aria-label=${t("chat.pullRequests.dismiss", {
                    number: String(pullRequest.number),
                  })}
                  @click=${() => {
                    if (published) {
                      publication?.onNewAction?.();
                    }
                    props.onDismiss(pullRequest);
                  }}
                >
                  ${icons.x}
                </button>
              </span>
            </article>
          `;
        })}
        ${recovery ? renderPublicationRecovery(recovery) : nothing}
      </div>
    `;
  }

  function renderPublicationRecovery(publication: GitHubPublicationView) {
    const failed = publication.result?.status === "failed";
    const content = html`<div class="chat-pr__publication-recovery">
      ${renderGitHubPublicationDetails(publication, { inline: failed })}
      ${
        publication.result?.status !== "published"
          ? html`<div>${renderGitHubPublicationAction(publication)}</div>`
          : nothing
      }
    </div>`;
    // A session attempt has no proven relationship to any listed PR. Keep its
    // failed receipt inspectable without presenting it as that PR’s current state.
    return failed
      ? html`<details class="chat-pr__publication-history">
          <summary>${t("githubPublication.failedAttempt")}</summary>
          ${content}
        </details>`
      : content;
  }

  return renderChatPullRequests;
}
