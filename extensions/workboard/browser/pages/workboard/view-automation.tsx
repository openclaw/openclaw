/** @jsxImportSource @solidjs/web */
import type { CronJob } from "@openclaw/gateway-protocol";
import type { WorkboardMetadata } from "@openclaw/workboard-contract";
import { Show, createEffect } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.tsx";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { automationNextRunTime } from "./view-card-time.tsx";
import { formatUpdatedTime, type BoardAutomationState } from "./view-helpers.tsx";
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

export function BoardAutomationHeading(props: {
  automation: BoardAutomationState | undefined;
  revision?: number;
}) {
  const current = () => {
    void props.revision;
    return props.automation;
  };
  return (
    <Show when={current()}>
      {(automation) => (
        <BoardAutomationHeadingContent automation={automation()} revision={props.revision} />
      )}
    </Show>
  );
}

function BoardAutomationHeadingContent(props: {
  automation: BoardAutomationState;
  revision?: number;
}) {
  const automation = () => {
    void props.revision;
    return props.automation;
  };
  const job = () => {
    const current = automation();
    return current.status === "loaded" ? { ...current.job } : undefined;
  };
  const infoId = () => `workboard-automation-${encodeURIComponent(automation().jobId)}`;
  const updated = (loaded: CronJob) => {
    const ageMinutes = Math.floor(Math.max(0, Date.now() - loaded.updatedAtMs) / 60_000);
    return ageMinutes
      ? t("workboard.automationUpdatedAgo", {
          time: formatDurationCompact(ageMinutes * 60_000) ?? "",
        })
      : t("workboard.automationUpdatedNow");
  };
  return (
    <div
      class="workboard-heading__automation"
      role="group"
      aria-label={t("workboard.boardAutomation")}
      aria-busy={automation().status === "loading" ? "true" : "false"}
    >
      <Show
        when={job()}
        fallback={
          <span
            class="workboard-heading__automation-name"
            title={
              automation().status === "unavailable"
                ? t("workboard.automationRefreshHint")
                : undefined
            }
          >
            <span class="workboard-heading__automation-icon" aria-hidden="true">
              {icons.calendarClock}
            </span>
            <span class="workboard-heading__automation-label">
              {t(
                automation().status === "loading"
                  ? "workboard.automationLoading"
                  : "workboard.automationUnavailable",
              )}
            </span>
          </span>
        }
      >
        {(loaded) => (
          <>
            <a
              class="workboard-heading__automation-name"
              href={`${workboardHost().basePath}/automations?job=${encodeURIComponent(automation().jobId)}`}
              aria-describedby={infoId()}
              aria-label={t("workboard.openNamedAutomation", {
                name: loaded().displayName ?? loaded().name,
              })}
            >
              <span class="workboard-heading__automation-icon" aria-hidden="true">
                {icons.calendarClock}
              </span>
              <span class="workboard-heading__automation-label">
                {loaded().displayName ?? loaded().name}
              </span>
            </a>
            <div
              id={infoId()}
              class="workboard-automation-info"
              popover="auto"
              role="tooltip"
              ref={workboardPopoverRef("start", true)}
            >
              <strong>{t("workboard.boardAutomation")}</strong>
              {loaded().description ? <p>{loaded().description}</p> : undefined}
              <dl>
                <dt>{t("workboard.automationState")}</dt>
                <dd>
                  {t(
                    loaded().enabled ? "workboard.automationEnabled" : "workboard.automationPaused",
                  )}
                </dd>
                <dt>{t("workboard.automationFrequency")}</dt>
                <dd>{automationSchedule(loaded())}</dd>
                <dt>{t("workboard.automationNextRunLabel")}</dt>
                <dd>
                  {loaded().enabled && loaded().state.nextRunAtMs
                    ? formatUpdatedTime(loaded().state.nextRunAtMs)
                    : t("workboard.automationNotScheduled")}
                </dd>
                <dt>{t("workboard.detailUpdated")}</dt>
                <dd>{formatUpdatedTime(loaded().updatedAtMs)}</dd>
              </dl>
            </div>
            <span class="workboard-heading__automation-meta">
              <span>{loaded().enabled ? updated(loaded()) : t("workboard.automationPaused")}</span>
              <Show when={loaded().enabled && loaded().state.nextRunAtMs}>
                {(nextRun) => (
                  <span class="workboard-heading__automation-next-run">
                    <time
                      datetime={new Date(nextRun()).toISOString()}
                      title={formatUpdatedTime(nextRun())}
                    >
                      {automationNextRunTime(nextRun(), Date.now())}
                    </time>
                  </span>
                )}
              </Show>
            </span>
          </>
        )}
      </Show>
    </div>
  );
}

export function BoardAutomation(props: {
  automation: BoardAutomationState | undefined;
  onNavigate?: (event: MouseEvent) => void;
}) {
  return (
    <Show when={props.automation}>
      {(automation) => (
        <BoardAutomationContent automation={automation()} onNavigate={props.onNavigate} />
      )}
    </Show>
  );
}

function BoardAutomationContent(props: {
  automation: BoardAutomationState;
  onNavigate?: (event: MouseEvent) => void;
}) {
  const job = () => (props.automation.status === "loaded" ? props.automation.job : undefined);
  return (
    <section class="workboard-board-draft__automation">
      <span class="workboard-board-draft__automation-label">{t("workboard.boardAutomation")}</span>
      <div class="workboard-board-draft__automation-row">
        <span class="workboard-board-draft__automation-icon" aria-hidden="true">
          {icons.calendarClock}
        </span>
        <div class="workboard-board-draft__automation-copy">
          <Show
            when={job()}
            fallback={
              <>
                <strong>
                  {t(
                    props.automation.status === "loading"
                      ? "workboard.automationLoading"
                      : "workboard.automationUnavailable",
                  )}
                </strong>
                <span>{props.automation.jobId}</span>
                {props.automation.status === "unavailable" ? (
                  <small>{props.automation.error}</small>
                ) : undefined}
              </>
            }
          >
            {(loaded) => (
              <>
                <strong>{loaded().displayName ?? loaded().name}</strong>
                <span>{automationSchedule(loaded())}</span>
                {!loaded().enabled ? (
                  <small>{t("workboard.automationPaused")}</small>
                ) : loaded().state.nextRunAtMs ? (
                  <small>
                    {t("workboard.automationNextRun", {
                      time: formatUpdatedTime(loaded().state.nextRunAtMs),
                    })}
                  </small>
                ) : undefined}
              </>
            )}
          </Show>
        </div>
        <Show when={job()}>
          {(loaded) => (
            <BoardAutomationLink
              job={loaded()}
              jobId={props.automation.jobId}
              onNavigate={props.onNavigate}
            />
          )}
        </Show>
      </div>
    </section>
  );
}

function BoardAutomationLink(props: {
  job: CronJob;
  jobId: string;
  onNavigate?: (event: MouseEvent) => void;
}) {
  let link!: HTMLAnchorElement;
  createEffect(
    () => props.onNavigate,
    (navigate) => {
      if (!navigate) {
        return undefined;
      }
      // Navigation admission must precede native listeners and the browser's default action.
      link.addEventListener("click", navigate);
      return () => link.removeEventListener("click", navigate);
    },
  );
  return (
    <a
      ref={(element) => {
        link = element;
      }}
      href={`${workboardHost().basePath}/automations?job=${encodeURIComponent(props.jobId)}`}
      aria-label={t("workboard.openNamedAutomation", {
        name: props.job.displayName ?? props.job.name,
      })}
    >
      <span>{t("workboard.openBoardAutomation")}</span>
    </a>
  );
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
