import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  formatValidationErrors,
  validateCronAddParams as validateAdd,
  validateCronGetParams as validateGet,
  validateCronListParams as validateList,
  validateCronRemoveParams as validateRemove,
  validateCronRunParams as validateRun,
  validateCronRunsParams as validateRuns,
  validateCronUpdateParams as validateUpdate,
} from "./index.js";
import { CronAddResultSchema, CronJobSchema } from "./schema/cron.js";

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
const jobWithState = (state: unknown = {}) => ({
  ...minimalAddParams,
  id: "job-1",
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 2,
  state,
});
const checkAdd = (overrides: Record<string, unknown>) => expect(validateAdd(add(overrides)));
const checkUpdate = (patch: Record<string, unknown>) => expect(validateUpdate(update(patch)));
const cleared = (...fields: string[]) => Object.fromEntries(fields.map((field) => [field, null]));
const addAndUpdate = (fields: Record<string, unknown>) =>
  [
    [validateAdd, add(fields)],
    [validateUpdate, update(fields)],
  ] as const;
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
  it.each([
    ["schedule", { kind: "at", at: "2030-01-01T00:00:00Z" }, { kind: "at" }, "'at'"],
    ["schedule", { kind: "every", everyMs: 1000 }, { kind: "every", everyMs: "soon" }, "integer"],
    ["schedule", { kind: "cron", expr: "0 * * * *" }, { kind: "cron" }, "'expr'"],
    ["schedule", { kind: "on-exit", command: "true" }, { kind: "on-exit", command: [] }, "string"],
    [
      "schedule",
      { kind: "stream", command: ["tail", "/workspace/application.log"] },
      { kind: "stream", command: [] },
      "items",
    ],
    ["payload", { kind: "systemEvent", text: "tick" }, { kind: "systemEvent", text: 1 }, "string"],
    [
      "payload",
      { kind: "agentTurn", message: "report" },
      { kind: "agentTurn", message: 1 },
      "string",
    ],
    ["payload", { kind: "command", argv: ["true"] }, { kind: "command", argv: [] }, "items"],
    ["payload", { kind: "script", script: "return 1" }, { kind: "script", script: 1 }, "string"],
  ] as const)(
    "preserves %s acceptance and diagnoses its selected kind",
    (field, valid, invalid, message) => {
      expect(validateAdd(add({ [field]: valid }))).toBe(true);
      expect(validateUpdate(update({ [field]: valid }))).toBe(true);
      for (const [validate, input] of addAndUpdate({ [field]: invalid })) {
        expect(validate(input)).toBe(false);
        expect(formatValidationErrors(validate.errors)).toContain(message);
        expect(validate.errors?.length).toBeLessThanOrEqual(8);
      }
    },
  );

  it.each([
    ["schedule", {}, ["stream", "every"]],
    ["schedule", { kind: "not-a-schedule" }, ["stream", "every"]],
    ["payload", {}, ["systemEvent", "agentTurn"]],
    ["payload", { kind: "not-a-payload" }, ["systemEvent", "agentTurn"]],
  ] as const)("reports allowed %s kinds for %j", (field, value, allowed) => {
    for (const [validate, input] of addAndUpdate({ [field]: value })) {
      expect(validate(input)).toBe(false);
      const message = formatValidationErrors(validate.errors);
      expect(message).toContain(`/${field}/kind`);
      for (const kind of allowed) {
        expect(message).toContain(kind);
      }
      expect(message).not.toContain("required property 'at'");
    }
  });

  it("accepts minimal add params", () => {
    checkAdd({}).toBe(true);
  });

  it("accepts create results with a dry-run delivery preview", () => {
    const job = jobWithState();
    const deliveryPreview = {
      label: "announce -> last",
      detail: "last -> no route, will fail-closed",
    };
    expect(Value.Check(CronAddResultSchema, job)).toBe(true);
    expect(Value.Check(CronAddResultSchema, { ...job, deliveryPreview })).toBe(true);
    expect(Value.Check(CronAddResultSchema, { created: true, job, deliveryPreview })).toBe(true);
    expect(
      Value.Check(CronAddResultSchema, { ...job, deliveryPreview: { label: "announce" } }),
    ).toBe(false);
  });

  it("reports auto-disable state without accepting it in writable patches", () => {
    const state = {
      consecutiveErrors: 10,
      autoDisabled: {
        reason: "consecutive-failures",
        atMs: MAX_DATE_TIMESTAMP_MS,
        consecutiveErrors: 10,
      },
    };
    const job = { ...jobWithState(state), enabled: false };
    expect(Value.Check(CronJobSchema, job)).toBe(true);
    const invalidState = {
      ...state,
      autoDisabled: { ...state.autoDisabled, atMs: MAX_DATE_TIMESTAMP_MS + 1 },
    };
    expect(Value.Check(CronJobSchema, { ...job, state: invalidState })).toBe(false);
    checkUpdate({ state }).toBe(false);
  });

  it.each(["streamSourceIdentity", "sourceIdentity"])(
    "reports %s without accepting it in writable patches",
    (field) => {
      const state = { [field]: "owner-generation" };
      expect(Value.Check(CronJobSchema, jobWithState(state))).toBe(true);
      checkUpdate({ state }).toBe(false);
    },
  );

  it("rejects client-authored scheduled authority provenance", () => {
    const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
    checkAdd({ scheduledToolPolicy }).toBe(false);
    checkUpdate({ scheduledToolPolicy }).toBe(false);
  });

  it("accepts failure alert field clears only in update patches", () => {
    const failureAlert = cleared(
      "after",
      "channel",
      "to",
      "cooldownMs",
      "includeSkipped",
      "mode",
      "accountId",
    );
    checkUpdate({ failureAlert }).toBe(true);
    checkAdd({ failureAlert }).toBe(false);
    checkUpdate({ failureAlert: null }).toBe(true);
    checkAdd({ failureAlert: null }).toBe(false);
  });

  it("rejects public caller scope on cron admin params", () => {
    expectCases(validateList, false, [{ callerScope: agentToolCallerScope }]);
    expectCases(validateGet, false, [{ id: "job-1", callerScope: agentToolCallerScope }]);
    expectCases(validateAdd, false, [add({ callerScope: agentToolCallerScope })]);
    expectCases(validateUpdate, false, [
      update({ enabled: false }, { callerScope: agentToolCallerScope }),
    ]);
    expectCases(validateRemove, false, [{ jobId: "job-1", callerScope: agentToolCallerScope }]);
    expectCases(validateRun, false, [{ id: "job-1", callerScope: agentToolCallerScope }]);
    expectCases(validateRuns, false, [{ id: "job-1", callerScope: agentToolCallerScope }]);
  });

  it("accepts current and custom session targets", () => {
    const payload = { kind: "agentTurn", message: "tick" };
    expectCases(validateAdd, true, [
      add({ sessionTarget: "current", payload }),
      add({ sessionTarget: "session:project-alpha", payload }),
    ]);
    checkUpdate({ sessionTarget: "session:project-alpha" }).toBe(true);
  });

  it("accepts command cron payloads", () => {
    checkAdd({
      sessionTarget: "isolated",
      payload: {
        kind: "command",
        argv: ["sh", "-lc", "echo ok"],
        cwd: "/srv/example",
        env: { FOO: "bar" },
        input: "stdin",
        timeoutSeconds: 30,
        noOutputTimeoutSeconds: 5,
        outputMaxBytes: 4096,
      },
    }).toBe(true);
    checkUpdate({ payload: { kind: "command", argv: ["sh", "-lc", "echo updated"] } }).toBe(true);
  });

  it("rejects add params when required scheduling fields are missing", () => {
    const { wakeMode: _wakeMode, ...withoutWakeMode } = minimalAddParams;
    expect(validateAdd(withoutWakeMode)).toBe(false);
  });

  it("accepts update params for id and jobId selectors", () => {
    expectCases(validateUpdate, true, [
      update({ enabled: false }),
      { jobId: "job-2", patch: { enabled: true } },
    ]);
  });

  it("accepts only non-empty cron config revisions", () => {
    const patch = { enabled: false };
    expectCases(validateUpdate, true, [
      update(patch, { expectedConfigRevision: "sha256:current" }),
    ]);
    for (const expectedConfigRevision of ["", 1, "x".repeat(129)]) {
      expect(validateUpdate(update(patch, { expectedConfigRevision }))).toBe(false);
    }
  });

  it("accepts nullable model clears only on update payload patches", () => {
    checkUpdate({ payload: { kind: "agentTurn", model: null } }).toBe(true);
    checkAdd({ payload: { kind: "agentTurn", message: "tick", model: null } }).toBe(false);
  });

  it("accepts get params for id and jobId selectors", () => {
    expectCases(validateGet, true, [{ id: "job-1" }, { jobId: "job-2" }]);
    expectCases(validateGet, false, [{}, { id: "" }]);
  });

  it("accepts delivery threadId on add and update params", () => {
    checkAdd({
      delivery: { mode: "announce", channel: "telegram", to: "-100123", threadId: 42 },
    }).toBe(true);
    expectCases(validateUpdate, true, [
      update({
        delivery: { mode: "announce", channel: "telegram", to: "-100123", threadId: "topic-42" },
      }),
      update({ delivery: { threadId: 42 } }),
    ]);
  });

  it("accepts completion webhooks only alongside announce delivery", () => {
    const completionDestination = {
      mode: "webhook",
      to: "https://example.invalid/complete",
    } as const;
    checkAdd({ delivery: { mode: "announce", completionDestination } }).toBe(true);
    expectCases(validateAdd, false, [
      add({ delivery: { mode: "none", completionDestination } }),
      add({ delivery: { mode: "webhook", to: "https://example.invalid", completionDestination } }),
      add({ delivery: { mode: "announce", completionDestination: null } }),
    ]);
    expectCases(validateUpdate, true, [
      update({ delivery: { completionDestination } }),
      update({ delivery: { completionDestination: null } }),
    ]);
    expectCases(validateUpdate, false, [
      update({ delivery: { completionDestination: {} } }),
      update({ delivery: { completionDestination: { mode: "announce", to: "https://x.test" } } }),
    ]);
  });

  it("accepts nullable delivery clears on update params", () => {
    expectCases(validateUpdate, true, [
      update({ delivery: cleared("channel", "to", "threadId", "accountId", "failureDestination") }),
      update({ delivery: { failureDestination: cleared("channel", "to", "accountId", "mode") } }),
    ]);
  });

  it("rejects blank cron delivery target strings", () => {
    checkAdd({ delivery: { mode: "announce", channel: "telegram", to: "   " } }).toBe(false);
    expectCases(validateUpdate, false, [
      update({ delivery: { channel: "\t" } }),
      update({ delivery: { failureDestination: { channel: null, to: " " } } }),
      update({ failureAlert: { channel: "last", to: "\n\t" } }),
    ]);
  });

  it("accepts remove params for id and jobId selectors", () => {
    expectCases(validateRemove, true, [
      { id: "job-1" },
      { jobId: "job-2", expectedConfigRevision: "sha256:current" },
    ]);
    expectCases(validateRemove, false, [
      { id: "job-1", expectedConfigRevision: "" },
      { id: "job-1", expectedConfigRevision: 1 },
    ]);
  });

  it("accepts run params mode for id and jobId selectors", () => {
    expectCases(validateRun, true, [
      { id: "job-1", mode: "force", expectedProcessInstanceId: "process-1" },
      { jobId: "job-2", mode: "due" },
      { jobId: "job-3", mode: "if-enabled" },
    ]);
    expectCases(validateRun, false, [{ id: "job-1", expectedProcessInstanceId: "" }]);
  });

  it("accepts list paging/filter/sort params", () => {
    expectCases(validateList, true, [
      {
        includeDisabled: true,
        limit: 50,
        offset: 0,
        query: "daily",
        enabled: "all",
        scheduleKind: "cron",
        lastRunStatus: "unknown",
        trigger: "conditional",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
        agentId: "ops",
        compact: true,
        includeDeliveryPreviews: false,
      },
    ]);
    expectCases(validateList, false, [
      { offset: -1 },
      { agentId: "" },
      { scheduleKind: "yearly" },
      { lastRunStatus: "pending" },
      { trigger: "configured" },
    ]);
  });

  it("enforces runs limit minimum for id and jobId selectors", () => {
    expectCases(validateRuns, true, [
      { id: "job-1", limit: 1 },
      { jobId: "job-2", limit: 1 },
    ]);
    expectCases(validateRuns, false, [
      { id: "job-1", limit: 0 },
      { jobId: "job-2", limit: 0 },
    ]);
  });

  it("rejects cron.runs path traversal ids", () => {
    expectCases(validateRuns, false, [
      { id: "../job-1" },
      { id: "nested/job-1" },
      { jobId: "..\\job-2" },
      { jobId: "nested\\job-2" },
    ]);
  });
});
