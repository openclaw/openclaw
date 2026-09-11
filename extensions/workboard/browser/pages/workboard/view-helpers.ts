import type { CronJob } from "@openclaw/gateway-protocol";
import { html, type TemplateResult } from "lit";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import {
  getWorkboardState,
  workboardMutationsReady,
  type WorkboardCard,
  type WorkboardEvent,
  type WorkboardExecutionEngine,
  type WorkboardLifecycle,
  type WorkboardPriority,
  type WorkboardStatus,
  type WorkboardTaskSummary,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import { isReservedSessionKey } from "../../lib/workboard/session-links.ts";
import type { WorkboardSessionResolution } from "../../lib/workboard/session-resolution.ts";
import { taskMatchesLifecycle } from "../../lib/workboard/session-state.ts";
import { agentDisplayName, findCardAgent, type WorkboardAgentsList } from "./agent-filter.ts";
export { taskMatchesLifecycle } from "../../lib/workboard/session-state.ts";

export type BoardAutomationState = { jobId: string } & (
  | { status: "loading" }
  | { status: "loaded"; job: CronJob }
  | { status: "unavailable"; error: string }
);

export type WorkboardProps = {
  heading?: TemplateResult;
  scopeControl?: TemplateResult;
  pageError?: string | null;
  overlayOpen?: boolean;
  presented?: boolean;
  detailBoardAutomation?: BoardAutomationState;
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  canWrite?: boolean;
  canGrant?: boolean;
  canModelOverride?: boolean;
  agentsList: WorkboardAgentsList | null;
  defaultAgentId?: string | null;
  sessions: GatewaySessionRow[];
  sessionResolution?: WorkboardSessionResolution;
  scopeAgentId?: string | null;
  showAgentFilter?: boolean;
  onOpenSession: ControlUiHost["sessions"]["open"];
  onBoardFilterChange?: (boardFilter: string) => void;
  onRequestUpdate?: () => void;
};

const eventLabelKeys: Record<WorkboardEvent["kind"], string> = {
  created: "workboard.eventCreated",
  edited: "workboard.eventEdited",
  moved: "workboard.eventMoved",
  linked: "workboard.eventLinked",
  specified: "workboard.eventSpecified",
  decomposed: "workboard.eventDecomposed",
  claimed: "workboard.eventClaimed",
  heartbeat: "workboard.eventHeartbeat",
  execution_updated: "workboard.eventExecutionUpdated",
  attempt_started: "workboard.eventAttemptStarted",
  attempt_updated: "workboard.eventAttemptUpdated",
  comment_added: "workboard.eventCommentAdded",
  link_added: "workboard.eventLinkAdded",
  proof_added: "workboard.eventProofAdded",
  artifact_added: "workboard.eventArtifactAdded",
  attachment_added: "workboard.eventAttachmentAdded",
  diagnostic: "workboard.eventDiagnostic",
  notification: "workboard.eventNotification",
  dispatch: "workboard.eventDispatch",
  orchestration: "workboard.eventOrchestration",
  protocol_violation: "workboard.eventProtocolViolation",
  archived: "workboard.eventArchived",
  unarchived: "workboard.eventUnarchived",
  stale: "workboard.eventStale",
};

type LifecycleCopy = readonly [
  labelKey: string,
  detailKey: string | undefined,
  tone: "blocked" | "done" | "idle" | "live",
];

const lifecycleCopy = {
  queued: ["sessionsView.statusQueued", undefined, "idle"],
  running: ["workboard.lifecycleRunning", "workboard.lifecycleRunningDetail", "live"],
  succeeded: ["workboard.lifecycleDone", "workboard.lifecycleDoneDetail", "done"],
  failed: ["workboard.lifecycleFailed", "workboard.lifecycleFailedDetail", "blocked"],
  stale: ["workboard.lifecycleStale", "workboard.lifecycleStaleDetail", "blocked"],
  idle: ["workboard.lifecycleLinked", "workboard.lifecycleIdleDetail", "idle"],
  unknown: ["workboard.lifecycleUnknown", "workboard.lifecycleUnknownDetail", "idle"],
  unavailable: ["workboard.lifecycleUnavailable", "workboard.lifecycleUnavailableDetail", "idle"],
  ambiguous: ["workboard.lifecycleAmbiguous", "workboard.lifecycleAmbiguousDetail", "blocked"],
  unlinked: ["workboard.lifecycleUnlinked", "workboard.lifecycleUnlinkedDetail", "idle"],
} as const satisfies Record<WorkboardLifecycle["state"], LifecycleCopy>;

export const formatStatusLabel = (status: WorkboardStatus) => t(`workboard.status.${status}`);

export const formatPriorityLabel = (priority: WorkboardPriority) =>
  priority.charAt(0).toUpperCase() + priority.slice(1);

const priorityIcons = {
  low: icons.priorityLow,
  normal: icons.priorityNormal,
  high: icons.priorityHigh,
  urgent: icons.priorityUrgent,
} satisfies Record<WorkboardPriority, TemplateResult>;

export const renderPriorityIcon = (priority: WorkboardPriority) => priorityIcons[priority];

export function formatRefreshTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatUpdatedTime(value: number | undefined): string {
  return value
    ? formatDateTimeMs(
        value,
        { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
        "",
      )
    : "";
}

export function workboardErrorMessage(
  state: Pick<WorkboardUiState, "error" | "lifecycleTaskRefreshError" | "lastRefreshError">,
  pageError?: string | null,
) {
  return state.error ?? pageError ?? state.lifecycleTaskRefreshError ?? state.lastRefreshError;
}

export function canMutate(props: WorkboardProps): boolean {
  return props.canWrite !== false && workboardMutationsReady(getWorkboardState(props.host));
}

export function formatEventLabel(event: WorkboardEvent): string {
  if (event.kind === "moved" && event.toStatus) {
    return t("workboard.eventMovedTo", { status: formatStatusLabel(event.toStatus) });
  }
  return t(eventLabelKeys[event.kind]);
}

export function matchesFilter(
  card: WorkboardCard,
  options: { query: string; priority: "all" | WorkboardPriority },
): boolean {
  if (options.priority !== "all" && card.priority !== options.priority) {
    return false;
  }
  const query = options.query.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return [
    card.title,
    card.notes,
    card.agentId,
    card.sessionKey,
    card.execution?.engine,
    card.execution?.mode,
    card.execution?.model,
    card.execution?.sessionKey,
    card.metadata?.templateId,
    card.metadata?.automation?.tenant,
    card.metadata?.automation?.idempotencyKey,
    card.metadata?.automation?.workspace?.kind,
    card.metadata?.automation?.workspace?.path,
    card.metadata?.automation?.workspace?.branch,
    ...(card.metadata?.automation?.skills ?? []),
    ...(card.metadata?.automation?.createdCardIds ?? []),
    ...(card.metadata?.comments ?? []).map((comment) => comment.body),
    ...(card.metadata?.links ?? []).flatMap((link) => [link.title, link.url, link.targetCardId]),
    ...(card.metadata?.proof ?? []).flatMap((proof) => [
      proof.label,
      proof.command,
      proof.url,
      proof.note,
    ]),
    ...(card.metadata?.artifacts ?? []).flatMap((artifact) => [
      artifact.label,
      artifact.url,
      artifact.path,
      artifact.mimeType,
    ]),
    ...(card.metadata?.attachments ?? []).flatMap((attachment) => [
      attachment.fileName,
      attachment.mimeType,
      attachment.note,
    ]),
    ...(card.metadata?.workerLogs ?? []).map((log) => log.message),
    card.metadata?.workerProtocol?.state,
    card.metadata?.workerProtocol?.detail,
    card.metadata?.claim?.ownerId,
    ...(card.metadata?.diagnostics ?? []).flatMap((diagnostic) => [
      diagnostic.kind,
      diagnostic.severity,
      diagnostic.title,
      diagnostic.detail,
    ]),
    ...(card.metadata?.notifications ?? []).map((notification) => notification.message),
    ...card.labels,
  ]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(query));
}

export function isWorkboardSessionChoice(session: GatewaySessionRow): boolean {
  if (session.archived || isReservedSessionKey(session.key)) {
    return false;
  }
  const raw = [session.key, session.label, session.displayName]
    .filter((value): value is string => typeof value === "string")
    .join(":")
    .toLowerCase();
  return !/(^|:)heartbeat(:|$)/.test(raw);
}

export function engineBlockedByRuntime(
  props: WorkboardProps,
  card: WorkboardCard,
  engine: WorkboardExecutionEngine | null,
): string | null {
  if (!engine) {
    return null;
  }
  const agent = findCardAgent(card, props.agentsList);
  const runtime = agent?.agentRuntime?.id?.trim();
  if (!runtime) {
    return null;
  }
  const normalized = runtime.toLowerCase();
  if (normalized === "openclaw" || normalized === "pi") {
    return null;
  }
  return t("workboard.engineDisabledRuntime", {
    agent: agentDisplayName(agent, card.agentId ?? t("workboard.defaultAgent")),
    runtime,
  });
}

export function formatLifecycle(
  lifecycle: WorkboardLifecycle,
  task?: WorkboardTaskSummary,
): {
  label: string;
  detail: string | undefined;
  tone: "blocked" | "done" | "idle" | "live";
} {
  if (task && taskMatchesLifecycle(task, lifecycle)) {
    return {
      label: t(`workboard.taskStatus.${task.status}`),
      detail: taskDetail(task),
      tone:
        task.status === "cancelled" || task.status === "queued"
          ? "idle"
          : task.status === "running"
            ? "live"
            : task.status === "completed"
              ? "done"
              : "blocked",
    };
  }
  if (lifecycle.state === "failed") {
    if (lifecycle.session?.status === "timeout") {
      return {
        label: t("workboard.lifecycleTimedOut"),
        detail: t("workboard.lifecycleFailedDetail"),
        tone: "blocked",
      };
    }
    if (lifecycle.session?.status === "killed" || lifecycle.session?.abortedLastRun) {
      return {
        label: t("workboard.lifecycleStopped"),
        detail: t("workboard.lifecycleStoppedDetail"),
        tone: "idle",
      };
    }
  }
  const [labelKey, detailKey, tone] = lifecycleCopy[lifecycle.state];
  return { label: t(labelKey), detail: detailKey === undefined ? undefined : t(detailKey), tone };
}

export function taskDetail(task: WorkboardTaskSummary): string {
  if (task.status === "queued" || task.status === "running") {
    return task.progressSummary ?? task.title ?? task.taskId;
  }
  return task.terminalSummary ?? task.error ?? task.progressSummary ?? task.title ?? task.taskId;
}

const taskIsActive = (task: WorkboardTaskSummary | undefined) =>
  task?.status === "queued" || task?.status === "running";

function cardHasUnresolvedTaskLink(
  card: WorkboardCard,
  task: WorkboardTaskSummary | undefined,
  missingTaskIds: ReadonlySet<string>,
): boolean {
  return Boolean(card.taskId && !task && !missingTaskIds.has(card.taskId));
}

export function cardHasActiveOrRunningUnresolvedTask(
  card: WorkboardCard,
  task: WorkboardTaskSummary | undefined,
  missingTaskIds: ReadonlySet<string>,
): boolean {
  return (
    taskIsActive(task) ||
    (card.status === "running" && cardHasUnresolvedTaskLink(card, task, missingTaskIds))
  );
}

export function cardHasUnresolvedStartedRun(card: WorkboardCard): boolean {
  const sessionKey = card.sessionKey ?? card.execution?.sessionKey;
  const runId = card.runId ?? card.execution?.runId;
  return card.status === "running" && Boolean(sessionKey && runId);
}

export function renderLifecycleIcon(lifecycle: WorkboardLifecycle, task?: WorkboardTaskSummary) {
  const authoritativeTask = task && taskMatchesLifecycle(task, lifecycle) ? task : undefined;
  const queuedTask = authoritativeTask?.status === "queued";
  if (lifecycle.state === "running" && !queuedTask) {
    return html`<span class="session-run-spinner" aria-hidden="true"></span>`;
  }
  const icon =
    lifecycle.state === "failed" &&
    (authoritativeTask
      ? authoritativeTask.status === "cancelled"
      : lifecycle.session?.status === "killed" || lifecycle.session?.abortedLastRun)
      ? icons.stop
      : lifecycle.state === "queued" || queuedTask
        ? icons.hourglass
        : lifecycle.state === "stale"
          ? icons.alertTriangle
          : lifecycle.state === "succeeded"
            ? icons.check
            : lifecycle.state === "idle" || lifecycle.state === "unlinked"
              ? icons.messageSquare
              : icons.alertTriangle;
  return html`<span class="workboard-card__session-icon" aria-hidden="true">${icon}</span>`;
}
