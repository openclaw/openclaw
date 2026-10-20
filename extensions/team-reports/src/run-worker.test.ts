import { MessageChannel } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { parseTeamReportsConfig } from "./config.js";
import { describePeriod } from "./periods.js";
import { completion } from "./reports.fixtures.js";
import { TeamReportsRunner } from "./run-worker.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore, TeamReportsStore } from "./store.js";

const workerExit = vi.hoisted(() => ({ notify: () => {} }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        this.once("exit", () => workerExit.notify());
      }
    },
  };
});
afterEach(() => {
  workerExit.notify = () => {};
  vi.restoreAllMocks();
});

async function nextMessageTurn() {
  await new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.once("message", () => {
      port1.close();
      port2.close();
      resolve();
    });
    port2.postMessage(null);
  });
}

it("joins an accepted host completion after the report worker has exited", async () => {
  const entered = createDeferred<void>();
  const cancelled = createDeferred<void>();
  const released = createDeferred<void>();
  const exited = createDeferred<void>();
  workerExit.notify = () => exited.resolve();
  const runner = new TeamReportsRunner(new URL("./run-worker.test-support.ts", import.meta.url));
  const controller = new AbortController();
  const config = parseTeamReportsConfig({ github: { token: "fixture", orgs: ["sample"] } });
  const store = new TeamReportsStore({
    async execute() {
      throw new Error("This completion-only fixture must not access storage");
    },
    async close() {},
  });
  let runSettled = false;
  let closeSettled = false;
  const pending = runner
    .run({
      config,
      resolved: {
        github: { ...config.github, token: "fixture", ignoreCommentPatterns: [] },
        people: [],
      },
      store,
      periods: [],
      runtime: { signal: controller.signal, logger: { info() {}, warn() {}, error() {} } },
      onRoster() {},
      llm: {
        complete: async ({ signal }) => {
          signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
          entered.resolve();
          await released.promise;
          return completion("Late result");
        },
      },
    })
    .finally(() => {
      runSettled = true;
    });
  const rejected = expect(pending).rejects.toThrow("Report cancelled");
  try {
    await entered.promise;
    controller.abort(new Error("Report cancelled"));
    const closing = runner.close().then(() => {
      closeSettled = true;
    });
    await Promise.all([cancelled.promise, exited.promise]);
    // Let native-exit cleanup drain through one message turn, without a timer or polling.
    await nextMessageTurn();
    expect(runSettled).toBe(false);
    expect(closeSettled).toBe(false);
    released.resolve();
    await Promise.all([rejected, closing]);
    expect(runSettled).toBe(true);
    expect(closeSettled).toBe(true);
  } finally {
    released.resolve();
    await runner.close();
  }
});

it("joins accepted SQLite result settlement after cancelling the real collection worker", async () => {
  await withTempDir("team-reports-worker-settlement-", async (directory) => {
    const entered = createDeferred<void>();
    const cancelled = createDeferred<void>();
    const released = createDeferred<void>();
    const exited = createDeferred<void>();
    workerExit.notify = () => exited.resolve();
    const runner = new TeamReportsRunner(
      new URL("./run-worker.collection.test-support.ts", import.meta.url),
    );
    const store = await createTeamReportsStore({
      stateDir: directory,
      workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
    });
    const execute = store.execute.bind(store);
    vi.spyOn(store, "execute").mockImplementation(async (...args) => {
      if (args[0] !== "upsertPeriod") {
        return execute(...args);
      }
      args[2]?.signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
      const result = await execute(...args);
      // SQLite has committed; the host still owns delivery/settlement of this accepted result.
      entered.resolve();
      await released.promise;
      return result;
    });
    const controller = new AbortController();
    const config = parseTeamReportsConfig({
      github: { token: "fixture", orgs: ["sample"] },
      people: [{ github: ["alex"] }],
      summaries: { enabled: true },
    });
    const complete = vi.fn(async () => completion("Unexpected late summary"));
    let runSettled = false;
    let closeSettled = false;
    const pending = runner
      .run({
        config,
        resolved: {
          github: { ...config.github, token: "fixture", ignoreCommentPatterns: [] },
          people: config.people ?? [],
        },
        store,
        periods: [describePeriod("day", "2026-08-19")],
        runtime: { signal: controller.signal, logger: { info() {}, warn() {}, error() {} } },
        onRoster() {},
        llm: { complete },
      })
      .finally(() => {
        runSettled = true;
      });
    const rejected = expect(pending).rejects.toThrow("Report cancelled");
    try {
      await entered.promise;
      controller.abort(new Error("Report cancelled"));
      const closing = runner.close().then(() => {
        closeSettled = true;
      });
      await Promise.all([cancelled.promise, exited.promise]);
      await nextMessageTurn();
      expect(runSettled).toBe(false);
      expect(closeSettled).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      released.resolve();
      await Promise.all([rejected, closing]);
      expect(runSettled).toBe(true);
      expect(closeSettled).toBe(true);
      expect((await store.getPeriod("day", "2026-08-19"))?.report.totals.github.commits).toBe(1);
      expect(complete).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await runner.close();
      await store.close();
    }
  });
});
