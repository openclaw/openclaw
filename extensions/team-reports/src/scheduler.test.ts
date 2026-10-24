import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTeamReportsConfig, type TeamReportsConfig } from "./config.js";
import { bindReportFetch, type ReportFixtureFetch } from "./report-network.test-support.js";
import {
  createNativeDiscordSource as createDiscordSource,
  createNativeGithubSource as createGithubSource,
  withReportSourceFixtures,
} from "./report-source-fixtures.test-support.js";
import { discordMessage, githubItem, measureReads } from "./reports-data.test-support.js";
import { completion, type Complete } from "./reports.fixtures.js";
import type { ReportRunRequest } from "./run-worker-contract.js";
import { TeamReportsRunner } from "./run-worker.js";
import { generateReportPeriods, type ResolvedTeamReportsConfig } from "./run.js";
import { TeamReportsScheduler } from "./scheduler.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";
import type { DiscordSource, GithubSource, SourceStatus } from "./types.js";

const workerReads = vi.hoisted(() => ({ enabled: false, calls: 0, bytes: 0 }));
vi.mock("openclaw/plugin-sdk/database-engine-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/database-engine-runtime")>();
  return {
    ...actual,
    runEngineStoreOperation: async (...args: Parameters<typeof actual.runEngineStoreOperation>) => {
      const result = await actual.runEngineStoreOperation(...args);
      if (workerReads.enabled) {
        workerReads.calls += 1;
        workerReads.bytes += Buffer.byteLength(JSON.stringify(result) ?? "");
      }
      return result;
    },
  };
});

const resources: Array<{
  scheduler: TeamReportsScheduler;
  store: TeamReportsStore;
  directory: string;
}> = [];
const healthy: SourceStatus = { ok: true, warnings: [], stats: { apiCalls: 1 } };
const workerModuleUrl = resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint);

async function reopen(directory: string, check: (store: TeamReportsStore) => Promise<void>) {
  const store = await createTeamReportsStore({ stateDir: directory, workerModuleUrl });
  try {
    await check(store);
  } finally {
    await store.close();
  }
}

function blockCollection(github: { collect: ReturnType<typeof vi.fn<GithubSource["collect"]>> }) {
  const blocked = createDeferred<Awaited<ReturnType<GithubSource["collect"]>>>();
  github.collect.mockImplementationOnce(() => blocked.promise);
  return blocked;
}

async function runById(store: TeamReportsStore, id: string) {
  return (await store.listRuns()).find((run) => run.id === id);
}

async function setup(
  options: {
    stateDir?: string;
    schedule?: Partial<TeamReportsConfig["schedule"]>;
    summaries?: boolean;
    discord?: boolean;
    start?: boolean;
    nativeWorker?: boolean;
  } = {},
) {
  const config = parseTeamReportsConfig({
    github: { token: "fixture-github-token", orgs: ["sample"] },
    ...(options.discord
      ? {
          discord: {
            token: "fixture-discord-token",
            guildId: "100",
            channels: [{ id: "200", excerpts: true }],
          },
        }
      : {}),
    people: [{ github: ["alex"], discordUserId: "300" }],
    summaries: { enabled: options.summaries ?? false },
    schedule: {
      closedDayUtc: "23:59",
      intradayEveryHours: 4,
      jitterMinutes: 0,
      weekly: false,
      monthly: false,
      ...options.schedule,
    },
    retention: { days: 0 },
  });
  const resolved: ResolvedTeamReportsConfig = {
    github: { ...config.github, token: "fixture-github-token", ignoreCommentPatterns: [] },
    ...(config.discord
      ? {
          discord: {
            ...config.discord,
            token: "fixture-discord-token",
            apiBaseUrl: "https://discord.com/api/v10",
          },
        }
      : {}),
    people: config.people ?? [],
  };
  const directory =
    options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "team-reports-scheduler-"));
  const store = await createTeamReportsStore({ stateDir: directory, workerModuleUrl });
  const github = {
    loadRoster: vi
      .fn<GithubSource["loadRoster"]>()
      .mockResolvedValue({ people: [{ github: ["alex"] }], status: healthy }),
    collect: vi
      .fn<GithubSource["collect"]>()
      .mockImplementation(async (_config, window, _roster, emit) => {
        const atMs = window.sinceMs + Math.floor((window.untilMs - window.sinceMs) / 2);
        await emit([
          {
            key: "commit",
            value: githubItem({ actor: "alex", atMs }),
          },
        ]);
        return healthy;
      }),
  };
  const discord = {
    collect: vi.fn<DiscordSource["collect"]>().mockImplementation(async (_config, window, emit) => {
      const atMs = window.sinceMs + 1;
      await emit([
        {
          key: ((BigInt(atMs) - 1420070400000n) << 22n).toString(),
          value: discordMessage({
            channelId: "200",
            parentChannelId: "200",
            authorId: "300",
            atMs,
          }),
        },
      ]);
      return healthy;
    }),
  };
  const runtimes: ReportRunRequest["runtime"][] = [];
  const sources = { github, discord };
  const complete = vi.fn<Complete>().mockRejectedValue(new Error("Unexpected model request"));
  const completions: Array<ReturnType<typeof createDeferred<void>>> = [];
  let published = 0;
  let consumed = 0;
  const completionAt = (index: number) => (completions[index] ??= createDeferred<void>());
  const runSettled = () => completionAt(published++).resolve();
  const nextRun = () => completionAt(consumed++).promise;
  const context = {
    scheduler: createTestPluginServiceScheduler(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    serviceHealth: { reportFailure: vi.fn(runSettled), clearFailure: vi.fn(runSettled) },
  };
  const runner = options.nativeWorker
    ? new TeamReportsRunner(new URL("./run-worker.collection.test-support.ts", import.meta.url))
    : undefined;
  const runReports = vi.fn(async (params: ReportRunRequest) => {
    runtimes.push(params.runtime);
    return runner
      ? runner.run(params)
      : withReportSourceFixtures(sources, () => generateReportPeriods(params));
  });
  const scheduler = new TeamReportsScheduler({
    config,
    resolved,
    store,
    llm: { complete },
    context,
    runReports,
    closeRunner: () => runner?.close() ?? Promise.resolve(),
  });
  resources.push({ directory, store, scheduler });
  if (options.start !== false) {
    await scheduler.start();
  }
  return {
    scheduler,
    store,
    directory,
    github,
    discord,
    complete,
    context,
    runtimes,
    runReports,
    nextRun,
    generate: async (params: Parameters<TeamReportsScheduler["generate"]>[0] = {}) => {
      const id = await scheduler.generate(params);
      await nextRun();
      return id;
    },
  };
}

function modelResponse(): Awaited<ReturnType<Complete>> {
  return completion(
    JSON.stringify({
      globalSummary: "Widgets fixed.\n\n- **Work:** Resize correction.\n- **Coverage:** Complete.",
      highlights: ["Resize corrected.", "One active member.", "No reviews.", "GitHub collected."],
      members: [{ login: "alex", summary: "Corrected widget resizing.", confidence: "high" }],
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
});

afterEach(async () => {
  const owned = resources.splice(0);
  const stopped = owned.map(({ scheduler }) => scheduler.stop());
  await vi.advanceTimersByTimeAsync(30_001);
  await Promise.all(stopped);
  for (const { store, directory } of owned) {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Team Reports schedule boundaries", () => {
  it("keeps automatic collection off across rollover and restart while preserving manual reports", async () => {
    vi.setSystemTime(new Date("2026-08-31T23:58:00Z"));
    const first = await setup({
      schedule: { enabled: false, weekly: true, monthly: true },
    });
    const prune = vi.spyOn(first.store, "prune");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(first.github.loadRoster).not.toHaveBeenCalled();
    expect(await first.store.listRuns()).toEqual([]);
    expect(await first.scheduler.status()).toMatchObject({
      running: true,
      scheduleEnabled: false,
      nextDue: {},
    });

    const id = await first.generate({ date: "2026-08-31" });
    expect(await first.store.listRuns()).toMatchObject([{ id, kind: "manual", status: "ok" }]);
    const periods = await first.store.listPeriods();
    expect(periods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ period: "day", key: "2026-08-31" }),
        expect.objectContaining({ period: "week", key: "2026-W36" }),
        expect.objectContaining({ period: "month", key: "2026-08" }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(7 * 86_400_000);
    expect(first.github.collect).toHaveBeenCalledOnce();
    expect(prune).not.toHaveBeenCalled();
    await first.scheduler.stop();

    const restarted = await setup({
      stateDir: first.directory,
      schedule: { enabled: false, weekly: true, monthly: true },
    });
    await vi.advanceTimersByTimeAsync(31 * 86_400_000);
    expect(restarted.github.loadRoster).not.toHaveBeenCalled();
    expect(await restarted.store.listPeriods()).toEqual(periods);
    expect(await restarted.store.listRuns()).toMatchObject([{ id, kind: "manual", status: "ok" }]);
    expect(await restarted.scheduler.status()).toMatchObject({
      running: true,
      scheduleEnabled: false,
      nextDue: {},
    });
  });

  it("reuses an accepted closed day when the first scheduled run retries a partially failed run", async () => {
    const first = await setup();
    first.github.collect
      .mockImplementationOnce(async (_config, window, _roster, emit) => {
        await emit([
          {
            key: "accepted",
            value: githubItem({
              repo: "sample/widgets",
              title: "Accepted evidence",
              url: "https://github.com/sample/widgets/commit/accepted",
              actor: "alex",
              atMs: window.sinceMs + 1,
            }),
          },
        ]);
        return healthy;
      })
      .mockResolvedValueOnce({ ...healthy, ok: false, warnings: ["Current day unavailable"] });
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    await first.nextRun();
    const accepted = await first.store.getPeriod("day", "2026-08-19");
    expect(accepted?.report.totals.github.commits).toBe(1);
    expect((await first.store.listRuns())[0]?.status).toBe("error");
    await first.scheduler.stop();
    const restarted = await setup({ stateDir: first.directory });
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    await restarted.nextRun();
    expect(restarted.github.collect).toHaveBeenCalledTimes(1);
    expect(restarted.github.collect.mock.calls[0]?.[1].sinceMs).toBe(
      Date.parse("2026-08-20T00:00:00Z"),
    );
    expect(await restarted.store.getPeriod("day", "2026-08-19")).toEqual(accepted);
    expect((await restarted.store.listRuns())[0]?.status).toBe("ok");
  });

  it("does not schedule another closed-day run today when the next jitter sample is larger", async () => {
    vi.setSystemTime(new Date("2026-08-20T00:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(1);
    const { scheduler, store, nextRun } = await setup({
      schedule: { closedDayUtc: "00:05", jitterMinutes: 5 },
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await nextRun();
    expect(await store.listRuns()).toHaveLength(1);
    expect((await scheduler.status()).nextDue.closedDay).toBe(Date.parse("2026-08-21T00:10:00Z"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await store.listRuns()).toHaveLength(1);
  });
});

describe("Team Reports scheduler lifecycle", () => {
  it("reserves the run while admission is pending and returns its ID only after persistence", async () => {
    const { scheduler, store, github } = await setup();
    const admission = createDeferred<void>();
    const startRun = store.startRun.bind(store);
    vi.spyOn(store, "startRun").mockImplementationOnce(async (run) => {
      await admission.promise;
      await startRun(run);
    });
    const accepted = vi.fn();
    const pending = scheduler.generate().then(accepted);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(accepted).not.toHaveBeenCalled();
      expect(github.loadRoster).not.toHaveBeenCalled();
      await expect(scheduler.generate()).rejects.toThrow("already in progress");
    } finally {
      admission.resolve();
      await pending;
    }
    const id = accepted.mock.calls[0]?.[0];
    expect(await store.listRuns()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
  });

  it("rejects failed admission without collecting and releases the run for another request", async () => {
    const { scheduler, nextRun, store, github, generate } = await setup();
    vi.spyOn(store, "startRun").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(scheduler.generate()).rejects.toThrow("database unavailable");
    expect(github.loadRoster).not.toHaveBeenCalled();
    await nextRun();
    const id = await generate();
    expect((await runById(store, id))?.status).toBe("ok");
  });

  it("drains an admitted report write after cancellation before closing storage or starting summaries", async () => {
    const { scheduler, store, directory, complete } = await setup({
      summaries: true,
      nativeWorker: true,
    });
    const write = createDeferred<void>();
    const entered = createDeferred<void>();
    const execute = store.execute.bind(store);
    vi.spyOn(store, "execute").mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[0] === "upsertPeriod") {
        entered.resolve();
        await write.promise;
      }
      return result;
    });
    const close = vi.spyOn(store, "close");
    const id = await scheduler.generate();
    await entered.promise;
    const stopped = scheduler.stop();
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(close).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } finally {
      write.resolve();
      await stopped;
    }
    expect(close).toHaveBeenCalledOnce();
    await reopen(directory, async (reopened) => {
      expect((await reopened.getPeriod("day", "2026-08-19"))?.report.totals.github.total).toBe(1);
      expect(await runById(reopened, id)).toMatchObject({
        status: "error",
        error: expect.stringContaining("30 seconds"),
      });
    });
  });

  it("waits for asynchronous storage disposal during stop", async () => {
    const { scheduler, store } = await setup();
    const disposal = createDeferred<void>();
    const closeStore = store.close.bind(store);
    const close = vi.spyOn(store, "close").mockImplementation(async () => {
      await disposal.promise;
      await closeStore();
    });
    const completed = vi.fn();
    const stopped = scheduler.stop().then(completed);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledOnce();
      expect(completed).not.toHaveBeenCalled();
      await expect(scheduler.start()).rejects.toThrow("cannot be started again");
    } finally {
      disposal.resolve();
      await stopped;
    }
    await expect(scheduler.generate()).rejects.toThrow("not running");
  });

  it("reports the earliest due time and last completed run while another run is active", async () => {
    const { scheduler, github, nextRun } = await setup({
      start: false,
      schedule: { intradayEveryHours: 4 },
    });
    expect(await scheduler.health()).toEqual({ running: false, warnings: 0 });
    await scheduler.start();
    expect(await scheduler.health()).toEqual({
      running: true,
      nextDueMs: Date.parse("2026-08-20T16:00:00Z"),
      warnings: 0,
    });
    const firstCollection = blockCollection(github);
    await scheduler.generate();
    expect((await scheduler.health()).lastRun).toBeUndefined();
    firstCollection.resolve(healthy);
    await nextRun();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await scheduler.health()).toEqual({
      running: true,
      lastRun: { status: "ok", kind: "manual", finishedAtMs: Date.parse("2026-08-20T12:00:00Z") },
      nextDueMs: Date.parse("2026-08-20T16:00:00Z"),
      warnings: 0,
    });
    const blocked = blockCollection(github);
    await scheduler.generate({ intraday: true });
    await vi.advanceTimersByTimeAsync(0);
    expect((await scheduler.health()).lastRun).toEqual({
      status: "ok",
      kind: "manual",
      finishedAtMs: Date.parse("2026-08-20T12:00:00Z"),
    });
    blocked.resolve(healthy);
    await nextRun();
    expect((await scheduler.health()).lastRun?.finishedAtMs).toBe(
      Date.parse("2026-08-20T12:01:00Z"),
    );
  });

  it("keeps startup quiet and catches up at the first scheduled run", async () => {
    vi.setSystemTime(new Date("2026-08-19T23:58:00Z"));
    const due = Date.parse("2026-08-20T00:03:00Z");
    const { scheduler, store, github, nextRun } = await setup({
      schedule: { closedDayUtc: "23:59" },
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(github.loadRoster).not.toHaveBeenCalled();
    expect(await store.listRuns()).toEqual([]);
    expect((await scheduler.health()).nextDueMs).toBe(due);
    await vi.advanceTimersByTimeAsync(due - Date.now());
    await nextRun();
    expect(await store.listRuns()).toMatchObject([{ kind: "closed-day", status: "ok" }]);
    expect(await store.listPeriods()).toMatchObject([
      { period: "day", key: "2026-08-20", status: "partial" },
      { period: "day", key: "2026-08-19", status: "closed" },
      { period: "day", key: "2026-08-18", status: "closed" },
    ]);
    expect(github.collect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(github.collect).toHaveBeenCalledTimes(3);
    const nextDue = (await scheduler.status()).nextDue;
    expect(nextDue.closedDay).toBe(Date.parse("2026-08-20T23:59:00Z"));
    const nextIntraday = nextDue.intraday!;
    await vi.advanceTimersByTimeAsync(nextIntraday - Date.now());
    await nextRun();
    expect((await store.listRuns())[0]?.kind).toBe("intraday");
    expect(github.collect).toHaveBeenCalledTimes(4);
  });

  it("closes yesterday after rollover when the earlier partial report came from manual scheduling", async () => {
    vi.setSystemTime(new Date("2026-08-20T11:54:00Z"));
    const first = await setup({
      schedule: {
        intradayEveryHours: 0,
        closedDayUtc: "23:59",
      },
    });
    await first.scheduler.generate({ intraday: true });
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await first.nextRun();
    expect((await first.store.listRuns())[0]).toMatchObject({
      kind: "manual",
      status: "ok",
      periods: expect.arrayContaining([{ period: "day", key: "2026-08-20" }]),
    });
    expect((await first.store.getPeriod("day", "2026-08-20"))?.report.status).toBe("partial");
    await first.scheduler.stop();

    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    const restarted = await setup({ stateDir: first.directory });
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    await restarted.nextRun();
    expect(restarted.github.collect).toHaveBeenCalledTimes(2);
    expect(restarted.github.collect.mock.calls[0]?.[1]).toEqual({
      sinceMs: Date.parse("2026-08-20T00:00:00Z"),
      untilMs: Date.parse("2026-08-21T00:00:00Z"),
    });
    expect((await restarted.store.getPeriod("day", "2026-08-20"))?.report.status).toBe("closed");
  });

  it("rejects a concurrent manual run and defers an intraday tick without overlapping collectors", async () => {
    vi.setSystemTime(new Date("2026-08-20T03:54:00Z"));
    const { scheduler, store, github, nextRun } = await setup({
      schedule: { intradayEveryHours: 4 },
    });
    const blocked = createDeferred<Awaited<ReturnType<GithubSource["collect"]>>>();
    const collecting = createDeferred<void>();
    github.collect.mockImplementationOnce(() => {
      collecting.resolve();
      return blocked.promise;
    });
    const id = await scheduler.generate();
    await expect(scheduler.generate()).rejects.toThrow("already in progress");
    await collecting.promise;
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(github.collect).toHaveBeenCalledOnce();
    expect((await runById(store, id))?.status).toBe("running");
    blocked.resolve(healthy);
    await nextRun();
    expect((await runById(store, id))?.status).toBe("ok");
    await vi.advanceTimersByTimeAsync(60_000);
    await nextRun();
    expect(github.collect).toHaveBeenCalledTimes(2);
    expect(
      (await store.listRuns()).some((run) => run.kind === "closed-day" && run.status === "ok"),
    ).toBe(true);
    expect((await scheduler.status()).nextDue.intraday).toBe(Date.parse("2026-08-20T08:00:00Z"));
  });

  it("waits for an in-flight run during stop and preserves its successful report", async () => {
    const { scheduler, github, directory } = await setup();
    const blocked = blockCollection(github);
    const id = await scheduler.generate();
    await vi.advanceTimersByTimeAsync(0);
    let finished = false;
    const stopped = scheduler.stop().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finished).toBe(false);
    await expect(scheduler.generate()).rejects.toThrow("not running");
    blocked.resolve(healthy);
    await stopped;
    expect(finished).toBe(true);
    await reopen(directory, async (reopened) => {
      expect((await runById(reopened, id))?.status).toBe("ok");
      expect((await reopened.getPeriod("day", "2026-08-19"))?.report.status).toBe("closed");
    });
  });

  it.each([
    { reason: "30 seconds", timeout: 30_000, stop: true },
    { reason: "45-minute", timeout: 45 * 60_000, stop: false },
  ])("aborts at $reason and rejects late run results", async ({ reason, timeout, stop }) => {
    const { scheduler, runReports, runtimes, store, directory, context, nextRun } = await setup();
    const blocked = createDeferred<Record<string, SourceStatus>>();
    // Model the native runner's cancellation boundary, not an inline collector's private signal.
    runReports.mockImplementationOnce(({ runtime }) => {
      runtimes.push(runtime);
      return racePromiseWithAbortSignal(blocked.promise, runtime.signal, (signal) => signal.reason);
    });
    const id = await scheduler.generate();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = stop ? scheduler.stop() : undefined;
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(runtimes[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtimes[0]?.signal?.aborted).toBe(true);
    await (stopped ?? nextRun());
    expect(context.serviceHealth.reportFailure).toHaveBeenCalledOnce();
    blocked.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    const check = async (reader: TeamReportsStore) => {
      expect(await runById(reader, id)).toMatchObject({
        status: "error",
        error: expect.stringContaining(reason),
      });
      expect(await reader.listPeriods()).toEqual([]);
    };
    await (stop ? reopen(directory, check) : check(store));
  });

  it("publishes evidence before model completion and reuses stored prose on regeneration", async () => {
    const { scheduler, store, complete, github, nextRun, generate } = await setup({
      summaries: true,
    });
    const blocked = createDeferred<Awaited<ReturnType<Complete>>>();
    const summarizing = createDeferred<void>();
    complete.mockImplementation(() => {
      summarizing.resolve();
      return blocked.promise;
    });
    const id = await scheduler.generate();
    await summarizing.promise;
    const before = await store.getPeriod("day", "2026-08-19");
    expect(before?.report.totals.github.total).toBe(1);
    expect(before?.summary?.source).toBe("fallback");
    expect((await runById(store, id))?.status).toBe("running");
    blocked.resolve(modelResponse());
    await nextRun();
    const stored = await store.getPeriod("day", "2026-08-19");
    expect(stored?.summary?.source).toBe("model");
    expect((await runById(store, id))?.status).toBe("ok");
    if (!stored) {
      throw new Error("Generated report is missing");
    }
    await store.upsertPeriod({ ...stored, markdown: stored.markdown + "é".repeat(128 * 1024) });
    await measureReads(workerReads, async () => {
      await generate();
    });
    expect.soft(workerReads.bytes).toBeLessThan(16 * 1024);
    expect(complete).toHaveBeenCalledOnce();
    expect(github.collect).toHaveBeenCalledTimes(2);
    expect(await store.getPeriod("day", "2026-08-19")).toEqual(stored);
  });

  it("surfaces the latest day's model fallback in status, storage, Markdown, and logs", async () => {
    const { scheduler, generate, store, context, complete, github } = await setup({
      summaries: true,
    });
    github.loadRoster.mockResolvedValue({
      people: [{ github: ["alex"] }],
      status: { ...healthy, warnings: ["Roster coverage warning"] },
    });
    complete.mockRejectedValue(new Error("private-provider-error-marker"));
    await generate();
    const reason = "Model summary unavailable: completion failed";
    const stored = await store.getPeriod("day", "2026-08-19");
    expect(stored?.summary?.warnings).toEqual([reason]);
    expect(stored?.markdown).toContain(`> ${reason}`);
    expect((await scheduler.status()).sourceWarnings).toEqual(["Roster coverage warning", reason]);
    if (!stored) {
      throw new Error("Generated report is missing");
    }
    await store.upsertPeriod({ ...stored, markdown: stored.markdown + "x".repeat(256 * 1024) });
    await measureReads(workerReads, async () => {
      expect((await scheduler.health()).warnings).toBe(2);
    });
    expect(workerReads.calls).toBeLessThanOrEqual(3);
    expect(workerReads.bytes).toBeLessThan(16 * 1024);
    expect(context.logger.warn.mock.calls).toEqual([[reason]]);
    complete.mockResolvedValue(modelResponse());
    await generate({ intraday: true });
    expect((await scheduler.status()).sourceWarnings).toEqual(["Roster coverage warning"]);
    expect((await scheduler.health()).warnings).toBe(1);
  });

  it("names failed activity sources in run errors, logs, and service health", async () => {
    const { generate, nextRun, store, github, discord, context } = await setup({
      discord: true,
      schedule: { weekly: true, monthly: true },
    });
    github.collect.mockResolvedValueOnce({
      ...healthy,
      ok: false,
      warnings: ["GitHub access unavailable"],
    });
    discord.collect.mockResolvedValueOnce({
      ...healthy,
      ok: false,
      warnings: ["Discord access unavailable"],
    });
    const id = await generate();

    const run = await runById(store, id);
    expect(run?.status).toBe("error");
    expect(run?.error).toContain("day/2026-08-19/github");
    expect(run?.error).toContain("day/2026-08-19/discord");
    expect(context.logger.error).toHaveBeenCalledWith(`team-reports: ${run?.error}`);
    expect(context.serviceHealth.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: run?.error }),
    );
    expect(await store.listPeriods()).toEqual([]);
    expect(context.serviceHealth.clearFailure).not.toHaveBeenCalled();
    // The first scheduled run recovers the failed closed day.
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    await nextRun();
    expect(github.collect).toHaveBeenCalledTimes(3);
    expect((await store.getPeriod("day", "2026-08-19"))?.report.totals.github.total).toBe(1);
    expect((await store.getPeriod("week", "2026-W34"))?.report.totals.github.total).toBe(2);
    expect((await store.getPeriod("month", "2026-08"))?.report.totals.github.total).toBe(2);
    expect(context.serviceHealth.clearFailure).toHaveBeenCalledOnce();
  });

  it.each(["github", "discord"] as const)(
    "preserves accepted activity after a %s subrequest fails and accepts healthy zero activity",
    async (source) => {
      const { generate, store, github, discord, context } = await setup({
        discord: true,
        schedule: { weekly: true, monthly: true },
      });
      await generate();
      const previous = await store.getPeriod("day", "2026-08-19");
      const previousDays = await store.listPersonDays("alex");
      const previousWeek = await store.getPeriod("week", "2026-W34");
      const previousMonth = await store.getPeriod("month", "2026-08");
      expect(previous?.report.totals.github.total).toBe(1);
      expect(previous?.report.totals.discord.messages).toBe(1);
      expect(previousWeek?.report.totals.github.total).toBe(1);
      expect(previousMonth?.report.totals.discord.messages).toBe(1);

      const fetchImpl: ReportFixtureFetch = async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/commits") || url.pathname.endsWith("/messages")) {
          return new Response("{}", { status: 403 });
        }
        const body = url.pathname.endsWith("/repos")
          ? [{ full_name: "sample/widgets", archived: false }]
          : url.pathname === "/search/issues"
            ? { total_count: 0, items: [] }
            : url.pathname.endsWith("/channels")
              ? [{ id: "200", name: "engineering" }]
              : url.pathname.includes("/threads/")
                ? { threads: [], has_more: false }
                : [];
        return new Response(JSON.stringify(body));
      };
      const runtime = { logger: context.logger };
      if (source === "github") {
        github.collect.mockImplementationOnce((...args) =>
          bindReportFetch(createGithubSource(runtime), fetchImpl).collect(...args),
        );
      } else {
        discord.collect.mockImplementationOnce((...args) =>
          bindReportFetch(createDiscordSource(runtime), fetchImpl).collect(...args),
        );
      }
      vi.setSystemTime(Date.now() + 1_000);
      const failed = await generate();
      expect(await runById(store, failed)).toMatchObject({
        status: "error",
        stats: { [`day/2026-08-19/${source}`]: { ok: false, stale: true } },
      });
      expect(await store.getPeriod("day", "2026-08-19")).toEqual(previous);
      expect(await store.listPersonDays("alex")).toEqual(previousDays);
      expect(await store.getPeriod("week", "2026-W34")).toEqual(previousWeek);
      expect(await store.getPeriod("month", "2026-08")).toEqual(previousMonth);
      expect(context.serviceHealth.reportFailure).toHaveBeenCalledOnce();
      expect(context.serviceHealth.clearFailure).toHaveBeenCalledOnce();

      github.collect.mockResolvedValueOnce(healthy);
      discord.collect.mockResolvedValueOnce(healthy);
      const recovered = await generate();
      expect((await runById(store, recovered))?.status).toBe("ok");
      const current = await store.getPeriod("day", "2026-08-19");
      expect(current?.report.totals.github.total).toBe(0);
      expect(current?.report.totals.discord.messages).toBe(0);
      for (const [period, key] of [
        ["week", "2026-W34"],
        ["month", "2026-08"],
      ] as const) {
        const rollup = await store.getPeriod(period, key);
        expect(rollup?.report.totals.github.total).toBe(0);
        expect(rollup?.report.totals.discord.messages).toBe(0);
      }
      expect(context.serviceHealth.clearFailure).toHaveBeenCalledTimes(2);
    },
  );

  it("publishes healthy empty-repository activity alongside the other source", async () => {
    const { generate, store, github, context } = await setup({
      discord: true,
    });
    github.collect.mockImplementationOnce((...args) =>
      bindReportFetch(createGithubSource({ logger: context.logger }), async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/commits")) {
          return new Response(JSON.stringify({ message: "Git Repository is empty." }), {
            status: 409,
          });
        }
        const body = url.pathname.endsWith("/repos")
          ? [{ full_name: "sample/widgets", archived: false }]
          : url.pathname === "/search/issues"
            ? { total_count: 0, items: [] }
            : [];
        return new Response(JSON.stringify(body));
      }).collect(...args),
    );
    const id = await generate();
    expect((await runById(store, id))?.status).toBe("ok");
    const current = await store.getPeriod("day", "2026-08-19");
    expect(current?.report.totals.github.total).toBe(0);
    expect(current?.report.totals.discord.messages).toBe(1);
    expect(current?.report.sources.github).toMatchObject({ ok: true, warnings: [] });
    expect(context.serviceHealth.clearFailure).toHaveBeenCalledOnce();
    expect(context.serviceHealth.reportFailure).not.toHaveBeenCalled();
  });

  it("reports source failures with redacted errors and clears health on the next successful run", async () => {
    const { scheduler, generate, store, github, context } = await setup();
    github.collect.mockRejectedValueOnce(new Error("Access failed for fixture-github-token"));
    const failed = await generate();
    expect(await runById(store, failed)).toMatchObject({
      status: "error",
      error: "Access failed for [redacted]",
    });
    expect(context.serviceHealth.reportFailure).toHaveBeenCalledOnce();
    expect((await scheduler.health()).lastRun).toEqual({
      status: "error",
      kind: "manual",
      finishedAtMs: Date.now(),
    });
    expect(JSON.stringify(context.logger.error.mock.calls)).not.toContain("fixture-github-token");
    const succeeded = await generate();
    expect((await runById(store, succeeded))?.status).toBe("ok");
    expect(context.serviceHealth.clearFailure).toHaveBeenCalledOnce();
  });

  it("preserves only rollups overlapping a rejected day at month rollover", async () => {
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    const { generate, store, github, nextRun } = await setup({
      schedule: { weekly: true, monthly: true },
    });
    github.collect.mockResolvedValueOnce({
      ...healthy,
      ok: false,
      warnings: ["GitHub access unavailable"],
    });
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    await nextRun();
    expect(github.collect).toHaveBeenCalledTimes(2);
    expect(await store.getPeriod("day", "2026-08-31")).toBeUndefined();
    expect(await store.getPeriod("week", "2026-W36")).toBeUndefined();
    expect(await store.getPeriod("month", "2026-08")).toBeUndefined();
    expect((await store.getPeriod("day", "2026-09-01"))?.report.totals.github.total).toBe(1);
    const september = await store.getPeriod("month", "2026-09");
    expect(september?.report.totals.github.total).toBe(1);
    expect((await store.listRuns())[0]?.status).toBe("error");

    const recovered = await generate({ date: "2026-08-31" });
    expect((await store.getPeriod("day", "2026-08-31"))?.report.totals.github.total).toBe(1);
    expect((await store.getPeriod("week", "2026-W36"))?.report.totals.github.total).toBe(2);
    expect((await store.getPeriod("month", "2026-08"))?.report.totals.github.total).toBe(1);
    expect(await store.getPeriod("month", "2026-09")).toEqual(september);
    expect((await runById(store, recovered))?.status).toBe("ok");
  });
});
