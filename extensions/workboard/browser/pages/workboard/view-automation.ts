import type { CronJob } from "@openclaw/gateway-protocol";
import type { WorkboardMetadata } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { automationNextRunTime } from "./view-card-time.ts";
import { formatUpdatedTime, type BoardAutomationState } from "./view-helpers.ts";
import { workboardPopoverRef } from "./view-popover.ts";

export async function loadBoardAutomation(
  client: GatewayBrowserClient,
  jobId: string,
): Promise<BoardAutomationState> {
  try {
    const job = await client.request<CronJob>("cron.get", { id: jobId });
    return { jobId, status: "loaded", job };
  } catch (error) {
    return { jobId, status: "unavailable", error: formatUiError(error) };
  }
}

function automationSchedule(job: CronJob): string {
  const schedule = job.schedule;
  if (schedule.kind === "cron") {
    return `${schedule.expr}${schedule.tz ? ` · ${schedule.tz}` : ""}`;
  }
  if (schedule.kind === "every") {
    return t("workboard.automationEvery", {
      duration: formatDurationCompact(schedule.everyMs) ?? String(schedule.everyMs),
    });
  }
  if (schedule.kind === "at") {
    return t("workboard.automationAt", {
      time: formatUpdatedTime(Date.parse(schedule.at)) || schedule.at,
    });
  }
  if (schedule.kind === "on-exit") {
    return t("workboard.automationOnExit", { command: schedule.command });
  }
  return t("workboard.automationStream", { command: schedule.command.join(" ") });
}

export function renderBoardAutomationHeading(automation: BoardAutomationState | undefined) {
  if (!automation) {
    return nothing;
  }
  const job = automation.status === "loaded" ? automation.job : undefined;
  const infoId = `workboard-automation-${encodeURIComponent(automation.jobId)}`;
  const ageMinutes = job ? Math.floor(Math.max(0, Date.now() - job.updatedAtMs) / 60_000) : 0;
  const updated = ageMinutes
    ? t("workboard.automationUpdatedAgo", {
        time: formatDurationCompact(ageMinutes * 60_000) ?? "",
      })
    : t("workboard.automationUpdatedNow");
  return html`
    <div
      class="workboard-heading__automation"
      role="group"
      aria-label=${t("workboard.boardAutomation")}
      aria-busy=${automation.status === "loading"}
    >
      ${
        job
          ? html`
              <a
                class="workboard-heading__automation-name"
                href=${`${workboardHost().basePath}/automations?job=${encodeURIComponent(automation.jobId)}`}
                aria-describedby=${infoId}
                aria-label=${t("workboard.openNamedAutomation", {
                  name: job.displayName ?? job.name,
                })}
              >
                <span class="workboard-heading__automation-icon" aria-hidden="true"
                  >${icons.calendarClock}</span
                >
                <span class="workboard-heading__automation-label"
                  >${job.displayName ?? job.name}</span
                >
              </a>
              <div
                id=${infoId}
                class="workboard-automation-info"
                popover="auto"
                role="tooltip"
                ${ref(workboardPopoverRef("start", true))}
              >
                <strong>${t("workboard.boardAutomation")}</strong>
                ${job.description ? html`<p>${job.description}</p>` : nothing}
                <dl>
                  <dt>${t("workboard.automationState")}</dt>
                  <dd>
                    ${t(job.enabled ? "workboard.automationEnabled" : "workboard.automationPaused")}
                  </dd>
                  <dt>${t("workboard.automationFrequency")}</dt>
                  <dd>${automationSchedule(job)}</dd>
                  <dt>${t("workboard.automationNextRunLabel")}</dt>
                  <dd>
                    ${
                      job.enabled && job.state.nextRunAtMs
                        ? formatUpdatedTime(job.state.nextRunAtMs)
                        : t("workboard.automationNotScheduled")
                    }
                  </dd>
                  <dt>${t("workboard.detailUpdated")}</dt>
                  <dd>${formatUpdatedTime(job.updatedAtMs)}</dd>
                </dl>
              </div>
            `
          : html`
              <span
                class="workboard-heading__automation-name"
                title=${
                  automation.status === "unavailable"
                    ? t("workboard.automationRefreshHint")
                    : nothing
                }
              >
                <span class="workboard-heading__automation-icon" aria-hidden="true"
                  >${icons.calendarClock}</span
                >
                <span class="workboard-heading__automation-label"
                  >${t(
                    automation.status === "loading"
                      ? "workboard.automationLoading"
                      : "workboard.automationUnavailable",
                  )}</span
                >
              </span>
            `
      }
      ${
        job
          ? html`
              <span class="workboard-heading__automation-meta">
                <span>${job.enabled ? updated : t("workboard.automationPaused")}</span>
                ${
                  job.enabled && job.state.nextRunAtMs
                    ? html`<span class="workboard-heading__automation-next-run">
                        <time
                          datetime=${new Date(job.state.nextRunAtMs).toISOString()}
                          title=${formatUpdatedTime(job.state.nextRunAtMs)}
                          >${automationNextRunTime(job.state.nextRunAtMs, Date.now())}</time
                        >
                      </span>`
                    : nothing
                }
              </span>
            `
          : nothing
      }
    </div>
  `;
}

export function renderBoardAutomation(
  automation: BoardAutomationState | undefined,
  onNavigate?: (event: MouseEvent) => void,
) {
  return automation
    ? html`
        <section class="workboard-board-draft__automation">
          <span class="workboard-board-draft__automation-label"
            >${t("workboard.boardAutomation")}</span
          >
          <div class="workboard-board-draft__automation-row">
            <span class="workboard-board-draft__automation-icon" aria-hidden="true"
              >${icons.calendarClock}</span
            >
            <div class="workboard-board-draft__automation-copy">
              ${
                automation.status === "loaded"
                  ? html`
                      <strong>${automation.job.displayName ?? automation.job.name}</strong>
                      <span>${automationSchedule(automation.job)}</span>
                      ${
                        !automation.job.enabled
                          ? html`<small>${t("workboard.automationPaused")}</small>`
                          : automation.job.state.nextRunAtMs
                            ? html`<small
                                >${t("workboard.automationNextRun", {
                                  time: formatUpdatedTime(automation.job.state.nextRunAtMs),
                                })}</small
                              >`
                            : nothing
                      }
                    `
                  : html`
                      <strong
                        >${t(
                          automation.status === "loading"
                            ? "workboard.automationLoading"
                            : "workboard.automationUnavailable",
                        )}</strong
                      >
                      <span>${automation.jobId}</span>
                      ${
                        automation.status === "unavailable"
                          ? html`<small>${automation.error}</small>`
                          : nothing
                      }
                    `
              }
            </div>
            ${
              automation.status === "loaded"
                ? html`
                    <a
                      @click=${onNavigate ?? nothing}
                      href=${`${workboardHost().basePath}/automations?job=${encodeURIComponent(automation.jobId)}`}
                      aria-label=${t("workboard.openNamedAutomation", {
                        name: automation.job.displayName ?? automation.job.name,
                      })}
                    >
                      <span>${t("workboard.openBoardAutomation")}</span>
                    </a>
                  `
                : nothing
            }
          </div>
        </section>
      `
    : nothing;
}

export function automationDetailFields(automation: WorkboardMetadata["automation"]) {
  const fields: Array<readonly [string, string | number | undefined]> = automation
    ? [
        [t("workboard.detailScheduled"), formatUpdatedTime(automation.scheduledAt)],
        [t("workboard.detailSkills"), automation.skills?.join(", ")],
        [
          t("workboard.detailWorkspace"),
          [automation.workspace?.kind, automation.workspace?.path, automation.workspace?.branch]
            .filter(Boolean)
            .join(" · "),
        ],
        [t("workboard.detailDispatchCount"), automation.dispatchCount],
        [t("workboard.detailLastDispatch"), formatUpdatedTime(automation.lastDispatchAt)],
        [
          t("workboard.detailRuntimeLimit"),
          automation.maxRuntimeSeconds !== undefined
            ? (formatDurationCompact(automation.maxRuntimeSeconds * 1000) ?? undefined)
            : undefined,
        ],
        [t("workboard.detailRetryLimit"), automation.maxRetries],
      ]
    : [];
  return fields.filter(([, value]) => value !== undefined && value !== "");
}
