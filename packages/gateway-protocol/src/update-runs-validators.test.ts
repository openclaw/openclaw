import { describe, expect, it } from "vitest";
import { UpdateRunRecordSchema as LedgerRecordSchema } from "../../../src/infra/update-run-schema.js";
import {
  validateUpdateRunRecord,
  validateUpdateRunsGetResult,
  validateUpdateRunsListResult,
  validateUpdateStatusResult,
} from "./index.js";

const run = LedgerRecordSchema.parse({
  runId: "27d967ef-0485-4f98-a93a-229d50c75111",
  createdAtMs: 100,
  updatedAtMs: 300,
  trigger: "campaign",
  phase: "finished",
  status: "succeeded",
  reason: null,
  origin: {
    driver: { host: "gateway.test", pid: 1234, startIdentity: "98765" },
    previousDrivers: [{ host: "gateway.test", pid: 1200, startIdentity: "98700" }],
    requester: { channel: "telegram", accountId: "primary", senderId: "operator" },
    sessionKey: "agent:main:main",
    deliveryContext: { channel: "telegram", to: "chat", accountId: "default", threadId: "1" },
    campaignId: "campaign-1",
    doctorHint: "openclaw doctor",
    nextAction: "openclaw update status",
  },
  target: { channel: "dev", tag: "latest", kind: "git", version: "2026.9.1", sha: "abcdef" },
  before: { version: "2026.8.1", sha: null, buildId: null },
  after: { version: "2026.9.1", sha: "abcdef", buildId: "build-1" },
  steps: [{ step: "doctor", status: "completed", startedAtMs: 100, endedAtMs: 200, detail: "ok" }],
  verification: {
    booted: true,
    runningVersion: "2026.9.1",
    runningBuildId: "build-1",
    serviceRunning: true,
    pid: 123,
    port: 19001,
    versionMatch: true,
    pluginErrors: [],
    channelsReady: true,
    noticeDelivered: true,
    doctorHint: "openclaw doctor",
  },
  repair: [
    {
      attempt: 1,
      status: "succeeded",
      startedAtMs: 150,
      endedAtMs: 175,
      summary: "Repaired",
      reason: "doctor",
    },
  ],
  confirmedAtMs: 290,
  finishedAtMs: 300,
  downtimeMs: 25,
});

describe("update run wire contract", () => {
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
      steps: [{ ...run.steps[0], ...evidence }],
    });
    expect(record.steps[0]).toMatchObject(evidence);
    expect(validateUpdateRunRecord(record)).toBe(true);
    expect(validateUpdateRunsGetResult({ run: record })).toBe(true);
    expect(validateUpdateRunsListResult({ runs: [record] })).toBe(true);
    expect(
      validateUpdateStatusResult({ sentinel: null, updateAvailable: null, lastRun: record }),
    ).toBe(true);
  });
});
