import { MessageChannel } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { parseTeamReportsConfig } from "./config.js";
import { describePeriod } from "./periods.js";
import { completion } from "./reports.fixtures.js";
import type { ReportRunRequest } from "./run-worker-contract.js";
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

it.each([
  ["completion", new URL("./run-worker.test-support.ts", import.meta.url)],
  ["sqlite", new URL("./run-worker.collection.test-support.ts", import.meta.url)],
] as const)("joins accepted %s settlement after worker exit", (kind, workerUrl) =>
  withTempDir("team-reports-worker-settlement-", async (directory) => {
    const sqlite = kind === "sqlite";
    const entered = createDeferred<void>();
    const cancelled = createDeferred<void>();
    const released = createDeferred<void>();
    const exited = createDeferred<void>();
    workerExit.notify = () => exited.resolve();
    const runner = new TeamReportsRunner(workerUrl);
    const controller = new AbortController();
    const observeAbort = (signal?: AbortSignal) =>
      signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
    const hold = async () => {
      entered.resolve();
      await released.promise;
    };
    const store = sqlite
      ? await createTeamReportsStore({
          stateDir: directory,
          workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
        })
      : new TeamReportsStore({
          async execute() {
            throw new Error("This completion-only fixture must not access storage");
          },
          async close() {},
        });
    if (sqlite) {
      const execute = store.execute.bind(store);
      vi.spyOn(store, "execute").mockImplementation(async (...args) => {
        if (args[0] !== "upsertPeriod") {
          return execute(...args);
        }
        observeAbort(args[2]?.signal);
        const result = await execute(...args);
        // SQLite committed; the host still owns delivery of the accepted result.
        await hold();
        return result;
      });
    }
    const config = parseTeamReportsConfig({
      github: { token: "fixture", orgs: ["sample"] },
      people: [{ github: ["alex"] }],
      summaries: { enabled: true },
    });
    const complete = vi.fn(
      async ({ signal }: Parameters<ReportRunRequest["llm"]["complete"]>[0]) => {
        if (!sqlite) {
          observeAbort(signal);
          await hold();
        }
        return completion("Late result");
      },
    );
    let runSettled = false;
    let closeSettled = false;
    const pending = runner.run({
      config,
      store,
      periods: sqlite ? [describePeriod("day", "2026-08-19")] : [],
      resolved: {
        github: { ...config.github, token: "fixture", ignoreCommentPatterns: [] },
        people: config.people ?? [],
      },
      runtime: { signal: controller.signal, logger: { info() {}, warn() {}, error() {} } },
      onRoster() {},
      llm: { complete },
    });
    try {
      const rejected = expect(
        pending.finally(() => {
          runSettled = true;
        }),
      ).rejects.toThrow("Report cancelled");
      await entered.promise;
      controller.abort(new Error("Report cancelled"));
      const closing = runner.close().then(() => {
        closeSettled = true;
      });
      await Promise.all([cancelled.promise, exited.promise]);
      // Drain native-exit cleanup without a timer or polling.
      await nextMessageTurn();
      expect([runSettled, closeSettled]).toEqual([false, false]);
      if (sqlite) {
        expect(complete).not.toHaveBeenCalled();
      }
      released.resolve();
      await Promise.all([rejected, closing]);
      expect([runSettled, closeSettled]).toEqual([true, true]);
      if (sqlite) {
        expect((await store.getPeriod("day", "2026-08-19"))?.report.totals.github.commits).toBe(1);
        expect(complete).not.toHaveBeenCalled();
      }
    } finally {
      released.resolve();
      await runner.close();
      await store.close();
    }
  }),
);
