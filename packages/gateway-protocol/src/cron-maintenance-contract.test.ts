import { Value } from "typebox/value";
// Protocol contract for the maintenance-window diagnostics on CronJobState.
//
// The gateway protocol exposes three read-only fields on CronJobState:
//   - deferredMaintenanceCount
//   - firstDeferredMaintenanceAtMs
//   - lastDeferredMaintenanceAtMs
//
// These fields are populated by the maintenance policy's phase-exit drain
// and read by operator tools (status, observability, dashboards). They are
// intentionally absent from the writable patch schema so external callers
// cannot spoof deferral counts.
//
// This contract test is the cross-package anchor: any change to the field
// shape, the optionality, or the read/write split is caught here. The
// companion in-source test (src/cron/maintenance-*.test.ts) covers the
// runtime population semantics; this one covers the wire shape.
import { describe, expect, it } from "vitest";
import { CronJobSchema, validateCronAddParams, validateCronUpdateParams } from "./index.js";
import { CronJobStateSchema } from "./schema/cron.js";

function baseJob() {
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hi", toolsAllow: ["read"] },
  };
}

describe("CronJobState maintenance-window fields", () => {
  it("exposes deferredMaintenanceCount, first/lastDeferredMaintenanceAtMs as optional integers", () => {
    const state = {
      nextRunAtMs: 1_000,
      deferredMaintenanceCount: 3,
      firstDeferredMaintenanceAtMs: 100,
      lastDeferredMaintenanceAtMs: 500,
    };
    expect(Value.Check(CronJobStateSchema, state)).toBe(true);
  });

  it("accepts the absence of any maintenance field (never-deferred jobs)", () => {
    const state = { nextRunAtMs: 1_000 };
    expect(Value.Check(CronJobStateSchema, state)).toBe(true);
  });

  it("accepts null first/last timestamps (deferred but no record yet)", () => {
    const state = {
      deferredMaintenanceCount: 0,
      firstDeferredMaintenanceAtMs: null,
      lastDeferredMaintenanceAtMs: null,
    };
    expect(Value.Check(CronJobStateSchema, state)).toBe(true);
  });

  it("rejects negative deferredMaintenanceCount", () => {
    const state = { deferredMaintenanceCount: -1 };
    expect(Value.Check(CronJobStateSchema, state)).toBe(false);
  });

  it("rejects negative first/lastDeferredMaintenanceAtMs", () => {
    expect(Value.Check(CronJobStateSchema, { firstDeferredMaintenanceAtMs: -1 })).toBe(false);
    expect(Value.Check(CronJobStateSchema, { lastDeferredMaintenanceAtMs: -1 })).toBe(false);
  });

  it("rejects non-integer deferredMaintenanceCount", () => {
    const state = { deferredMaintenanceCount: 1.5 };
    expect(Value.Check(CronJobStateSchema, state)).toBe(false);
  });

  it("rejects unknown additional properties on CronJobState (closed object)", () => {
    const state = { deferredMaintenanceCount: 1, smuggled: "x" };
    expect(Value.Check(CronJobStateSchema, state)).toBe(false);
  });
});

describe("maintenance fields are read-only on the wire", () => {
  it("client can read a job that includes the maintenance fields", () => {
    const job = {
      ...baseJob(),
      state: {
        deferredMaintenanceCount: 2,
        firstDeferredMaintenanceAtMs: 1_000,
        lastDeferredMaintenanceAtMs: 5_000,
      },
    };
    expect(Value.Check(CronJobSchema, job)).toBe(true);
  });

  it("cron.add rejects maintenance fields in the initial state patch", () => {
    // Operators / external tools must not be able to seed a fake deferral
    // count by including the fields in the add payload.
    const add = {
      ...baseJob(),
      state: {
        deferredMaintenanceCount: 99,
        firstDeferredMaintenanceAtMs: 1,
        lastDeferredMaintenanceAtMs: 2,
      },
    };
    expect(validateCronAddParams(add)).toBe(false);
  });

  it("cron.update rejects maintenance fields in the patch", () => {
    // Same restriction on the update path: even if the schema is permissive
    // on other fields, maintenance diagnostics must be server-owned.
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { state: { deferredMaintenanceCount: 99 } },
      }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { state: { firstDeferredMaintenanceAtMs: 1 } },
      }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { state: { lastDeferredMaintenanceAtMs: 1 } },
      }),
    ).toBe(false);
  });

  it("accepts a normal state patch that does not touch maintenance fields", () => {
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { state: { nextRunAtMs: 1_000, consecutiveErrors: 0 } },
      }),
    ).toBe(true);
  });
});
