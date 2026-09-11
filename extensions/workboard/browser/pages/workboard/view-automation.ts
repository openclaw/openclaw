import type { CronJob } from "@openclaw/gateway-protocol";
import type { WorkboardMetadata } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { formatUpdatedTime, type BoardAutomationState } from "./view-helpers.ts";

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
  const metadata = job
    ? [
        automationSchedule(job),
        t("workboard.automationUpdated", { time: formatUpdatedTime(job.updatedAtMs) }),
        !job.enabled
          ? t("workboard.automationPaused")
          : job.state.nextRunAtMs
            ? t("workboard.automationNextRun", { time: formatUpdatedTime(job.state.nextRunAtMs) })
            : undefined,
      ].filter(Boolean)
    : [];
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
      <span class="workboard-heading__automation-icon" aria-hidden="true"
        >${icons.calendarClock}</span
      >
      ${
        job
          ? html`<a
              class="workboard-heading__automation-name"
              href=${`${workboardHost().basePath}/automations?job=${encodeURIComponent(automation.jobId)}`}
              title=${[job.displayName ?? job.name, ...metadata].join(" · ")}
              aria-label=${t("workboard.openNamedAutomation", {
                name: job.displayName ?? job.name,
              })}
              >${job.displayName ?? job.name}</a
            >`
          : html`<span
              class="workboard-heading__automation-name"
              title=${
                automation.status === "unavailable" ? t("workboard.automationRefreshHint") : nothing
              }
              >${t(
                automation.status === "loading"
                  ? "workboard.automationLoading"
                  : "workboard.automationUnavailable",
              )}</span
            >`
      }
      ${
        job
          ? html`<span class="workboard-heading__automation-updated"
              >${job.enabled ? updated : t("workboard.automationPaused")}</span
            >`
          : nothing
      }
    </div>
  `;
}

export function renderBoardAutomation(automation: BoardAutomationState | undefined) {
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
