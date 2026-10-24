import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTeamReportsConfig, type TeamReportsConfig } from "./config.js";
import { withReportSourceFixtures } from "./report-source-fixtures.test-support.js";
import { discordMessage, githubItem } from "./reports-data.test-support.js";
import { completion, type Complete } from "./reports.fixtures.js";
import type { ReportRunRequest } from "./run-worker-contract.js";
import { generateReportPeriods, type ResolvedTeamReportsConfig } from "./run.js";
import { TeamReportsScheduler } from "./scheduler.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";
import type { DiscordSource, GithubSource, SourceStatus } from "./types.js";

const resources: Array<{
  scheduler: TeamReportsScheduler;
  directory: string;
}> = [];
const healthy: SourceStatus = { ok: true, warnings: [], stats: { apiCalls: 1 } };
const failedSource = (name: string): SourceStatus => ({
  ...healthy,
  ok: false,
  warnings: [`${name} access unavailable`],
});
const workerModuleUrl = resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint);
const periodKeys = [
  ["day", "2026-08-19"],
  ["week", "2026-W34"],
  ["month", "2026-08"],
] as const;

async function documents(store: TeamReportsStore) {
  return Promise.all(periodKeys.map(([period, key]) => store.getPeriod(period, key)));
}

async function totals(store: TeamReportsStore, github: number, discord: number) {
  for (const document of await documents(store)) {
    expect(document?.report.totals).toMatchObject({
      github: { total: github },
      discord: { messages: discord },
    });
  }
}

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
  } = {},
) {
  const config = parseTeamReportsConfig({
    github: { token: "fixture-github-token", orgs: ["sample"] },
    discord: options.discord
      ? {
          token: "fixture-discord-token",
          guildId: "100",
          channels: [{ id: "200", excerpts: true }],
        }
      : undefined,
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
    ...(config.discord && {
      discord: {
        ...config.discord,
        token: "fixture-discord-token",
        apiBaseUrl: "https://discord.com/api/v10",
      },
    }),
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
        await emit([{ key: "commit", value: githubItem({ actor: "alex", atMs }) }]);
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
  const runReports = vi.fn((params: ReportRunRequest) =>
    withReportSourceFixtures(sources, () => generateReportPeriods(params)),
  );
  const scheduler = new TeamReportsScheduler({
    config,
    resolved,
    store,
    llm: { complete },
    context,
    runReports,
    closeRunner: async () => {},
  });
  resources.push({ directory, scheduler });
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
    runReports,
    nextRun,
    tick: async (ms = 4 * 3_600_000) => {
      await vi.advanceTimersByTimeAsync(ms);
      await nextRun();
    },
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
  for (const { directory } of owned) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Team Reports scheduler", () => {
  it("keeps automatic collection off across rollover and restart while preserving manual reports", async () => {
    vi.setSystemTime(new Date("2026-08-31T23:58:00Z"));
    const schedule = { enabled: false, weekly: true, monthly: true };
    const first = await setup({ schedule });
    const prune = vi.spyOn(first.store, "prune");
    const id = await first.generate({ date: "2026-08-31" });
    expect(await first.store.listRuns()).toMatchObject([{ id, kind: "manual", status: "ok" }]);
    const periods = await first.store.listPeriods();
    await vi.advanceTimersByTimeAsync(7 * 86_400_000);
    expect(first.github.collect).toHaveBeenCalledOnce();
    expect(prune).not.toHaveBeenCalled();
    await first.scheduler.stop();

    const restarted = await setup({ stateDir: first.directory, schedule });
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
    const collect = first.github.collect.getMockImplementation()!;
    first.github.collect
      .mockImplementationOnce(collect)
      .mockResolvedValueOnce(failedSource("Current day"));
    await first.tick();
    const accepted = await first.store.getPeriod("day", "2026-08-19");
    expect(accepted?.report.totals.github.commits).toBe(1);
    expect((await first.store.listRuns())[0]?.status).toBe("error");
    await first.scheduler.stop();
    const restarted = await setup({ stateDir: first.directory });
    await restarted.tick();
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
  it.each([false, true])("settles admission before collection (reject=%s)", async (reject) => {
    const { scheduler, store, github, generate, nextRun } = await setup();
    const admission = createDeferred<void>();
    const startRun = store.startRun.bind(store);
    vi.spyOn(store, "startRun").mockImplementationOnce(async (run) => {
      await admission.promise;
      if (reject) {
        throw new Error("database unavailable");
      }
      await startRun(run);
    });
    const accepted = vi.fn();
    const pending = scheduler.generate().then(accepted);
    const outcome = reject ? expect(pending).rejects.toThrow("database unavailable") : pending;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(accepted).not.toHaveBeenCalled();
      expect(github.loadRoster).not.toHaveBeenCalled();
      await expect(scheduler.generate()).rejects.toThrow("already in progress");
    } finally {
      admission.resolve();
      await outcome;
    }
    if (reject) {
      await nextRun();
      expect((await runById(store, await generate()))?.status).toBe("ok");
    } else {
      expect(await store.listRuns()).toContainEqual(
        expect.objectContaining({ id: accepted.mock.calls[0]?.[0] }),
      );
    }
  });

  it("keeps startup quiet and catches up at the first scheduled run", async () => {
    vi.setSystemTime(new Date("2026-08-19T23:58:00Z"));
    const due = Date.parse("2026-08-20T00:03:00Z");
    const { scheduler, store, github, nextRun } = await setup();
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
    const runs = await store.listRuns();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await store.listRuns()).toEqual(runs);
    const nextDue = (await scheduler.status()).nextDue;
    expect(nextDue.closedDay).toBe(Date.parse("2026-08-20T23:59:00Z"));
    await vi.advanceTimersByTimeAsync(nextDue.intraday! - Date.now());
    await nextRun();
    expect((await store.listRuns())[0]?.kind).toBe("intraday");
  });

  it("closes yesterday after rollover when the earlier partial report came from manual scheduling", async () => {
    vi.setSystemTime(new Date("2026-08-20T11:54:00Z"));
    const first = await setup({ schedule: { intradayEveryHours: 0 } });
    await first.scheduler.generate({ intraday: true });
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await first.nextRun();
    expect((await first.store.getPeriod("day", "2026-08-20"))?.report.status).toBe("partial");
    await first.scheduler.stop();

    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    const restarted = await setup({ stateDir: first.directory });
    await restarted.tick();
    expect((await restarted.store.getPeriod("day", "2026-08-20"))?.report.status).toBe("closed");
  });

  it("rejects a concurrent manual run and defers an intraday tick without overlapping collectors", async () => {
    vi.setSystemTime(new Date("2026-08-20T03:54:00Z"));
    const { scheduler, store, github, nextRun, generate } = await setup({ start: false });
    expect(await scheduler.health()).toEqual({ running: false, warnings: 0 });
    await scheduler.start();
    expect((await scheduler.health()).lastRun).toBeUndefined();
    await generate();
    const lastRun = { status: "ok", kind: "manual", finishedAtMs: Date.now() };
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
    expect(github.collect).toHaveBeenCalledTimes(2);
    expect((await scheduler.health()).lastRun).toEqual(lastRun);
    expect((await runById(store, id))?.status).toBe("running");
    blocked.resolve(healthy);
    await nextRun();
    expect((await runById(store, id))?.status).toBe("ok");
    expect((await scheduler.health()).lastRun?.finishedAtMs).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(60_000);
    await nextRun();
    expect(await store.listRuns()).toContainEqual(
      expect.objectContaining({ kind: "closed-day", status: "ok" }),
    );
    expect((await scheduler.status()).nextDue.intraday).toBe(Date.parse("2026-08-20T08:00:00Z"));
  });

  it("drains the in-flight run and storage disposal before stop resolves", async () => {
    const { scheduler, github, directory, store } = await setup();
    const disposal = createDeferred<void>();
    const closing = createDeferred<void>();
    const closeStore = store.close.bind(store);
    vi.spyOn(store, "close").mockImplementation(async () => {
      closing.resolve();
      await disposal.promise;
      await closeStore();
    });
    const blocked = blockCollection(github);
    const id = await scheduler.generate();
    await vi.advanceTimersByTimeAsync(0);
    const finished = vi.fn();
    const stopped = scheduler.stop().then(finished);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finished).not.toHaveBeenCalled();
    await expect(scheduler.generate()).rejects.toThrow("not running");
    blocked.resolve(healthy);
    try {
      await closing.promise;
      expect(finished).not.toHaveBeenCalled();
      await expect(scheduler.start()).rejects.toThrow("cannot be started again");
    } finally {
      disposal.resolve();
      await stopped;
    }
    expect(finished).toHaveBeenCalledOnce();
    await reopen(directory, async (reopened) => {
      expect((await runById(reopened, id))?.status).toBe("ok");
      expect((await reopened.getPeriod("day", "2026-08-19"))?.report.status).toBe("closed");
    });
  });

  it.each([
    { reason: "30 seconds", timeout: 30_000, stop: true },
    { reason: "45-minute", timeout: 45 * 60_000, stop: false },
  ])("aborts at $reason and rejects late run results", async ({ reason, timeout, stop }) => {
    const { scheduler, runReports, store, directory, nextRun } = await setup();
    const blocked = createDeferred<Record<string, SourceStatus>>();
    // Model the native runner's cancellation boundary, not an inline collector's private signal.
    runReports.mockImplementationOnce(({ runtime }) =>
      racePromiseWithAbortSignal(blocked.promise, runtime.signal, (signal) => signal.reason),
    );
    const id = await scheduler.generate();
    await vi.advanceTimersByTimeAsync(0);
    const signal = runReports.mock.calls[0]?.[0].runtime.signal;
    const stopped = stop ? scheduler.stop() : undefined;
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await (stopped ?? nextRun());
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

  it("publishes evidence before model completion", async () => {
    const { scheduler, store, complete, nextRun } = await setup({ summaries: true });
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
    expect((await store.getPeriod("day", "2026-08-19"))?.summary?.source).toBe("model");
    expect((await runById(store, id))?.status).toBe("ok");
  });

  it("surfaces and clears the latest day's model fallback", async () => {
    const { scheduler, generate, store, complete, github } = await setup({
      summaries: true,
    });
    github.loadRoster.mockResolvedValue({
      people: [{ github: ["alex"] }],
      status: { ...healthy, warnings: ["Roster coverage warning"] },
    });
    await generate();
    const reason = "Model summary unavailable: completion failed";
    const stored = await store.getPeriod("day", "2026-08-19");
    expect(stored?.summary?.warnings).toEqual([reason]);
    expect(stored?.markdown).toContain(`> ${reason}`);
    expect((await scheduler.status()).sourceWarnings).toEqual(["Roster coverage warning", reason]);
    expect((await scheduler.health()).warnings).toBe(2);
    complete.mockResolvedValue(modelResponse());
    await generate({ intraday: true });
    expect((await scheduler.status()).sourceWarnings).toEqual(["Roster coverage warning"]);
    expect((await scheduler.health()).warnings).toBe(1);
  });

  it.each(["github", "discord", "both", "exception"] as const)(
    "preserves accepted activity after a %s subrequest fails and accepts healthy zero activity",
    async (source) => {
      const { scheduler, generate, store, github, discord, context } = await setup({
        discord: true,
        schedule: { weekly: true, monthly: true },
      });
      await generate();
      const previous = await documents(store);
      const previousDays = await store.listPersonDays("alex");
      await totals(store, 1, 1);
      if (source === "exception") {
        github.collect.mockRejectedValueOnce(new Error("Access failed for fixture-github-token"));
      } else {
        for (const name of source === "both" ? (["github", "discord"] as const) : [source]) {
          const failure = { ...failedSource(name), stale: true };
          ({ github, discord })[name].collect.mockResolvedValueOnce(failure);
        }
      }
      vi.setSystemTime(Date.now() + 1_000);
      const run = await runById(store, await generate());
      expect(run?.status).toBe("error");
      if (source === "exception") {
        expect(run?.error).toBe("Access failed for [redacted]");
        expect(JSON.stringify(context.logger.error.mock.calls)).not.toContain(
          "fixture-github-token",
        );
        expect((await scheduler.health()).lastRun?.status).toBe("error");
      } else {
        for (const name of source === "both" ? ["github", "discord"] : [source]) {
          const id = `day/2026-08-19/${name}`;
          expect(run?.stats?.[id]).toMatchObject({ ok: false, stale: true });
          expect(run?.error).toContain(id);
        }
      }
      expect(context.logger.error).toHaveBeenCalledWith(`team-reports: ${run?.error}`);
      expect(context.serviceHealth.reportFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: run?.error }),
      );
      expect(await documents(store)).toEqual(previous);
      expect(await store.listPersonDays("alex")).toEqual(previousDays);

      github.collect.mockResolvedValueOnce(healthy);
      discord.collect.mockResolvedValueOnce(healthy);
      expect((await runById(store, await generate()))?.status).toBe("ok");
      await totals(store, 0, 0);
      expect(context.serviceHealth.clearFailure).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves only rollups overlapping a rejected day at month rollover", async () => {
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    const { generate, store, github, nextRun } = await setup({
      schedule: { weekly: true, monthly: true },
    });
    github.collect.mockResolvedValueOnce(failedSource("GitHub"));
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    await nextRun();
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
