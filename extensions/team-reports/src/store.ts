import path from "node:path";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { TeamReportsOperations } from "./store-contract.js";
import type { Period } from "./types.js";

export type { PeriodListEntry, PersonDay } from "./store-contract.js";

export class TeamReportsStore {
  private closed = false;

  constructor(private readonly worker: SqliteWorkerStore<TeamReportsOperations>) {}

  private async execute<K extends keyof TeamReportsOperations>(
    type: K,
    input: TeamReportsOperations[K]["input"],
  ): Promise<TeamReportsOperations[K]["output"]> {
    if (this.closed) {
      throw new Error("Team Reports store is closed.");
    }
    return this.worker.execute({ type, input });
  }

  upsertPeriod(value: TeamReportsOperations["upsertPeriod"]["input"]) {
    return this.execute("upsertPeriod", value);
  }

  getPeriod(period: Period, key: string) {
    return this.execute("getPeriod", { period, key });
  }

  listPeriods(options: TeamReportsOperations["listPeriods"]["input"] = {}) {
    return this.execute("listPeriods", options);
  }

  getDayReports(sinceMs: number, untilMs: number) {
    return this.execute("getDayReports", { sinceMs, untilMs });
  }

  listPersonDays(
    login: string,
    options: TeamReportsOperations["listPersonDays"]["input"]["options"] = {},
  ) {
    return this.execute("listPersonDays", { login, options });
  }

  listPersonDaysSince(since: string) {
    return this.execute("listPersonDaysSince", since);
  }

  startRun(run: TeamReportsOperations["startRun"]["input"]) {
    return this.execute("startRun", run);
  }

  finishRun(id: string, result: TeamReportsOperations["finishRun"]["input"]["result"]) {
    return this.execute("finishRun", { id, result });
  }

  listRuns(limit = 20, filter: TeamReportsOperations["listRuns"]["input"]["filter"] = {}) {
    return this.execute("listRuns", { limit, filter });
  }

  prune(retentionDays: number, nowMs = Date.now()) {
    return this.execute("prune", { retentionDays, nowMs });
  }

  close(): Promise<void> {
    this.closed = true;
    return this.worker.close();
  }
}

export async function createTeamReportsStore(options: {
  workerModuleUrl: URL;
  stateDir?: string;
  dbPath?: string;
}): Promise<TeamReportsStore> {
  const databasePath =
    options.dbPath ??
    path.join(
      options.stateDir ?? resolveStateDir(),
      "plugins",
      "team-reports",
      "team-reports.sqlite",
    );
  const worker = await openSqliteWorkerStore<TeamReportsOperations>({
    moduleUrl: options.workerModuleUrl,
    databasePath,
    input: undefined,
  });
  return new TeamReportsStore(worker);
}
