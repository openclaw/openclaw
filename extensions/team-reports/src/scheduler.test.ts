import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTeamReportsConfig, type TeamReportsConfig } from "./config.js";
import { describePeriod } from "./periods.js";
import { completion, type Complete } from "./reports.fixtures.js";
import type { ReportSourceFactory, ResolvedTeamReportsConfig } from "./run.js";
import { TeamReportsScheduler } from "./scheduler.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";
import type { DiscordSource, GithubSource, SourceRuntime, SourceStatus } from "./types.js";

const resources: Array<{
  scheduler: TeamReportsScheduler;
  store: TeamReportsStore;
  directory: string;
}> = [];
const healthy: SourceStatus = { ok: true, warnings: [], stats: { apiCalls: 1 } };

async function setup(
  options: {
    stateDir?: string;
    schedule?: Partial<TeamReportsConfig["schedule"]>;
    summaries?: boolean;
    discord?: boolean;
    caughtUp?: false | "closed-day" | "manual" | "intraday";
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
      intradayEveryHours: 0,
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
  const store = await createTeamReportsStore({
    stateDir: directory,
    workerModuleUrl: new URL("./store.worker.ts", import.meta.url),
  });
  if (options.caughtUp !== false) {
    const yesterday = describePeriod("day", Date.now() - 86_400_000);
    await store.startRun({
      id: "previous-closed-day",
      kind: options.caughtUp ?? "closed-day",
      startedAtMs: yesterday.untilMs,
      periods: [{ period: "day", key: yesterday.key }],
    });
    await store.finishRun("previous-closed-day", { status: "ok", finishedAtMs: Date.now() });
  }
  const github = {
    loadRoster: vi
      .fn<GithubSource["loadRoster"]>()
      .mockResolvedValue({ people: [{ github: ["alex"] }], status: healthy }),
    collect: vi.fn<GithubSource["collect"]>().mockImplementation(async (_config, window) => ({
      items: [
        {
          kind: "commit",
          repo: "sample/widgets",
          title: "Correct widget resizing",
          url: `https://github.com/sample/widgets/commit/${window.sinceMs}`,
          actor: "alex",
          atMs: window.sinceMs + Math.floor((window.untilMs - window.sinceMs) / 2),
        },
      ],
      status: healthy,
    })),
  };
  const discord = {
    collect: vi.fn<DiscordSource["collect"]>().mockImplementation(async (_config, window) => ({
      messages: [
        {
          channelId: "200",
          parentChannelId: "200",
          channelName: "engineering",
          authorId: "300",
          authorIsBot: false,
          atMs: window.sinceMs + 1,
          content: "Widget resizing is ready for review.",
        },
      ],
      status: healthy,
    })),
  };
  const runtimes: SourceRuntime[] = [];
  const sources: ReportSourceFactory = (runtime) => {
    runtimes.push(runtime);
    return { github, discord };
  };
  const complete = vi.fn<Complete>().mockRejectedValue(new Error("Unexpected model request"));
  const completions: Array<ReturnType<typeof createDeferred<void>>> = [];
  let published = 0;
  let consumed = 0;
  const completionAt = (index: number) => (completions[index] ??= createDeferred<void>());
  const runSettled = () => completionAt(published++).resolve();
  const nextRun = () => completionAt(consumed++).promise;
  const context = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    serviceHealth: { reportFailure: vi.fn(runSettled), clearFailure: vi.fn(runSettled) },
  };
  const scheduler = new TeamReportsScheduler({
    config,
    resolved,
    store,
    llm: { complete, acquireLocalService: vi.fn(async () => undefined) },
    context,
    sources,
  });
  resources.push({ directory, store, scheduler });
  return {
    scheduler,
    store,
    directory,
    config,
    github,
    discord,
    complete,
    context,
    runtimes,
    nextRun,
  };
}

function modelResponse(): Awaited<ReturnType<Complete>> {
  return completion(
    JSON.stringify({
      globalSummary:
        "Widget resizing was corrected. One member recorded activity.\n\n- **Widgets:** Resize correction.\n- **Reviews:** No review comments recorded.\n- **Discord:** No messages recorded.\n- **Coverage:** Configured GitHub sources collected.",
      highlights: [
        "Widget resizing corrected.",
        "One member active.",
        "No review comments recorded.",
        "GitHub coverage completed.",
      ],
      members: [
        {
          login: "alex",
          summary: "Corrected widget resizing in sample/widgets.",
          confidence: "high",
        },
      ],
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
  it.each([
    { random: 0, expected: "2026-08-20T00:05:00Z" },
    { random: 0.5, expected: "2026-08-20T00:07:30Z" },
    { random: 1, expected: "2026-08-20T00:10:00Z" },
  ])("keeps closed-day jitter in the configured window ($random)", async ({ random, expected }) => {
    vi.spyOn(Math, "random").mockReturnValue(random);
    for (const [now, expectedDue] of [
      ["2026-08-20T00:00:00Z", Date.parse(expected)],
      ["2026-08-20T00:11:00Z", Date.parse(expected) + 86_400_000],
    ] as const) {
      vi.setSystemTime(new Date(now));
      const { scheduler } = await setup({ schedule: { closedDayUtc: "00:05", jitterMinutes: 5 } });
      await scheduler.start();
      expect((await scheduler.status()).nextDue.closedDay).toBe(expectedDue);
    }
  });

  it.each([
    { now: "2026-08-20T02:15:00Z", hours: 4, expected: "2026-08-20T04:00:00Z" },
    { now: "2026-08-20T04:00:00Z", hours: 4, expected: "2026-08-20T08:00:00Z" },
    { now: "2026-08-20T23:59:59Z", hours: 4, expected: "2026-08-21T00:00:00Z" },
    { now: "2026-08-20T21:00:00Z", hours: 5, expected: "2026-08-21T00:00:00Z" },
    { now: "2026-08-20T02:15:00Z", hours: 0, expected: undefined },
  ])(
    "aligns intraday refreshes to UTC boundaries ($now, $hours)",
    async ({ now, hours, expected }) => {
      vi.setSystemTime(new Date(now));
      const { scheduler } = await setup({ schedule: { intradayEveryHours: hours } });
      await scheduler.start();
      expect((await scheduler.status()).nextDue.intraday).toBe(
        expected ? Date.parse(expected) : undefined,
      );
    },
  );

  it("does not schedule another closed-day run today when the next jitter sample is larger", async () => {
    vi.setSystemTime(new Date("2026-08-20T00:04:00Z"));
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(1);
    const { scheduler, store, nextRun } = await setup({
      schedule: { closedDayUtc: "00:05", jitterMinutes: 5 },
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await nextRun();
    expect((await store.listRuns()).filter((run) => run.id !== "previous-closed-day")).toHaveLength(
      1,
    );
    expect((await scheduler.status()).nextDue.closedDay).toBe(Date.parse("2026-08-21T00:10:00Z"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect((await store.listRuns()).filter((run) => run.id !== "previous-closed-day")).toHaveLength(
      1,
    );
  });
});

describe("Team Reports scheduler lifecycle", () => {
  it("reserves the run while admission is pending and returns its ID only after persistence", async () => {
    const { scheduler, store, github } = await setup();
    await scheduler.start();
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
    const { scheduler, nextRun, store, github } = await setup();
    await scheduler.start();
    vi.spyOn(store, "startRun").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(scheduler.generate()).rejects.toThrow("database unavailable");
    expect(github.loadRoster).not.toHaveBeenCalled();
    await nextRun();
    const id = await scheduler.generate();
    await nextRun();
    expect((await store.listRuns()).find((run) => run.id === id)?.status).toBe("ok");
  });

  it("drains an admitted report write after cancellation before closing storage or starting summaries", async () => {
    const { scheduler, store, directory, complete } = await setup({ summaries: true });
    await scheduler.start();
    const write = createDeferred<void>();
    const entered = createDeferred<void>();
    const upsertPeriod = store.upsertPeriod.bind(store);
    vi.spyOn(store, "upsertPeriod").mockImplementationOnce(async (period) => {
      entered.resolve();
      await write.promise;
      await upsertPeriod(period);
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
    const reopened = await createTeamReportsStore({
      stateDir: directory,
      workerModuleUrl: new URL("./store.worker.ts", import.meta.url),
    });
    try {
      expect((await reopened.getPeriod("day", "2026-08-19"))?.report.totals.github.total).toBe(1);
      expect((await reopened.listRuns()).find((run) => run.id === id)).toMatchObject({
        status: "error",
        error: expect.stringContaining("30 seconds"),
      });
    } finally {
      await reopened.close();
    }
  });

  it("waits for pending startup reads and asynchronous storage disposal during stop", async () => {
    const { scheduler, store } = await setup();
    const read = createDeferred<void>();
    const disposal = createDeferred<void>();
    const listRuns = store.listRuns.bind(store);
    vi.spyOn(store, "listRuns").mockImplementationOnce(async (...args) => {
      await read.promise;
      return await listRuns(...args);
    });
    const closeStore = store.close.bind(store);
    const close = vi.spyOn(store, "close").mockImplementation(async () => {
      await disposal.promise;
      await closeStore();
    });
    const started = scheduler.start();
    const completed = vi.fn();
    const stopped = scheduler.stop().then(completed);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(close).not.toHaveBeenCalled();
      read.resolve();
      await started;
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledOnce();
      expect(completed).not.toHaveBeenCalled();
      await expect(scheduler.start()).rejects.toThrow("cannot be started again");
    } finally {
      read.resolve();
      disposal.resolve();
      await Promise.all([started, stopped]);
    }
    await expect(scheduler.generate()).rejects.toThrow("not running");
  });

  it("reports the earliest due time and last completed run while another run is active", async () => {
    const { scheduler, github, nextRun } = await setup({
      caughtUp: false,
      schedule: { intradayEveryHours: 4 },
    });
    expect(await scheduler.health()).toEqual({ running: false, warnings: 0 });
    await scheduler.start();
    expect(await scheduler.health()).toEqual({
      running: true,
      nextDueMs: Date.parse("2026-08-20T12:01:00Z"),
      warnings: 0,
    });
    const firstCollection = createDeferred<Awaited<ReturnType<GithubSource["collect"]>>>();
    github.collect.mockImplementationOnce(() => firstCollection.promise);
    await scheduler.generate();
    expect((await scheduler.health()).lastRun).toBeUndefined();
    firstCollection.resolve({ items: [], status: healthy });
    await nextRun();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await scheduler.health()).toEqual({
      running: true,
      lastRun: { status: "ok", kind: "manual", finishedAtMs: Date.parse("2026-08-20T12:00:00Z") },
      nextDueMs: Date.parse("2026-08-20T16:00:00Z"),
      warnings: 0,
    });
    const blocked = createDeferred<Awaited<ReturnType<GithubSource["collect"]>>>();
    github.collect.mockImplementationOnce(() => blocked.promise);
    await scheduler.generate({ intraday: true });
    await vi.advanceTimersByTimeAsync(0);
    expect((await scheduler.health()).lastRun).toEqual({
      status: "ok",
      kind: "manual",
      finishedAtMs: Date.parse("2026-08-20T12:00:00Z"),
    });
    blocked.resolve({ items: [], status: healthy });
    await nextRun();
    expect((await scheduler.health()).lastRun?.finishedAtMs).toBe(
      Date.parse("2026-08-20T12:01:00Z"),
    );
  });

  it("catches up yesterday once after the startup delay and also publishes today's partial", async () => {
    const { scheduler, store, github, nextRun } = await setup({ caughtUp: false });
    await scheduler.start();
    expect((await scheduler.status()).nextDue.catchUp).toBe(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(github.collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await nextRun();
    expect(await store.listRuns()).toMatchObject([{ kind: "closed-day", status: "ok" }]);
    expect(await store.listPeriods()).toMatchObject([
      { period: "day", key: "2026-08-20", status: "partial" },
      { period: "day", key: "2026-08-19", status: "closed" },
    ]);
    expect((await scheduler.status()).nextDue.catchUp).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(github.collect).toHaveBeenCalledTimes(2);
  });

  it.each(["closed-day", "manual"] as const)(
    "skips startup catch-up when yesterday has a successful %s run started at close before newer unrelated runs",
    async (kind) => {
      const { scheduler, store, github } = await setup({ caughtUp: kind });
      for (let index = 0; index < 21; index++) {
        const id = `newer-${index}`;
        await store.startRun({
          id,
          kind: "manual",
          startedAtMs: Date.now() - index,
          periods: [{ period: "day", key: "2026-08-18" }],
        });
        await store.finishRun(id, { status: "ok", finishedAtMs: Date.now() });
      }
      await scheduler.start();
      expect((await scheduler.status()).nextDue.catchUp).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(github.collect).not.toHaveBeenCalled();
      expect(await store.listRuns(-1)).toHaveLength(22);
    },
  );

  it.each(["intraday", "manual", "closed-day"] as const)(
    "catches up after rollover despite a successful %s run covering today's partial window",
    async (kind) => {
      vi.setSystemTime(new Date("2026-08-20T11:59:00Z"));
      const first = await setup({
        schedule: {
          intradayEveryHours: kind === "intraday" ? 4 : 0,
          closedDayUtc: kind === "closed-day" ? "12:00" : "23:59",
        },
      });
      await first.scheduler.start();
      if (kind === "manual") {
        await first.scheduler.generate({ intraday: true });
      }
      await vi.advanceTimersByTimeAsync(60_000);
      await first.nextRun();
      expect((await first.store.listRuns())[0]).toMatchObject({
        kind,
        status: "ok",
        periods: expect.arrayContaining([{ period: "day", key: "2026-08-20" }]),
      });
      expect((await first.store.getPeriod("day", "2026-08-20"))?.report.status).toBe("partial");
      await first.scheduler.stop();

      vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
      const restarted = await setup({ stateDir: first.directory, caughtUp: false });
      await restarted.scheduler.start();
      expect((await restarted.scheduler.status()).nextDue.catchUp).toBe(Date.now() + 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await restarted.nextRun();
      expect(restarted.github.collect).toHaveBeenCalledTimes(2);
      expect(restarted.github.collect.mock.calls[0]?.[1]).toEqual({
        sinceMs: Date.parse("2026-08-20T00:00:00Z"),
        untilMs: Date.parse("2026-08-21T00:00:00Z"),
      });
      expect((await restarted.store.getPeriod("day", "2026-08-20"))?.report.status).toBe("closed");
    },
  );

  it("skips deferred catch-up after a manual run completes yesterday", async () => {
    const { scheduler, nextRun, store, github } = await setup({ caughtUp: false });
    const blocked = createDeferred<Awaited<ReturnType<GithubSource["collect"]>>>();
    const collecting = createDeferred<void>();
    github.collect.mockImplementationOnce(() => {
      collecting.resolve();
      return blocked.promise;
    });
    await scheduler.start();
    const id = await scheduler.generate({ date: "2026-08-19" });
    await collecting.promise;
    await vi.advanceTimersByTimeAsync(19 * 60_000);
    expect(github.collect).toHaveBeenCalledOnce();
    expect(await store.listRuns()).toMatchObject([{ id, kind: "manual", status: "running" }]);
    blocked.resolve({ items: [], status: healthy });
    await nextRun();
    expect(await store.listRuns()).toMatchObject([{ id, kind: "manual", status: "ok" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(github.collect).toHaveBeenCalledOnce();
    expect(await store.listRuns()).toHaveLength(1);
  });

  it("rejects a concurrent manual run and defers an intraday tick without overlapping collectors", async () => {
    vi.setSystemTime(new Date("2026-08-20T03:59:00Z"));
    const { scheduler, store, github, nextRun } = await setup({
      schedule: { intradayEveryHours: 4 },
    });
    const blocked = createDeferred<Awaited<ReturnType<GithubSource["collect"]>>>();
    const collecting = createDeferred<void>();
    github.collect.mockImplementationOnce(() => {
      collecting.resolve();
      return blocked.promise;
    });
    await scheduler.start();
    const id = await scheduler.generate({ intraday: true });
    await expect(scheduler.generate()).rejects.toThrow("already in progress");
    await collecting.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(github.collect).toHaveBeenCalledOnce();
    expect((await store.listRuns()).find((run) => run.id === id)?.status).toBe("running");
    blocked.resolve({ items: [], status: healthy });
    await nextRun();
    expect((await store.listRuns()).find((run) => run.id === id)?.status).toBe("ok");
    await vi.advanceTimersByTimeAsync(60_000);
    await nextRun();
    expect(github.collect).toHaveBeenCalledTimes(2);
    expect(
      (await store.listRuns()).some((run) => run.kind === "intraday" && run.status === "ok"),
    ).toBe(true);
    expect((await scheduler.status()).nextDue.intraday).toBe(Date.parse("2026-08-20T08:00:00Z"));
  });

  it("waits for an in-flight run during stop and preserves its successful report", async () => {
    const { scheduler, github, directory } = await setup();
    const blocked = createDeferred<Awaited<ReturnType<GithubSource["collect"]>>>();
    github.collect.mockImplementationOnce(() => blocked.promise);
    await scheduler.start();
    const id = await scheduler.generate();
    await vi.advanceTimersByTimeAsync(0);
    let finished = false;
    const stopped = scheduler.stop().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finished).toBe(false);
    await expect(scheduler.generate()).rejects.toThrow("not running");
    blocked.resolve({ items: [], status: healthy });
    await stopped;
    expect(finished).toBe(true);
    const reopened = await createTeamReportsStore({
      stateDir: directory,
      workerModuleUrl: new URL("./store.worker.ts", import.meta.url),
    });
    try {
      expect((await reopened.listRuns()).find((run) => run.id === id)?.status).toBe("ok");
      expect((await reopened.getPeriod("day", "2026-08-19"))?.report.status).toBe("closed");
    } finally {
      await reopened.close();
    }
  });

  it("aborts after the 30-second stop bound and fences a late collector from the closed store", async () => {
    const { scheduler, github, directory, runtimes } = await setup();
    const blocked = createDeferred<Awaited<ReturnType<GithubSource["collect"]>>>();
    github.collect.mockImplementationOnce(() => blocked.promise);
    await scheduler.start();
    const id = await scheduler.generate();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = scheduler.stop();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runtimes[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(runtimes[0]?.signal?.aborted).toBe(true);
    blocked.resolve({ items: [], status: healthy });
    await vi.advanceTimersByTimeAsync(0);
    const reopened = await createTeamReportsStore({
      stateDir: directory,
      workerModuleUrl: new URL("./store.worker.ts", import.meta.url),
    });
    try {
      expect((await reopened.listRuns()).find((run) => run.id === id)).toMatchObject({
        status: "error",
        error: expect.stringContaining("30 seconds"),
      });
      expect(await reopened.listPeriods()).toEqual([]);
    } finally {
      await reopened.close();
    }
  });

  it("passes the 45-minute deadline abort to sources and records a failed run without late writes", async () => {
    const { scheduler, github, runtimes, store, context, nextRun } = await setup();
    const blocked = createDeferred<Awaited<ReturnType<GithubSource["collect"]>>>();
    github.collect.mockImplementationOnce(() => blocked.promise);
    await scheduler.start();
    const id = await scheduler.generate();
    await vi.advanceTimersByTimeAsync(45 * 60_000 - 1);
    expect(runtimes[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtimes[0]?.signal?.aborted).toBe(true);
    await nextRun();
    expect((await store.listRuns()).find((run) => run.id === id)).toMatchObject({
      status: "error",
      error: expect.stringContaining("45-minute"),
    });
    expect(context.serviceHealth.reportFailure).toHaveBeenCalledOnce();
    blocked.resolve({ items: [], status: healthy });
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.listPeriods()).toEqual([]);
  });

  it("makes collected evidence readable while model summaries are still pending", async () => {
    const { scheduler, store, complete, nextRun } = await setup({ summaries: true });
    const blocked = createDeferred<Awaited<ReturnType<Complete>>>();
    const summarizing = createDeferred<void>();
    complete.mockImplementation(() => {
      summarizing.resolve();
      return blocked.promise;
    });
    await scheduler.start();
    const id = await scheduler.generate();
    await summarizing.promise;
    const before = await store.getPeriod("day", "2026-08-19");
    expect(before?.report.totals.github.total).toBe(1);
    expect(before?.summary?.source).toBe("fallback");
    expect((await store.listRuns()).find((run) => run.id === id)?.status).toBe("running");
    blocked.resolve(modelResponse());
    await nextRun();
    expect((await store.getPeriod("day", "2026-08-19"))?.summary?.source).toBe("model");
    expect((await store.listRuns()).find((run) => run.id === id)?.status).toBe("ok");
  });

  it("surfaces the latest day's model fallback in status, storage, Markdown, and logs", async () => {
    const { scheduler, nextRun, store, context, complete, github } = await setup({
      summaries: true,
    });
    github.loadRoster.mockResolvedValue({
      people: [{ github: ["alex"] }],
      status: { ...healthy, warnings: ["Roster coverage warning"] },
    });
    complete.mockRejectedValue(new Error("private-provider-error-marker"));
    await scheduler.start();
    await scheduler.generate();
    await nextRun();
    const reason = "Model summary unavailable: completion failed";
    const stored = await store.getPeriod("day", "2026-08-19");
    expect(stored?.summary?.warnings).toEqual([reason]);
    expect(stored?.markdown).toContain(`> ${reason}`);
    expect((await scheduler.status()).sourceWarnings).toEqual(["Roster coverage warning", reason]);
    expect((await scheduler.health()).warnings).toBe(2);
    expect(context.logger.warn.mock.calls).toEqual([[reason]]);
    complete.mockResolvedValue(modelResponse());
    await scheduler.generate({ intraday: true });
    await nextRun();
    expect((await scheduler.status()).sourceWarnings).toEqual(["Roster coverage warning"]);
    expect((await scheduler.health()).warnings).toBe(1);
  });

  it("reports source failures with redacted errors and clears health on the next successful run", async () => {
    const { scheduler, nextRun, store, github, context } = await setup();
    github.collect.mockRejectedValueOnce(new Error("Access failed for fixture-github-token"));
    await scheduler.start();
    const failed = await scheduler.generate();
    await nextRun();
    expect((await store.listRuns()).find((run) => run.id === failed)).toMatchObject({
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
    const succeeded = await scheduler.generate();
    await nextRun();
    expect((await store.listRuns()).find((run) => run.id === succeeded)?.status).toBe("ok");
    expect(context.serviceHealth.clearFailure).toHaveBeenCalledOnce();
  });

  it.each([false, true])("collects Discord only when configured (enabled: %s)", async (enabled) => {
    const { scheduler, nextRun, discord, store, complete } = await setup({ discord: enabled });
    await scheduler.start();
    await scheduler.generate();
    await nextRun();
    expect(discord.collect).toHaveBeenCalledTimes(enabled ? 1 : 0);
    const generated = await store.getPeriod("day", "2026-08-19");
    expect(generated?.report.totals.discord.messages).toBe(enabled ? 1 : 0);
    expect(generated?.report.sources.discord?.ok).toBe(enabled ? true : undefined);
    expect(complete).not.toHaveBeenCalled();
  });

  it("closes the prior week and month while opening the current periods at calendar rollover", async () => {
    vi.setSystemTime(new Date("2026-06-01T00:04:00Z"));
    const { scheduler, store, github, nextRun } = await setup({
      caughtUp: "manual",
      schedule: { closedDayUtc: "00:05", weekly: true, monthly: true },
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await nextRun();
    expect(github.collect).toHaveBeenCalledTimes(2);
    expect(await store.listPeriods()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ period: "day", key: "2026-05-31", status: "closed" }),
        expect.objectContaining({ period: "day", key: "2026-06-01", status: "partial" }),
        expect.objectContaining({ period: "week", key: "2026-W22", status: "closed" }),
        expect.objectContaining({ period: "week", key: "2026-W23", status: "partial" }),
        expect.objectContaining({ period: "month", key: "2026-05", status: "closed" }),
        expect.objectContaining({ period: "month", key: "2026-06", status: "partial" }),
      ]),
    );
    expect((await store.getPeriod("week", "2026-W22"))?.report.totals.github.total).toBe(1);
    expect((await store.getPeriod("month", "2026-06"))?.report.totals.github.total).toBe(1);
  });
});
