import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  formatValidationErrors,
  validateCronAddParams as isAdd,
  validateCronGetParams as get,
  validateCronListParams as list,
  validateCronRemoveParams as remove,
  validateCronRunParams as run,
  validateCronRunsParams as runs,
  validateCronUpdateParams as isUpdate,
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
const checkAdd = (overrides: Record<string, unknown>) => expect(isAdd(add(overrides)));
const checkUpdate = (patch: Record<string, unknown>) => expect(isUpdate(update(patch)));
const cleared = (...fields: string[]) => Object.fromEntries(fields.map((field) => [field, null]));
const addAndUpdate = (fields: Record<string, unknown>) =>
  [
    [isAdd, add(fields)],
    [isUpdate, update(fields)],
  ] as const;
describe("cron protocol validators", () => {
  it.each([
    ["schedule", "at", "at", "2030-01-01T00:00:00Z", undefined, "'at'"],
    ["schedule", "every", "everyMs", 1000, "soon", "integer"],
    ["schedule", "cron", "expr", "0 * * * *", undefined, "'expr'"],
    ["schedule", "on-exit", "command", "true", [], "string"],
    ["schedule", "stream", "command", ["tail", "/tmp/log"], [], "items"],
    ["payload", "systemEvent", "text", "tick", 1, "string"],
    ["payload", "agentTurn", "message", "report", 1, "string"],
    ["payload", "command", "argv", ["true"], [], "items"],
    ["payload", "script", "script", "return 1", 1, "string"],
  ] as const)(
    "preserves %s acceptance and diagnoses its selected kind",
    (field, kind, key, value, badValue, message) => {
      const valid = { kind, [key]: value };
      const invalid = badValue === undefined ? { kind } : { kind, [key]: badValue };
      expect(isAdd(add({ [field]: valid }))).toBe(true);
      expect(isUpdate(update({ [field]: valid }))).toBe(true);
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

  it("accepts create results with a dry-run delivery preview", () => {
    const job = jobWithState();
    const deliveryPreview = {
      label: "announce -> last",
      detail: "last -> no route, will fail-closed",
    };
    for (const result of [
      job,
      { ...job, deliveryPreview },
      { created: true, job, deliveryPreview },
    ]) {
      expect(Value.Check(CronAddResultSchema, result)).toBe(true);
    }
    expect(
      Value.Check(CronAddResultSchema, { ...job, deliveryPreview: { label: "announce" } }),
    ).toBe(false);
  });

  it("reports auto-disable state without accepting it in writable patches", () => {
    const autoDisabled = {
      reason: "consecutive-failures",
      atMs: MAX_DATE_TIMESTAMP_MS,
      consecutiveErrors: 10,
    };
    const state = { consecutiveErrors: 10, autoDisabled };
    const job = { ...jobWithState(state), enabled: false };
    expect(Value.Check(CronJobSchema, job)).toBe(true);
    expect(
      Value.Check(CronJobSchema, {
        ...job,
        state: { ...state, autoDisabled: { ...autoDisabled, atMs: MAX_DATE_TIMESTAMP_MS + 1 } },
      }),
    ).toBe(false);
    checkUpdate({ state }).toBe(false);
  });

  it.each(["streamSourceIdentity", "sourceIdentity"])(
    "reports %s but rejects writable state",
    (field) => {
      const state = { [field]: "owner-generation" };
      expect(Value.Check(CronJobSchema, jobWithState(state))).toBe(true);
      checkUpdate({ state }).toBe(false);
    },
  );

  const failureAlert = cleared(
    "after",
    "channel",
    "to",
    "cooldownMs",
    "includeSkipped",
    "mode",
    "accountId",
  );
  const completionDestination = { mode: "webhook", to: "https://example.invalid/complete" };
  const agentPayload = { kind: "agentTurn", message: "tick" };
  const scheduledToolPolicy = { version: 1, mode: "trusted" };
  it.each([
    [{}, true],
    [{ scheduledToolPolicy }, false],
    [{ failureAlert }, false],
    [{ failureAlert: null }, false],
    [{ sessionTarget: "current", payload: agentPayload }, true],
    [{ sessionTarget: "session:project-alpha", payload: agentPayload }, true],
    [
      {
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
      },
      true,
    ],
    [{ payload: { ...agentPayload, model: null } }, false],
    [{ delivery: { mode: "announce", channel: "telegram", to: "-100123", threadId: 42 } }, true],
    [{ delivery: { mode: "announce", completionDestination } }, true],
    [{ delivery: { mode: "none", completionDestination } }, false],
    [
      { delivery: { mode: "webhook", to: "https://example.invalid", completionDestination } },
      false,
    ],
    [{ delivery: { mode: "announce", completionDestination: null } }, false],
    [{ delivery: { mode: "announce", channel: "telegram", to: "   " } }, false],
  ] as const)("add %j accepted=%s", (fields, accepted) => {
    checkAdd(fields).toBe(accepted);
  });

  it.each([
    [update({ enabled: false }), true],
    [{ jobId: "job-2", patch: { enabled: true } }, true],
    [update({ enabled: false }, { expectedConfigRevision: "sha256:current" }), true],
    ...["", 1, "x".repeat(129)].map(
      (expectedConfigRevision) =>
        [update({ enabled: false }, { expectedConfigRevision }), false] as const,
    ),
  ] as const)("update %j accepted=%s", (params, accepted) => {
    expect(isUpdate(params)).toBe(accepted);
  });
  it.each([
    [{ scheduledToolPolicy }, false],
    [{ failureAlert }, true],
    [{ failureAlert: null }, true],
    [{ sessionTarget: "session:project-alpha" }, true],
    [{ payload: { kind: "command", argv: ["sh", "-lc", "echo updated"] } }, true],
    [{ payload: { kind: "agentTurn", model: null } }, true],
    [
      { delivery: { mode: "announce", channel: "telegram", to: "-100123", threadId: "topic-42" } },
      true,
    ],
    [{ delivery: { threadId: 42 } }, true],
    [{ delivery: { completionDestination } }, true],
    [{ delivery: { completionDestination: null } }, true],
    [{ delivery: { completionDestination: {} } }, false],
    [{ delivery: { completionDestination: { mode: "announce", to: "https://x.test" } } }, false],
    [{ delivery: cleared("channel", "to", "threadId", "accountId", "failureDestination") }, true],
    [{ delivery: { failureDestination: cleared("channel", "to", "accountId", "mode") } }, true],
    [{ delivery: { channel: "\t" } }, false],
    [{ delivery: { failureDestination: { channel: null, to: " " } } }, false],
    [{ failureAlert: { channel: "last", to: "\n\t" } }, false],
  ] as const)("patch %j accepted=%s", (patch, accepted) => {
    checkUpdate(patch).toBe(accepted);
  });

  it("requires scheduling fields on add", () => {
    const { wakeMode: _wakeMode, ...withoutWakeMode } = minimalAddParams;
    expect(isAdd(withoutWakeMode)).toBe(false);
  });

  it.each([
    ["list", list, {}],
    ["get", get, { id: "job-1" }],
    ["add", isAdd, add()],
    ["update", isUpdate, update({ enabled: false })],
    ["remove", remove, { jobId: "job-1" }],
    ["run", run, { id: "job-1" }],
    ["runs", runs, { id: "job-1" }],
  ] as const)("rejects caller scope on %s", (_, validate, params) => {
    expect(validate({ ...params, callerScope: agentToolCallerScope })).toBe(false);
  });

  it.each([
    ["get", get, { id: "job-1" }, true],
    ["get legacy id", get, { jobId: "job-2" }, true],
    ["get missing id", get, {}, false],
    ["get empty id", get, { id: "" }, false],
    ["remove", remove, { id: "job-1" }, true],
    ["remove revision", remove, { jobId: "job-2", expectedConfigRevision: "sha256:current" }, true],
    ["remove empty revision", remove, { id: "job-1", expectedConfigRevision: "" }, false],
    ["remove numeric revision", remove, { id: "job-1", expectedConfigRevision: 1 }, false],
    ["force", run, { id: "job-1", mode: "force", expectedProcessInstanceId: "process-1" }, true],
    ["due", run, { jobId: "job-2", mode: "due" }, true],
    ["if enabled", run, { jobId: "job-3", mode: "if-enabled" }, true],
    ["empty process", run, { id: "job-1", expectedProcessInstanceId: "" }, false],
    ["runs id", runs, { id: "job-1", limit: 1 }, true],
    ["runs legacy id", runs, { jobId: "job-2", limit: 1 }, true],
    ["runs zero", runs, { id: "job-1", limit: 0 }, false],
    ["runs legacy zero", runs, { jobId: "job-2", limit: 0 }, false],
    ...[
      { id: "../job-1" },
      { id: "nested/job-1" },
      { jobId: "..\\job-2" },
      { jobId: "nested\\job-2" },
    ].map((params) => ["runs path traversal", runs, params, false] as const),
  ] as const)("validates %s row %#", (_, validate, params, accepted) => {
    expect(validate(params)).toBe(accepted);
  });

  it("accepts list paging/filter/sort params", () => {
    expect(
      list({
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
      }),
    ).toBe(true);
  });
  it.each([
    { offset: -1 },
    { agentId: "" },
    { scheduleKind: "yearly" },
    { lastRunStatus: "pending" },
    { trigger: "configured" },
  ])("rejects invalid list filter %j", (params) => {
    expect(list(params)).toBe(false);
  });
});
