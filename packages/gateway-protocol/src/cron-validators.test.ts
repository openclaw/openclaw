// Gateway Protocol tests cover cron validators behavior.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronGetParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronUpdateParams,
} from "./index.js";
import { CronJobSchema } from "./schema/cron.js";

/**
 * Cron validator regressions for public scheduler RPC payloads.
 *
 * The cases cover both canonical `id` selectors and legacy `jobId` aliases,
 * delivery routing, update clears, and run-log path traversal guards.
 */
const minimalAddParams = {
  name: "daily-summary",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "tick" },
} as const;
const add = (overrides: Record<string, unknown> = {}) => ({ ...minimalAddParams, ...overrides });
const update = (patch: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  patch,
  ...overrides,
});
const agentToolCallerScope = { kind: "agentTool", agentId: "ops" } as const;
function expectCases(
  validate: (value: unknown) => boolean,
  expected: boolean,
  values: readonly unknown[],
) {
  for (const value of values) {
    expect(validate(value)).toBe(expected);
  }
}

describe("cron protocol validators", () => {
  it("reports auto-disable state without accepting it in writable patches", () => {
    const job = {
      ...minimalAddParams,
      id: "job-1",
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 2,
      state: {
        consecutiveErrors: 10,
        autoDisabled: {
          reason: "consecutive-failures",
          atMs: MAX_DATE_TIMESTAMP_MS,
          consecutiveErrors: 10,
        },
      },
    };
    expect(Value.Check(CronJobSchema, job)).toBe(true);
    expect(
      Value.Check(CronJobSchema, {
        ...job,
        state: {
          ...job.state,
          autoDisabled: { ...job.state.autoDisabled, atMs: MAX_DATE_TIMESTAMP_MS + 1 },
        },
      }),
    ).toBe(false);
    expect(validateCronUpdateParams(update({ state: job.state }))).toBe(false);
  });

  it("rejects client-authored scheduled authority provenance", () => {
    const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
    expectCases(validateCronAddParams, false, [add({ scheduledToolPolicy })]);
    expectCases(validateCronUpdateParams, false, [update({ scheduledToolPolicy })]);
  });

  it("accepts failure alert field clears only in update patches", () => {
    const failureAlert = {
      after: null,
      channel: null,
      to: null,
      cooldownMs: null,
      includeSkipped: null,
      mode: null,
      accountId: null,
    };
    expectCases(validateCronUpdateParams, true, [update({ failureAlert })]);
    expectCases(validateCronAddParams, false, [add({ failureAlert })]);
    expectCases(validateCronUpdateParams, true, [update({ failureAlert: null })]);
    expectCases(validateCronAddParams, false, [add({ failureAlert: null })]);
  });

  it("rejects public caller scope on cron admin params", () => {
    expectCases(validateCronListParams, false, [{ callerScope: agentToolCallerScope }]);
    expectCases(validateCronGetParams, false, [{ id: "job-1", callerScope: agentToolCallerScope }]);
    expectCases(validateCronAddParams, false, [add({ callerScope: agentToolCallerScope })]);
    expectCases(validateCronUpdateParams, false, [
      update({ enabled: false }, { callerScope: agentToolCallerScope }),
    ]);
    expectCases(validateCronRemoveParams, false, [
      {
        jobId: "job-1",
        callerScope: agentToolCallerScope,
      },
    ]);
    expectCases(validateCronRunParams, false, [{ id: "job-1", callerScope: agentToolCallerScope }]);
    expectCases(validateCronRunsParams, false, [
      { id: "job-1", callerScope: agentToolCallerScope },
    ]);
  });

  it("rejects cron.runs path traversal ids", () => {
    expectCases(validateCronRunsParams, false, [
      { id: "../job-1" },
      { id: "nested/job-1" },
      { jobId: "..\\job-2" },
      { jobId: "nested\\job-2" },
    ]);
  });
});
