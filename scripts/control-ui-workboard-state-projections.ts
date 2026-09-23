import {
  getCardAlerts,
  type CardAlert,
} from "../extensions/workboard/browser/lib/workboard/card-alerts.ts";
import { getWorkboardLifecycle } from "../extensions/workboard/browser/lib/workboard/lifecycle.ts";
import {
  getWorkboardStateCell,
  WORKBOARD_STATE_LABELS,
} from "../ui/src/test-helpers/control-ui-workboard-states.ts";

/** Only the opt-in native fixture imports these projections. Persisted cards stay unchanged. */
export const getFixtureLifecycle: typeof getWorkboardLifecycle = (
  card,
  sessions,
  task,
  resolution,
) => {
  const cell = getWorkboardStateCell(card.id);
  if (cell?.state === "unavailable" || cell?.state === "ambiguous") {
    return { session: null, state: cell.state };
  }
  return getWorkboardLifecycle(card, sessions, task, resolution);
};

export const getFixtureAlerts: typeof getCardAlerts = (card, lifecycle, dependencies, now) => {
  const original = getCardAlerts(card, lifecycle, dependencies, now);
  const cell = getWorkboardStateCell(card.id);
  if (!cell) {
    return original;
  }
  if (cell.alert === "none") {
    return [];
  }
  if (cell.alert === "same") {
    const alert: CardAlert = {
      kind: "session",
      severity: "warning",
      title: WORKBOARD_STATE_LABELS[cell.state],
      timestamp: card.updatedAt,
      repeatsSessionState: cell.state === "blocked" ? "unlinked" : cell.state,
    };
    return [alert];
  }
  return [
    {
      kind: "diagnostic",
      severity: "warning",
      title: "Review the deployment evidence",
      detail: "Independent synthetic alert; not an execution-state summary.",
      timestamp: card.updatedAt,
    },
  ];
};
