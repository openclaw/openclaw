import { expect, it } from "vitest";
import {
  getCardAlerts,
  selectCardAlert,
  visibleCardAlerts,
  type CardAlert,
} from "./card-alerts.ts";
import { getCardSessionState } from "./session-state.ts";
import { createGatewaySession, createWorkboardCard } from "./test/index-helpers.ts";
import type { WorkboardCard, WorkboardLifecycle } from "./types.ts";

function diagnosticAlerts(
  metadata: WorkboardCard["metadata"],
  lifecycle: WorkboardLifecycle,
  severity: "critical" | "warning" = "warning",
  now = 100,
) {
  const card = createWorkboardCard({
    status: "blocked",
    metadata: {
      ...metadata,
      diagnostics: [
        {
          kind: "missing_proof",
          severity,
          title: "Release verification missing",
          detail: "Attach verification evidence",
          firstSeenAt: 1,
          lastSeenAt: 1,
          count: 1,
          actions: [],
        },
      ],
    },
  });
  return getCardAlerts(card, lifecycle, { parents: [], blockedParents: [] }, now);
}

it("uses the native session terminal outcome", () => {
  const session = createGatewaySession({ status: "timeout", updatedAt: 100 });
  expect(getCardSessionState({ state: "failed", session })).toBe("timed_out");
});

it.each([undefined, "running"] as const)("keeps alerts with a nonmatching %s badge", (state) => {
  const alert: CardAlert = {
    kind: "session",
    title: "failed",
    severity: "warning",
    timestamp: 100,
    repeatsSessionState: "failed",
  };
  expect(visibleCardAlerts([alert], state)).toEqual([alert]);
});

it("preserves a real failure reason even when its text equals the state label", () => {
  const alerts = diagnosticAlerts(
    { workerProtocol: { state: "violated", detail: "failed", updatedAt: 100 } },
    { state: "failed", session: null },
    "critical",
  );
  const visible = visibleCardAlerts(alerts, "failed");
  expect(visible.map((alert) => alert.title)).toEqual(["Release verification missing", "failed"]);
  expect(selectCardAlert(visible)?.severity).toBe("critical");
});

it("moves the repeated stale age to session presentation without hiding independent diagnostics", () => {
  const alerts = diagnosticAlerts(
    {
      stale: { detectedAt: 5_700_000, lastSessionUpdatedAt: 0, reason: "No recent activity" },
    },
    { state: "stale", session: createGatewaySession({ updatedAt: 0 }) },
    "warning",
    5_760_000,
  );
  expect(alerts.find((alert) => alert.kind === "stale")).toMatchObject({
    ageMs: 5_760_000,
    repeatsSessionState: "stale",
  });
  expect(visibleCardAlerts(alerts, "stale").map((alert) => alert.title)).toEqual([
    "Release verification missing",
  ]);
});
