import { expect, it } from "vitest";
import { UpdateRunRecordSchema as LedgerRecordSchema } from "../../../src/infra/update-run-schema.js";
import {
  validateUpdateRunChangedEvent,
  validateUpdateRunRecord,
  validateUpdateRunResult,
  validateUpdateRunsGetResult,
  validateUpdateRunsListResult,
  validateUpdateStatusResult,
} from "./index.js";
import { UPDATE_RUN_DRIVER_LIMIT } from "./update-run-vocabulary.js";

const driver = { host: "gateway.test", pid: 1234, startIdentity: "98765" };
const run = {
  runId: "27d967ef-0485-4f98-a93a-229d50c75111",
  createdAtMs: 100,
  updatedAtMs: 300,
  trigger: "campaign",
  phase: "finished",
  status: "succeeded",
  reason: null,
  origin: { driver, previousDrivers: [driver] },
  target: {},
  before: {},
  after: {},
  steps: [{ step: "doctor", status: "completed" }],
  verification: {},
  repair: [{ attempt: 1, status: "succeeded", startedAtMs: 150 }],
  confirmedAtMs: 290,
  finishedAtMs: 300,
  downtimeMs: 25,
};
const checks = [{ name: "config", status: "warn", detail: "Missing custom path." }];
const admission = { owner: "candidate", protocol: 1, candidateVersion: "2026.9.5", checks };
const candidateAdmission = {
  protocol: 1,
  verdict: "admit",
  reasons: [],
  warnings: [{ code: "missing-load-path", message: "Missing custom path." }],
  facts: {
    candidateVersion: "2026.9.5",
    installedVersion: "2026.9.4",
    nodeEngines: ">=24.16.0",
    checks,
  },
};
const installedAdmission = {
  owner: "installed",
  fallbackReason: "update-admission-unsupported-target",
};
const destination = {
  ownership: "foreign",
  cause: "package-mismatch",
  destinationKind: "npm-global",
  prefix: "/other-prefix",
  packageRoot: "/other-prefix/lib/node_modules/openclaw",
  runningRoot: "~/.npm-global/lib/node_modules/openclaw",
  runningPrefix: "~/.npm-global",
  launcher: "/other-prefix/bin/openclaw",
  launcherTarget: null,
};
const fact = {
  check: "readyz",
  code: "readyz-unhealthy",
  message: "Readiness returned HTTP 503.",
  errorName: "Error",
  location: "src/infra/update-runner-git.ts:42:7",
};
const step = (fields: object) => ({ steps: [{ ...run.steps[0], ...fields }] });
const failure = (fields: object) =>
  step({ status: "failed", failureFacts: [{ ...fact, ...fields }] });
const snapshot = {
  sqliteBytes: 1024,
  pluginBytes: 2048,
  requiredBytes: 8192,
  candidates: [{ kind: "system-tmpdir", directory: "/synthetic/tmp", availableBytes: null }],
};

it("carries canonical admission, recovery, and step evidence through all wire projections", () => {
  const variants: object[] = [
    {},
    { admission, origin: { ...run.origin, admission, candidateAdmission } },
    { admission: installedAdmission, origin: { ...run.origin, admission: installedAdmission } },
    ...[23, 0, null].map((exitCode) => step({ exitCode })),
    step({
      failureFacts: [
        { check: "npm", code: "ETARGET", npmErrorCode: "ETARGET", packageSpec: "file-type@22.1.1" },
      ],
    }),
    step({ configChange: { kind: "key", key: "meta" } }),
    step({ configChange: { kind: "migration", message: "Enabled the configured provider." } }),
    step({
      configWriteRefusal: {
        reason: "config-input-changed",
        message: "Config changed before promotion.",
        keys: ["meta", "plugins", "wizard"],
      },
    }),
    step({
      snapshotCapacity: {
        ...snapshot,
        reason: "snapshot-location-unavailable",
        selection: null,
        candidates: [
          {
            kind: "explicit-tmpdir",
            directory: "/synthetic/file",
            availableBytes: 16384,
            allocationError: "not a directory",
          },
        ],
      },
    }),
    ...[null, { kind: "state-volume", directory: "/synthetic/state.update-captures" }].map(
      (selection) =>
        step({
          snapshotCapacity: {
            ...snapshot,
            reason: selection ? selection.kind : "snapshot-capacity-insufficient",
            selection,
          },
        }),
    ),
  ];
  for (const destinationFacts of [undefined, destination]) {
    variants.push({
      ...failure(
        destinationFacts
          ? {
              check: "package-install",
              code: "global-install-foreign-destination",
              destination: destinationFacts,
            }
          : {},
      ),
      target: { installationMethod: "git-checkout" },
      verification: {
        rollbackOutcome: { status: "succeeded", reason: "Previous package restored" },
        recovery: { serviceRestartSafe: true, packageRollbackVerified: true, version: "2026.8.1" },
      },
    });
  }
  for (const recovery of [null, { serviceRestartSafe: false, reason: "source-rollback-failed" }]) {
    variants.push({
      target: { installationMethod: null },
      ...failure({ check: "staging", code: "Error", errorName: null, location: null }),
      verification: { rollbackOutcome: null, recovery },
    });
  }
  for (const fields of variants) {
    const input = { ...run, ...fields };
    const record = LedgerRecordSchema.parse(input);
    expect(record).toEqual(input);
    expect(validateUpdateRunRecord(record)).toBe(true);
    expect(validateUpdateRunsGetResult({ run: record })).toBe(true);
    expect(validateUpdateRunsListResult({ runs: [record] })).toBe(true);
    expect(
      validateUpdateStatusResult({ sentinel: null, updateAvailable: null, lastRun: record }),
    ).toBe(true);
  }
});

it("rejects malformed and oversized ledger evidence consistently at the wire boundary", () => {
  const variants: object[] = [
    { runId: "27d967ef-0485-0f98-a93a-229d50c75111" },
    { admission: { owner: "other" } },
    { origin: { admission: { owner: "candidate", protocol: 2 } } },
    failure({ check: "npm", code: "unknown", npmErrorCode: "private-code" }),
    step({ configChange: { kind: "other", key: "meta" } }),
    step({ configChange: { kind: "key", key: "x".repeat(1025) } }),
    step({
      configWriteRefusal: {
        reason: "config-input-changed",
        message: "Config changed before promotion.",
        keys: Array.from({ length: 33 }, () => "meta"),
      },
    }),
    { target: { installationMethod: "other" } },
    { verification: { rollbackOutcome: { status: "unknown", reason: "unknown" } } },
    { verification: { recovery: { serviceRestartSafe: false, reason: "unknown" } } },
    ...(
      [
        ["errorName", 81],
        ["location", 161],
        ["packageSpec", 201],
      ] as const
    ).map(([field, length]) => failure({ [field]: "x".repeat(length) })),
    { origin: { driver: { ...driver, host: "x".repeat(256) } } },
    { origin: { driver: { ...driver, startIdentity: "1".repeat(129) } } },
    { origin: { previousDrivers: Array.from({ length: UPDATE_RUN_DRIVER_LIMIT }, () => driver) } },
    ...[{ ownership: "private-owner" }, { prefix: "x".repeat(241) }, { extra: "private-text" }].map(
      (fields) => failure({ destination: { ...destination, ...fields } }),
    ),
    step({ failureFacts: Array.from({ length: 6 }, () => fact) }),
  ];
  for (const fields of variants) {
    const invalid = { ...run, ...fields };
    expect(LedgerRecordSchema.safeParse(invalid).success).toBe(false);
    expect(validateUpdateRunRecord(invalid)).toBe(false);
    expect(validateUpdateRunsGetResult({ run: invalid })).toBe(false);
    expect(
      validateUpdateStatusResult({ sentinel: null, updateAvailable: null, lastRun: invalid }),
    ).toBe(false);
  }
});

it("requires run identity on update acknowledgements and phase notifications", () => {
  const outcome = {
    ok: false,
    code: "owner_required",
    message: "Owner required",
    result: { status: "error", reason: "owner_required" },
  };
  expect(validateUpdateRunResult({ ...outcome, runId: run.runId })).toBe(true);
  expect(validateUpdateRunResult(outcome)).toBe(false);
  const acknowledged = {
    ...outcome,
    runId: run.runId,
    ackDelivered: true,
    ackQueued: true,
    acknowledgement: "Updating OpenClaw.",
  };
  expect(validateUpdateRunResult(acknowledged)).toBe(true);
  for (const invalid of [{ ackQueued: "true" }, { acknowledgement: false }]) {
    expect(validateUpdateRunResult({ ...acknowledged, ...invalid })).toBe(false);
  }
  const change = { runId: run.runId, phase: "verifying", status: "running", updatedAtMs: 250 };
  expect(validateUpdateRunChangedEvent(change)).toBe(true);
  for (const fields of [{ runId: "other" }, { log: "private output" }]) {
    expect(validateUpdateRunChangedEvent({ ...change, ...fields })).toBe(false);
  }
});
