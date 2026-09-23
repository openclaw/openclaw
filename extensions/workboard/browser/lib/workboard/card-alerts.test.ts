import { describe, expect, it } from "vitest";
import {
  getCardAlerts,
  selectCardAlert,
  visibleCardAlerts,
  type CardAlert,
} from "./card-alerts.ts";
import { getCardSessionState, type CardSessionState } from "./session-state.ts";
import type { WorkboardCard, WorkboardLifecycle, WorkboardTaskSummary } from "./types.ts";

const card: WorkboardCard = {
  id: "review",
  title: "Release review",
  status: "blocked",
  priority: "normal",
  labels: [],
  position: 0,
  createdAt: 0,
  updatedAt: 100,
};

const lifecycle: WorkboardLifecycle = { state: "failed", session: null };

function task(status: WorkboardTaskSummary["status"]): WorkboardTaskSummary {
  return { id: "task", taskId: "task", status };
}

describe("card session state", () => {
  it("retains authoritative task outcomes over a different session terminal state", () => {
    const timedOutSession: WorkboardLifecycle = {
      state: "failed",
      session: { key: "agent:main:review", kind: "direct", updatedAt: 100, status: "timeout" },
    };
    expect(getCardSessionState(timedOutSession, task("failed"))).toBe("failed");
    expect(getCardSessionState(timedOutSession, task("cancelled"))).toBe("cancelled");
    expect(getCardSessionState(timedOutSession, task("running"))).toBe("timed_out");
    expect(getCardSessionState({ state: "running", session: null }, task("queued"))).toBe("queued");
    expect(getCardSessionState({ state: "succeeded", session: null }, task("completed"))).toBe(
      "succeeded",
    );
  });
});

describe("visible card alerts", () => {
  it.each<CardSessionState>([
    "unlinked",
    "unknown",
    "unavailable",
    "ambiguous",
    "idle",
    "queued",
    "running",
    "stale",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "stopped",
  ])("hides only the explicitly repeated %s state", (state) => {
    const repeated: CardAlert = {
      kind: "session",
      title: state,
      severity: "warning",
      timestamp: 100,
      repeatsSessionState: state,
    };
    const kinds: CardAlert["kind"][] = ["diagnostic", "blocked", "dependency"];
    const independent = kinds.map((kind) =>
      Object.assign({}, repeated, { kind, repeatsSessionState: undefined }),
    );
    const visibleBadgeState = state === "unlinked" || state === "idle" ? undefined : state;
    expect(visibleCardAlerts([repeated, ...independent], visibleBadgeState)).toEqual(
      visibleBadgeState === undefined ? [repeated, ...independent] : independent,
    );
    const differentState = state === "running" ? "stale" : "running";
    expect(visibleCardAlerts([repeated], differentState)).toEqual([repeated]);
  });

  it("preserves a real failure reason even when its text equals the state label", () => {
    const alerts = getCardAlerts(
      {
        ...card,
        metadata: {
          workerProtocol: { state: "violated", detail: "failed", updatedAt: 100 },
          diagnostics: [
            {
              kind: "missing_proof",
              severity: "critical",
              title: "Release verification missing",
              detail: "Attach verification evidence",
              firstSeenAt: 1,
              lastSeenAt: 1,
              count: 1,
              actions: [],
            },
          ],
        },
      },
      lifecycle,
      { parents: [], blockedParents: [] },
      100,
    );
    const visible = visibleCardAlerts(alerts, "failed");
    expect(visible.map((alert) => alert.title)).toEqual(["Release verification missing", "failed"]);
    expect(selectCardAlert(visible)?.severity).toBe("critical");
  });

  it("moves the repeated stale age to session presentation without hiding independent diagnostics", () => {
    const staleLifecycle: WorkboardLifecycle = {
      state: "stale",
      session: {
        key: "agent:main:review",
        kind: "direct",
        status: "running",
        hasActiveRun: false,
        updatedAt: 0,
      },
    };
    const alerts = getCardAlerts(
      {
        ...card,
        metadata: {
          stale: { detectedAt: 5_700_000, lastSessionUpdatedAt: 0, reason: "No recent activity" },
          diagnostics: [
            {
              kind: "missing_proof",
              severity: "warning",
              title: "Release verification missing",
              detail: "Attach verification evidence",
              firstSeenAt: 1,
              lastSeenAt: 1,
              count: 1,
              actions: [],
            },
          ],
        },
      },
      staleLifecycle,
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
