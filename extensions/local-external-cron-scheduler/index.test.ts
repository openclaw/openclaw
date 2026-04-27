import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import entry, {
  __testing,
  resolveLocalExternalCronSchedulerConfig,
  syncAllCronJobs,
  syncCronChanged,
} from "./index.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-external-cron-scheduler-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

describe("local-external-cron-scheduler", () => {
  it("defaults to disabled local scheduler sync", () => {
    const cfg = resolveLocalExternalCronSchedulerConfig(undefined);

    expect(cfg.enabled).toBe(false);
    expect(cfg.instanceId).toBe("local");
    expect(cfg.commandTemplate).toBe("openclaw cron run {jobId} --due");
  });

  it("does not register hooks unless explicitly enabled", () => {
    const api = {
      pluginConfig: {},
      on: vi.fn(),
    } as never;

    entry.register(api);

    expect((api as { on: ReturnType<typeof vi.fn> }).on).not.toHaveBeenCalled();
  });

  it("registers gateway_start and cron_changed hooks when enabled", () => {
    const api = {
      pluginConfig: { enabled: true },
      on: vi.fn(),
    } as never;

    entry.register(api);

    expect((api as { on: ReturnType<typeof vi.fn> }).on).toHaveBeenCalledWith(
      "gateway_start",
      expect.any(Function),
    );
    expect((api as { on: ReturnType<typeof vi.fn> }).on).toHaveBeenCalledWith(
      "cron_changed",
      expect.any(Function),
    );
  });

  it("syncs existing cron jobs on gateway start to a local state file", async () => {
    const root = await makeTempRoot();
    const statePath = path.join(root, "jobs.json");
    const config = resolveLocalExternalCronSchedulerConfig({
      enabled: true,
      statePath,
      instanceId: "dev-instance",
      commandTemplate: "openshell exec -- openclaw cron run {jobId} --due",
      leadTimeMs: 5_000,
    });

    await syncAllCronJobs({
      config,
      nowMs: 100,
      cron: {
        list: () => [
          {
            id: "job-b",
            name: "b",
            enabled: true,
            schedule: { kind: "at", at: "2026-04-25T00:00:10Z" },
            state: { nextRunAtMs: 10_000 },
          },
          {
            id: "job-a",
            name: "a",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            state: { nextRunAtMs: 9_000 },
          },
          {
            id: "missing-next-run",
            enabled: true,
          },
        ],
      },
    });

    expect(await readJson(statePath)).toEqual({
      version: 1,
      updatedAtMs: 100,
      jobs: [
        expect.objectContaining({
          instanceId: "dev-instance",
          jobId: "job-a",
          wakeAtMs: 4_000,
          nextRunAtMs: 9_000,
          command: "openshell exec -- openclaw cron run job-a --due",
          enabled: true,
        }),
        expect.objectContaining({
          jobId: "job-b",
          wakeAtMs: 5_000,
          nextRunAtMs: 10_000,
        }),
      ],
    });
  });

  it("upserts and removes cron jobs from cron_changed events", async () => {
    const root = await makeTempRoot();
    const statePath = path.join(root, "jobs.json");
    const config = resolveLocalExternalCronSchedulerConfig({ enabled: true, statePath });

    await syncCronChanged({
      config,
      nowMs: 200,
      event: {
        action: "added",
        jobId: "job-1",
        job: {
          id: "job-1",
          enabled: true,
          state: { nextRunAtMs: 1_000 },
        },
      },
    });

    expect(await readJson(statePath)).toEqual({
      version: 1,
      updatedAtMs: 200,
      jobs: [expect.objectContaining({ jobId: "job-1", nextRunAtMs: 1_000 })],
    });

    // Single-fire finished (no job on event) removes the job
    await syncCronChanged({
      config,
      nowMs: 300,
      event: { action: "finished", jobId: "job-1" },
    });

    expect(await readJson(statePath)).toEqual({
      version: 1,
      updatedAtMs: 300,
      jobs: [],
    });
  });

  it("finished on a recurring job upserts the new wake time instead of removing", async () => {
    const root = await makeTempRoot();
    const statePath = path.join(root, "jobs.json");
    const config = resolveLocalExternalCronSchedulerConfig({ enabled: true, statePath });

    // Add a recurring job
    await syncCronChanged({
      config,
      nowMs: 100,
      event: {
        action: "added",
        jobId: "recurring-1",
        job: {
          id: "recurring-1",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          state: { nextRunAtMs: 60_000 },
        },
      },
    });

    expect(await readJson(statePath)).toEqual({
      version: 1,
      updatedAtMs: 100,
      jobs: [expect.objectContaining({ jobId: "recurring-1", nextRunAtMs: 60_000 })],
    });

    // Finished event on recurring job — job still exists with advanced nextRunAtMs
    await syncCronChanged({
      config,
      nowMs: 200,
      event: {
        action: "finished",
        jobId: "recurring-1",
        job: {
          id: "recurring-1",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          state: { nextRunAtMs: 120_000 },
        },
      },
    });

    // Should upsert with new wake time, NOT remove
    expect(await readJson(statePath)).toEqual({
      version: 1,
      updatedAtMs: 200,
      jobs: [expect.objectContaining({ jobId: "recurring-1", nextRunAtMs: 120_000 })],
    });
  });

  it("started event without a job is a no-op (does not remove existing schedule)", async () => {
    const root = await makeTempRoot();
    const statePath = path.join(root, "jobs.json");
    const config = resolveLocalExternalCronSchedulerConfig({ enabled: true, statePath });

    // Seed a job in the state file
    await syncCronChanged({
      config,
      nowMs: 100,
      event: {
        action: "added",
        jobId: "job-1",
        job: { id: "job-1", enabled: true, state: { nextRunAtMs: 5_000 } },
      },
    });

    // Started event without a job object — should not remove
    await syncCronChanged({
      config,
      nowMs: 200,
      event: { action: "started", jobId: "job-1" },
    });

    const state = (await readJson(statePath)) as { jobs: { jobId: string }[] };
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]!.jobId).toBe("job-1");
  });

  it("omits disabled jobs unless includeDisabled is configured", () => {
    const excluded = __testing.buildSchedulerJob({
      nowMs: 1,
      config: resolveLocalExternalCronSchedulerConfig({ enabled: true }),
      job: { id: "disabled", enabled: false, state: { nextRunAtMs: 1_000 } },
    });
    const included = __testing.buildSchedulerJob({
      nowMs: 1,
      config: resolveLocalExternalCronSchedulerConfig({ enabled: true, includeDisabled: true }),
      job: { id: "disabled", enabled: false, state: { nextRunAtMs: 1_000 } },
    });

    expect(excluded).toBeNull();
    expect(included).toEqual(expect.objectContaining({ jobId: "disabled", enabled: false }));
  });
});
