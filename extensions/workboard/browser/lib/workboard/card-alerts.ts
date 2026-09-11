import type { CardSessionState } from "./session-state.ts";
import type { WorkboardCard, WorkboardDependencyState, WorkboardLifecycle } from "./types.ts";

export type CardAlert = {
  kind: "diagnostic" | "blocked" | "dependency" | "stale" | "session";
  severity: "critical" | "error" | "warning" | "info";
  title: string;
  detail?: string;
  timestamp: number;
  ageMs?: number;
  count?: number;
  repeatsSessionState?: CardSessionState;
};

export function visibleCardAlerts(
  alerts: readonly CardAlert[],
  sessionStatus: CardSessionState | undefined,
): CardAlert[] {
  return alerts.filter(
    (alert) => sessionStatus === undefined || alert.repeatsSessionState !== sessionStatus,
  );
}

export function getCardStaleAgeMs(
  card: WorkboardCard,
  lifecycle: WorkboardLifecycle,
  now: number,
): number | undefined {
  const lastActivity =
    lifecycle.state === "stale"
      ? (lifecycle.session?.updatedAt ?? card.metadata?.stale?.lastSessionUpdatedAt)
      : card.metadata?.stale?.lastSessionUpdatedAt;
  return typeof lastActivity === "number" ? Math.max(0, now - lastActivity) : undefined;
}

const severityRank = { critical: 3, error: 2, warning: 1, info: 0 } as const;

function compareAlerts(left: CardAlert, right: CardAlert): number {
  return (
    severityRank[right.severity] - severityRank[left.severity] ||
    right.timestamp - left.timestamp ||
    left.kind.localeCompare(right.kind) ||
    left.title.localeCompare(right.title) ||
    (left.detail ?? "").localeCompare(right.detail ?? "")
  );
}

export function selectCardAlert(alerts: readonly CardAlert[]): CardAlert | undefined {
  return alerts.reduce<CardAlert | undefined>(
    (selected, alert) => (!selected || compareAlerts(alert, selected) < 0 ? alert : selected),
    undefined,
  );
}

export function getCardAlerts(
  card: WorkboardCard,
  lifecycle: WorkboardLifecycle,
  dependencies: WorkboardDependencyState,
  now: number,
): CardAlert[] {
  const metadata = card.metadata;
  const alerts: CardAlert[] = (metadata?.diagnostics ?? []).map((diagnostic) => ({
    kind: "diagnostic",
    severity: diagnostic.severity,
    title: diagnostic.title,
    detail: diagnostic.detail,
    timestamp: diagnostic.lastSeenAt,
    count: diagnostic.count,
  }));
  const runId = card.runId ?? card.execution?.runId;
  // Only the current run can explain its blocker. Match the store's notification ordering.
  const notification = runId
    ? metadata?.notifications
        ?.filter((entry) => entry.runId === runId)
        .toSorted((left, right) => {
          if (left.createdAt !== right.createdAt) {
            return right.createdAt - left.createdAt;
          }
          if (left.sequence !== undefined && right.sequence !== undefined) {
            return right.sequence - left.sequence || right.id.localeCompare(left.id);
          }
          if (left.sequence !== undefined) {
            return 1;
          }
          if (right.sequence !== undefined) {
            return -1;
          }
          return right.id.localeCompare(left.id);
        })[0]
    : undefined;
  const protocol = metadata?.workerProtocol;
  if (card.status === "blocked") {
    if (protocol?.detail && (protocol.state === "blocked" || protocol.state === "violated")) {
      alerts.push({
        kind: "blocked",
        severity: protocol.state === "violated" ? "error" : "warning",
        title: protocol.detail,
        timestamp: protocol.updatedAt,
      });
    } else if (notification?.kind === "failed") {
      alerts.push({
        kind: "blocked",
        severity: "warning",
        title: notification.message,
        timestamp: notification.createdAt,
      });
    }
  }
  if (dependencies.blockedParents.length) {
    alerts.push({
      kind: "dependency",
      severity: "warning",
      title: dependencies.blockedParents.map((parent) => parent.title).join(", "),
      timestamp: card.updatedAt,
      count: dependencies.blockedParents.length,
    });
  }
  const stale = metadata?.stale;
  if (stale || lifecycle.state === "stale") {
    const lastActivity =
      lifecycle.state === "stale"
        ? (lifecycle.session?.updatedAt ?? stale?.lastSessionUpdatedAt)
        : stale?.lastSessionUpdatedAt;
    alerts.push({
      kind: "stale",
      repeatsSessionState: "stale",
      severity: "warning",
      title: stale?.reason ?? "Linked session has not reported recent activity.",
      timestamp: stale?.detectedAt ?? lastActivity ?? card.updatedAt,
      ageMs: getCardStaleAgeMs(card, lifecycle, now),
    });
  }
  const seen = new Set<string>();
  return alerts.toSorted(compareAlerts).filter((alert) => {
    const text = (alert.detail || alert.title).trim();
    const key = JSON.stringify([alert.repeatsSessionState ?? null, text]);
    if (!text || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
