import { describe, expect, it } from "vitest";
import {
  getCardAlerts,
  selectCardAlert,
  visibleCardAlerts,
  type CardAlert,
} from "./card-alerts.ts";
import { getCardSessionState, type CardSessionState } from "./session-state.ts";
import type { WorkboardCard } from "./types.ts";

function diagnosticCard(
  metadata: WorkboardCard["metadata"],
  severity: "critical" | "warning" = "warning",
): WorkboardCard {
  return {
    id: "review",
    title: "Release review",
    status: "blocked",
    priority: "normal",
    labels: [],
    position: 0,
    createdAt: 0,
    updatedAt: 100,
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
  };
}

describe("card session state", () => {
  it("uses the native session terminal outcome", () => {
    expect(
      getCardSessionState({
        state: "failed",
        session: {
          key: "agent:main:review",
          kind: "direct",
          updatedAt: 100,
          status: "timeout",
        },
      }),
    ).toBe("timed_out");
  });
});

describe("visible card alerts", () => {
  it.each<CardSessionState | undefined>([undefined, "running"])(
    "keeps a session alert when the %s badge does not repeat it",
    (state) => {
      const alert: CardAlert = {
        kind: "session",
        title: "failed",
        severity: "warning",
        timestamp: 100,
        repeatsSessionState: "failed",
      };
      expect(visibleCardAlerts([alert], state)).toEqual([alert]);
    },
  );

  it("preserves a real failure reason even when its text equals the state label", () => {
    const alerts = getCardAlerts(
      diagnosticCard(
        {
          workerProtocol: { state: "violated", detail: "failed", updatedAt: 100 },
        },
        "critical",
      ),
      { state: "failed", session: null },
      { parents: [], blockedParents: [] },
      100,
    );
    const visible = visibleCardAlerts(alerts, "failed");
    expect(visible.map((alert) => alert.title)).toEqual(["Release verification missing", "failed"]);
    expect(selectCardAlert(visible)?.severity).toBe("critical");
  });

  it("moves the repeated stale age to session presentation without hiding independent diagnostics", () => {
    const alerts = getCardAlerts(
      diagnosticCard({
        stale: { detectedAt: 5_700_000, lastSessionUpdatedAt: 0, reason: "No recent activity" },
      }),
      {
        state: "stale",
        session: { key: "agent:main:review", kind: "direct", updatedAt: 0 },
      },
      { parents: [], blockedParents: [] },
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
});
