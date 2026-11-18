import { describe, expect, it } from "vitest";
import { toPublicUpdateRun } from "../../../src/infra/update-run-record.js";
import { createUpdateRunRecordFixture } from "../../../src/infra/update-run-record.test-support.js";
import { UpdateRunRecordSchema as LedgerRecordSchema } from "../../../src/infra/update-run-schema.js";
import {
  validateUpdateRunRecord,
  validateUpdateRunsGetResult,
  validateUpdateRunsListResult,
  validateUpdateStatusResult,
} from "./index.js";

const run = LedgerRecordSchema.parse(
  createUpdateRunRecordFixture("27d967ef-0485-4f98-a93a-229d50c75111", {}),
);

function expectWireRecord(record: unknown) {
  expect(validateUpdateRunRecord(record)).toBe(true);
  expect(validateUpdateRunsGetResult({ run: record })).toBe(true);
  expect(validateUpdateRunsListResult({ runs: [record] })).toBe(true);
  expect(
    validateUpdateStatusResult({ sentinel: null, updateAvailable: null, lastRun: record }),
  ).toBe(true);
}

describe("update run wire contract", () => {
  it.each([true, false, undefined])("projects optional core readiness (%s)", (coreReady) => {
    const record = toPublicUpdateRun(
      LedgerRecordSchema.parse({
        ...run,
        verification: { ...run.verification, coreReady, readyz: false, channelsReady: false },
      }),
    );
    expect(record.verification.coreReady).toBe(coreReady);
    expectWireRecord(record);
  });

  it("carries snapshot capacity evidence through the wire projection", () => {
    const evidence = {
      snapshotCapacity: {
        reason: "state-volume",
        sqliteBytes: 1024,
        pluginBytes: 2048,
        requiredBytes: 8192,
        candidates: [{ kind: "system-tmpdir", directory: "/synthetic/tmp", availableBytes: null }],
        selection: { kind: "state-volume", directory: "/synthetic/state.update-captures" },
      },
    };
    const record = LedgerRecordSchema.parse({
      ...run,
      steps: [{ step: "snapshot", status: "completed", ...evidence }],
    });
    expect(record.steps[0]).toMatchObject(evidence);
    expectWireRecord(record);
  });
});
