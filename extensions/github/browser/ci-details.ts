import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  ControlUiSessionPullRequestCheck,
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequestCheckStep,
} from "../control-ui-contract.js";
import type { GitHubPresentationHost } from "./presentation-host.js";

export const GITHUB_CHECK_ORDER = { failed: 0, running: 1, passed: 2, skipped: 3 } as const;

type GitHubCiDetailsProps = {
  loading: boolean;
  result?: ControlUiSessionPullRequestCheckDetails;
  error: string | null;
  retryAt: number;
  expandedJobs: ReadonlyMap<number, boolean>;
  baseURI: string;
  onRetry: () => void;
  onExpandedChange: (id: number, expanded: boolean) => void;
};

export function createGitHubCiDetailsRenderer(
  host: Pick<GitHubPresentationHost, "t"> & {
    icons: Record<
      "check" | "circleX" | "loader" | "clock" | "chevronDown" | "externalLink",
      unknown
    >;
    skippedIcon: unknown;
    formatDurationCompact: (milliseconds: number) => string | undefined;
    resolveSafeExternalUrl: (value: string, baseURI: string) => string | null;
  },
) {
  const { t, icons, formatDurationCompact, resolveSafeExternalUrl } = host;
  type CheckState = ControlUiSessionPullRequestCheck["state"] | "queued";

  const STEP_CONCLUSIONS = new Map<string, CheckState>([
    ["success", "passed"],
    ["failure", "failed"],
    ["timed_out", "failed"],
    ["action_required", "failed"],
    ["startup_failure", "failed"],
    ["skipped", "skipped"],
    ["neutral", "skipped"],
    ["cancelled", "skipped"],
  ]);

  function stepState(step: ControlUiSessionPullRequestCheckStep): CheckState {
    if (step.status === "in_progress") {
      return "running";
    }
    return STEP_CONCLUSIONS.get(step.conclusion ?? "") ?? "queued";
  }

  const CHECK_PRESENTATION = {
    passed: ["chat.pullRequests.checksPassed", icons.check],
    failed: ["chat.pullRequests.checksFailed", icons.circleX],
    running: ["chat.pullRequests.checksRunning", icons.loader],
    skipped: ["chat.pullRequests.checksSkipped", host.skippedIcon],
    queued: ["chat.pullRequests.checksQueued", icons.clock],
  } as const;

  function renderStatus(state: CheckState) {
    const [labelKey, icon] = CHECK_PRESENTATION[state];
    const label = t(labelKey);
    return html`<span
      class="chat-ci__status"
      data-state=${state}
      role="img"
      aria-label=${label}
      title=${label}
      >${icon}</span
    >`;
  }

  function duration(item: { startedAt?: string; completedAt?: string }, running: boolean): string {
    const start = item.startedAt ? Date.parse(item.startedAt) : Number.NaN;
    const end = item.completedAt ? Date.parse(item.completedAt) : running ? Date.now() : Number.NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? (formatDurationCompact(end - start) ?? "")
      : "";
  }

  return (props: GitHubCiDetailsProps) => {
    function renderNotice() {
      const result = props.result;
      const limited = result?.rateLimited;
      const stale = result?.status === "stale";
      const unavailable = props.error || result?.status === "unavailable";
      const incomplete = Boolean(result?.error);
      if (props.loading && !result) {
        return html`<div class="chat-ci__notice" role="status">
          ${t("chat.pullRequests.checksLoading")}
        </div>`;
      }
      if (!limited && !stale && !unavailable && !incomplete) {
        return nothing;
      }
      const retryWait = Math.max(0, props.retryAt - Date.now());
      return html`<div
        class="chat-ci__notice"
        role="status"
        data-state=${limited ? "rate-limited" : "unavailable"}
      >
        <span
          >${
            props.error ??
            (limited
              ? t("chat.pullRequests.checksRateLimited")
              : stale
                ? t("chat.pullRequests.checksStale")
                : t("chat.pullRequests.checksUnavailable"))
          }
          ${retryWait > 0 ? t("chat.pullRequests.checksRetryAfter", { duration: formatDurationCompact(retryWait) ?? "" }) : nothing}
        </span>
        <button
          class="chat-ci__retry"
          type="button"
          ?disabled=${props.loading || retryWait > 0}
          @click=${props.onRetry}
        >
          ${t("common.retry")}
        </button>
      </div>`;
    }

    function renderJob(check: ControlUiSessionPullRequestCheck) {
      const detailsUrl = check.detailsUrl
        ? resolveSafeExternalUrl(check.detailsUrl, props.baseURI)
        : null;
      const jobState: CheckState =
        check.state === "running" && check.status !== "in_progress" ? "queued" : check.state;
      return html`<details
        class="chat-ci__job"
        data-state=${check.state}
        data-check-id=${check.id}
        .open=${props.expandedJobs.get(check.id) ?? false}
        @toggle=${(event: Event) => {
          if (
            !(event.target instanceof HTMLDetailsElement) ||
            event.target !== event.currentTarget
          ) {
            return;
          }
          props.onExpandedChange(check.id, event.target.open);
        }}
      >
        <summary class="chat-ci__job-summary">
          ${renderStatus(jobState)}
          <span class="chat-ci__name">${check.name}</span>
          <span class="chat-ci__duration">${duration(check, jobState === "running")}</span>
          <span class="chat-ci__chevron" aria-hidden="true">${icons.chevronDown}</span>
        </summary>
        <div class="chat-ci__job-detail">
          ${
            check.steps?.length
              ? html`<ol class="chat-ci__steps" role="list">
                  ${repeat(
                    check.steps.toSorted((a, b) => a.number - b.number),
                    (step) => step.number,
                    (step) => {
                      const state = stepState(step);
                      return html`<li
                        class="chat-ci__step"
                        data-state=${state}
                        value=${step.number}
                      >
                        ${renderStatus(state)}<span class="chat-ci__name">${step.name}</span>
                        <span class="chat-ci__duration"
                          >${duration(step, state === "running")}</span
                        >
                      </li>`;
                    },
                  )}
                </ol>`
              : html`<div class="chat-ci__empty-steps">
                  ${
                    check.source === "check"
                      ? t("chat.pullRequests.checksNoSteps")
                      : t("chat.pullRequests.checksStepsUnavailable")
                  }
                </div>`
          }
          ${
            detailsUrl
              ? html`<a
                  class="chat-ci__job-link"
                  href=${detailsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  >${check.source === "actions" ? t("chat.pullRequests.openJob") : t("chat.pullRequests.openCheck")}${icons.externalLink}</a
                >`
              : nothing
          }
        </div>
      </details>`;
    }

    const checks = props.result?.checks ?? [];
    const jobs = checks
      .filter((check) => check.state !== "skipped")
      .toSorted((a, b) => GITHUB_CHECK_ORDER[a.state] - GITHUB_CHECK_ORDER[b.state]);
    const skipped = checks.filter((check) => check.state === "skipped");
    return html`${renderNotice()}
      <div class="chat-ci__jobs" aria-busy=${props.loading ? "true" : "false"}>
        ${repeat(
          jobs,
          (check) => check.id,
          (check) => renderJob(check),
        )}
        ${
          skipped.length
            ? html`<details class="chat-ci__skipped">
                <summary>
                  ${renderStatus("skipped")}<span
                    >${t("chat.pullRequests.checksSkippedCount", { count: String(skipped.length) })}</span
                  >
                  <span class="chat-ci__chevron" aria-hidden="true">${icons.chevronDown}</span>
                </summary>
                ${repeat(
                  skipped,
                  (check) => check.id,
                  (check) => renderJob(check),
                )}
              </details>`
            : nothing
        }
        ${
          props.result?.status === "ready" &&
          !checks.length &&
          !props.result.rateLimited &&
          !props.result.error
            ? html`<div class="chat-ci__notice">${t("chat.pullRequests.checksEmpty")}</div>`
            : nothing
        }
      </div>`;
  };
}
