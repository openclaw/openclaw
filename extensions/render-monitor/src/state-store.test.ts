import { describe, expect, it } from "vitest";
import {
  computeIncidentFingerprint,
  shouldDedupeIncident,
  ackIncident,
  upsertIncident,
} from "./state-store.js";
import type { RenderMonitorState, StoredRenderIncident } from "./types.js";

function createEmptyState(): RenderMonitorState {
  return {
    version: 1,
    updatedAtMs: Date.now(),
    incidentsById: {},
    incidentIdByFingerprint: {},
    serviceErrorStreakByServiceId: {},
  };
}

describe("render-monitor state-store", () => {
  it("dedupes the same incident within TTL", () => {
    const state = createEmptyState();
    const { fingerprint, incidentId } = computeIncidentFingerprint({
      serviceId: "srv-1",
      incidentType: "service_error",
      deployId: null,
      healthState: "failing",
      extra: { serviceStatus: "error" },
    });

    const nowMs = Date.now();
    const incident: StoredRenderIncident = {
      id: incidentId,
      fingerprint,
      serviceId: "srv-1",
      incidentType: "service_error",
      createdAtMs: nowMs,
      lastDetectedAtMs: nowMs,
      acknowledgedAtMs: null,
      lastAlertedAtMs: nowMs,
      lastInvestigation: null,
      summary: "test",
      details: {},
    };

    const next = upsertIncident({ state, incident });

    expect(
      shouldDedupeIncident({
        state: next,
        incident: { incidentId, fingerprint, createdAtMs: nowMs },
        nowMs: nowMs + 30_000,
        dedupeTtlMinutes: 1,
      }),
    ).toBe(true);
  });

  it("ackIncident marks acknowledgedAtMs", () => {
    const state = createEmptyState();
    const { fingerprint, incidentId } = computeIncidentFingerprint({
      serviceId: "srv-1",
      incidentType: "service_error",
      deployId: null,
      healthState: null,
      extra: {},
    });

    const nowMs = Date.now();
    const incident: StoredRenderIncident = {
      id: incidentId,
      fingerprint,
      serviceId: "srv-1",
      incidentType: "service_error",
      createdAtMs: nowMs,
      lastDetectedAtMs: nowMs,
      acknowledgedAtMs: null,
      lastAlertedAtMs: null,
      lastInvestigation: null,
      summary: "test",
      details: {},
    };

    const next = upsertIncident({ state, incident });
    const res = ackIncident({ state: next, incidentId });

    expect(res.changed).toBe(true);
    expect(res.state.incidentsById[incidentId].acknowledgedAtMs).toBeTypeOf("number");
  });
});

