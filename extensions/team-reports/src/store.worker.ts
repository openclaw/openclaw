import {
  jsonPathValue,
  runEngineStoreReadSnapshot,
  runEngineWorkerWrite,
  withEngineStoreAdmission,
  type DatabaseEngineInput,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  requestSqliteWorkerOperationAdmission,
  runSqliteImmediateTransactionSync,
  type SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { aggregateDay, aggregateDays, itemKey } from "./aggregate.js";
import { MAX_REPORT_BYTES } from "./limits.js";
import { DAY_MS } from "./periods.js";
import type {
  PeriodListEntry,
  PersonDay,
  ReportRun,
  StoredPeriod,
  TeamReportsOperations,
} from "./store-contract.js";
import { TEAM_REPORTS_WRITES } from "./store-contract.js";
import { openTeamReportsConnection } from "./store-database.js";
import {
  reportDocumentSchema,
  runPeriodsSchema,
  runStatsSchema,
  summaryDocumentSchema,
} from "./store-schema.js";
import type { DiscordMessage, GithubItem, Period, ReportDocument } from "./types.js";

// Bound each 12-column person-day insert to 768 parameters.
const PERSON_DAY_INSERT_BATCH_SIZE = 64;
type PeriodRow = {
  period: Period;
  period_key: string;
  since_ms: number;
  until_ms: number;
  status: "partial" | "closed";
  generated_at_ms: number;
  data_json: string;
  summary_json: string | null;
  markdown: string;
};
type PersonDayRow = {
  day_key: string;
  login: string;
  github_total: number;
  commits: number;
  prs_opened: number;
  prs_merged: number;
  prs_closed: number;
  issues_opened: number;
  issues_closed: number;
  issue_comments: number;
  review_comments: number;
  discord_messages: number;
};
type RunRow = {
  id: string;
  kind: ReportRun["kind"];
  started_at_ms: number;
  finished_at_ms: number | null;
  status: ReportRun["status"];
  periods_json: string;
  stats_json: string | null;
  error: string | null;
};
type ActivityRow = {
  source: "github" | "discord";
  key: string;
  at_ms: number;
  sort_key: string;
  actor: string;
  data_json: string;
};
type ReportsDatabase = {
  team_reports_activity: ActivityRow;
  team_reports_schema_migrations: { id: string; applied_at: number };
  team_reports_periods: PeriodRow;
  team_reports_person_days: PersonDayRow;
  team_reports_runs: RunRow;
};

function readPeriod(row: Pick<PeriodRow, "data_json" | "summary_json">) {
  return {
    report: reportDocumentSchema.parse(JSON.parse(row.data_json)),
    summary:
      row.summary_json === null ? null : summaryDocumentSchema.parse(JSON.parse(row.summary_json)),
  };
}

class TeamReportsDatabase {
  private readonly query;

  constructor(
    private readonly db: EngineConnection,
    readonly close: () => void,
    input: DatabaseEngineInput,
  ) {
    this.query = getNodeSqliteKysely<ReportsDatabase>(db);
    // Collection scratch belongs to this connection; restart/close discards it.
    withEngineStoreAdmission(() =>
      db.exec(`CREATE TEMP TABLE team_reports_activity (
      source TEXT NOT NULL, key TEXT NOT NULL, at_ms ${input ? "BIGINT" : "INTEGER"} NOT NULL,
      sort_key TEXT NOT NULL, actor TEXT NOT NULL, data_json TEXT NOT NULL,
      PRIMARY KEY (source, key)
    )${input ? " ON COMMIT PRESERVE ROWS" : " STRICT"};`),
    );
  }

  resetActivity(): void {
    executeSqliteQuerySync(this.db, this.query.deleteFrom("team_reports_activity"));
  }

  appendActivity(input: TeamReportsOperations["appendActivity"]["input"]): void {
    if (input.entries.length === 0) {
      return;
    }
    if (input.entries.length > 100) {
      throw new Error("Activity batch exceeds 100 entries");
    }
    const rows: ActivityRow[] =
      input.source === "github"
        ? input.entries.map(({ key, value }) => ({
            source: input.source,
            key,
            at_ms: value.atMs,
            sort_key: itemKey(value),
            actor: value.actor,
            data_json: JSON.stringify(value),
          }))
        : input.entries.map(({ key, value }) => ({
            source: input.source,
            key,
            at_ms: value.atMs,
            sort_key: value.channelId,
            actor: value.authorId,
            data_json: JSON.stringify(value),
          }));
    executeSqliteQuerySync(
      this.db,
      this.query
        .insertInto("team_reports_activity")
        .values(rows)
        .onConflict((conflict) =>
          conflict.columns(["source", "key"]).doUpdateSet((eb) => ({
            at_ms: eb.ref("excluded.at_ms"),
            sort_key: eb.ref("excluded.sort_key"),
            actor: eb.ref("excluded.actor"),
            data_json: eb.ref("excluded.data_json"),
          })),
        ),
    );
  }

  private *activity<T extends GithubItem | DiscordMessage>(
    source: "github" | "discord",
  ): Generator<T> {
    // Sort compact identities with the same JS collation as report evidence.
    // Payloads (especially comment bodies) are decoded only 100 rows at a time.
    const order = executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("team_reports_activity")
        .select(["key", "at_ms", "sort_key", "actor"])
        .where("source", "=", source)
        .orderBy("key"),
    ).rows;
    order.sort(
      (a, b) =>
        b.at_ms - a.at_ms ||
        a.sort_key.localeCompare(b.sort_key) ||
        a.actor.localeCompare(b.actor) ||
        a.key.localeCompare(b.key),
    );
    for (let offset = 0; offset < order.length; offset += 100) {
      const keys = order.slice(offset, offset + 100).map((row) => row.key);
      const rows = executeSqliteQuerySync(
        this.db,
        this.query
          .selectFrom("team_reports_activity")
          .select(["key", "data_json"])
          .where("source", "=", source)
          .where("key", "in", keys),
      ).rows;
      const data = new Map(rows.map((row) => [row.key, row.data_json]));
      for (const key of keys) {
        const json = data.get(key);
        if (json === undefined) {
          throw new Error("Collected activity disappeared before aggregation");
        }
        // SAFETY: appendActivity serializes this source's typed values in our connection-owned table.
        yield JSON.parse(json) as T;
      }
    }
  }

  aggregateActivity(input: TeamReportsOperations["aggregateActivity"]["input"]): ReportDocument {
    return aggregateDay({
      ...input,
      items: this.activity<GithubItem>("github"),
      messages: this.activity<DiscordMessage>("discord"),
    });
  }

  aggregatePeriod(input: TeamReportsOperations["aggregatePeriod"]["input"]): ReportDocument {
    // Stream accepted daily reports from one snapshot without retaining their full payloads.
    return runEngineStoreReadSnapshot(this.db, () =>
      aggregateDays({
        ...input,
        days: this.dayReports(input.period.sinceMs, input.period.untilMs),
      }),
    );
  }

  upsertPeriod(value: TeamReportsOperations["upsertPeriod"]["input"]): void {
    const { report } = value;
    const dataJson = JSON.stringify(report);
    if (Buffer.byteLength(dataJson, "utf8") > MAX_REPORT_BYTES) {
      throw new Error("Team Reports document exceeds the 2 MiB storage limit.");
    }
    const row: PeriodRow = {
      period: report.period.period,
      period_key: report.period.key,
      since_ms: report.period.sinceMs,
      until_ms: report.period.untilMs,
      status: report.status,
      generated_at_ms: report.generatedAtMs,
      data_json: dataJson,
      summary_json: value.summary ? JSON.stringify(value.summary) : null,
      markdown: value.markdown,
    };
    const people: PersonDayRow[] = report.members.map((member) => ({
      day_key: report.period.key,
      login: member.login.toLowerCase(),
      github_total: member.github.total,
      commits: member.github.commits,
      prs_opened: member.github.prsOpened,
      prs_merged: member.github.prsMerged,
      prs_closed: member.github.prsClosed,
      issues_opened: member.github.issuesOpened,
      issues_closed: member.github.issuesClosed,
      issue_comments: member.github.issueComments,
      review_comments: member.github.reviewComments,
      discord_messages: member.discord.total,
    }));
    runSqliteImmediateTransactionSync(this.db, () => {
      executeSqliteQuerySync(
        this.db,
        this.query
          .insertInto("team_reports_periods")
          .values(row)
          .onConflict((conflict) => conflict.columns(["period", "period_key"]).doUpdateSet(row)),
      );
      if (report.period.period === "day") {
        // Replacing the whole day also removes people excluded by a refreshed roster.
        executeSqliteQuerySync(
          this.db,
          this.query
            .deleteFrom("team_reports_person_days")
            .where("day_key", "=", report.period.key),
        );
        for (let start = 0; start < people.length; start += PERSON_DAY_INSERT_BATCH_SIZE) {
          executeSqliteQuerySync(
            this.db,
            this.query
              .insertInto("team_reports_person_days")
              .values(people.slice(start, start + PERSON_DAY_INSERT_BATCH_SIZE)),
          );
        }
      }
    });
  }

  getPeriod(period: Period, key: string): StoredPeriod | undefined {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.selectPeriodDocument(period, key).select("markdown"),
    );
    return row ? { ...readPeriod(row), markdown: row.markdown } : undefined;
  }

  getPeriodDocument(period: Period, key: string) {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.selectPeriodDocument(period, key));
    return row ? readPeriod(row) : undefined;
  }

  private selectPeriodDocument(period: Period, key: string) {
    return (
      this.query
        .selectFrom("team_reports_periods")
        // Retain native scalar decoding before validating the complete report and summary.
        .select([
          "period",
          "period_key",
          "since_ms",
          "until_ms",
          "status",
          "generated_at_ms",
          "data_json",
          "summary_json",
        ])
        .where("period", "=", period)
        .where("period_key", "=", key)
    );
  }

  listPeriods(options: TeamReportsOperations["listPeriods"]["input"] = {}): PeriodListEntry[] {
    let query = this.selectPeriods();
    if (options.period) {
      query = query.where("period", "=", options.period);
    }
    if (options.status) {
      query = query.where("status", "=", options.status);
    }
    return executeSqliteQuerySync(this.db, query.limit(options.limit ?? 180)).rows;
  }

  private selectPeriods() {
    return (
      this.query
        .selectFrom("team_reports_periods")
        .select([
          "period",
          "period_key as key",
          "since_ms as sinceMs",
          "until_ms as untilMs",
          "status",
          "generated_at_ms as generatedAtMs",
        ])
        // SQLite extracts only the chart totals instead of materializing every report in JavaScript.
        .select((eb) => [
          jsonPathValue<number>(
            this.db,
            eb.ref("data_json"),
            eb.val("$.activeMembers"),
            "number",
          ).as("activeMembers"),
          jsonPathValue<number>(this.db, eb.ref("data_json"), eb.val("$.memberCount"), "number").as(
            "memberCount",
          ),
          jsonPathValue<number>(
            this.db,
            eb.ref("data_json"),
            eb.val("$.totals.github.total"),
            "number",
          ).as("githubTotal"),
          jsonPathValue<number>(
            this.db,
            eb.ref("data_json"),
            eb.val("$.totals.discord.messages"),
            "number",
          ).as("discordMessages"),
          jsonPathValue<number>(
            this.db,
            eb.ref("data_json"),
            eb.val("$.totals.github.commits"),
            "number",
          ).as("commits"),
          jsonPathValue<number>(
            this.db,
            eb.ref("data_json"),
            eb.val("$.totals.github.prsOpened"),
            "number",
          ).as("prsOpened"),
          jsonPathValue<number>(
            this.db,
            eb.ref("data_json"),
            eb.val("$.totals.github.prsMerged"),
            "number",
          ).as("prsMerged"),
          jsonPathValue<number>(
            this.db,
            eb.ref("data_json"),
            eb.val("$.totals.github.securityAdvisories"),
            "number",
          ).as("securityAdvisories"),
        ])
        .orderBy("since_ms", "desc")
        .orderBy("period", "asc")
    );
  }

  private latestDay() {
    return this.selectPeriods()
      .select(["data_json", "summary_json"])
      .where("period", "=", "day")
      .limit(1);
  }

  latestSourceWarnings(): string[] {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.latestDay());
    if (!row) {
      return [];
    }
    const { report, summary } = readPeriod(row);
    return report.sources.github.warnings.concat(
      report.sources.discord?.warnings ?? [],
      summary?.warnings ?? [],
    );
  }

  latestPeople(): TeamReportsOperations["latestPeople"]["output"] {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.latestDay());
    if (!row) {
      return undefined;
    }
    // Validate the complete stored documents before omitting activity and summary payloads.
    const { report } = readPeriod(row);
    return {
      key: row.key,
      members: report.members.map(
        ({ login, aliases, display, affiliation, roleGroup, roleLabel, access, areas }) => ({
          login,
          aliases,
          display,
          affiliation,
          roleGroup,
          roleLabel,
          access,
          areas,
        }),
      ),
    };
  }

  getDayReports(sinceMs: number, untilMs: number): ReportDocument[] {
    return [...this.dayReports(sinceMs, untilMs)];
  }

  private *dayReports(sinceMs: number, untilMs: number): Generator<ReportDocument> {
    for (const row of iterateSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("team_reports_periods")
        .select("data_json")
        .where("period", "=", "day")
        .where("since_ms", ">=", sinceMs)
        .where("since_ms", "<", untilMs)
        .orderBy("since_ms", "asc"),
    )) {
      yield reportDocumentSchema.parse(JSON.parse(row.data_json));
    }
  }

  listPersonDays(
    login: string,
    options: TeamReportsOperations["listPersonDays"]["input"]["options"] = {},
  ): PersonDay[] {
    let query = this.selectPersonDays()
      .where("login", "=", login.toLowerCase())
      .orderBy("day_key", "desc");
    if (options.since) {
      query = query.where("day_key", ">=", options.since);
    }
    if (options.until) {
      query = query.where("day_key", "<", options.until);
    }
    return executeSqliteQuerySync(this.db, query.limit(options.limit ?? 28)).rows;
  }

  listPersonDaysSince(since: string): PersonDay[] {
    return executeSqliteQuerySync(
      this.db,
      this.selectPersonDays()
        .where("day_key", ">=", since)
        .orderBy("day_key", "desc")
        .orderBy("login", "asc"),
    ).rows;
  }

  private selectPersonDays() {
    return this.query
      .selectFrom("team_reports_person_days")
      .select([
        "day_key as dayKey",
        "login",
        "github_total as githubTotal",
        "commits",
        "prs_opened as prsOpened",
        "prs_merged as prsMerged",
        "prs_closed as prsClosed",
        "issues_opened as issuesOpened",
        "issues_closed as issuesClosed",
        "issue_comments as issueComments",
        "review_comments as reviewComments",
        "discord_messages as discordMessages",
      ]);
  }

  startRun(run: TeamReportsOperations["startRun"]["input"]): void {
    executeSqliteQuerySync(
      this.db,
      this.query.insertInto("team_reports_runs").values({
        id: run.id,
        kind: run.kind,
        started_at_ms: run.startedAtMs,
        finished_at_ms: null,
        status: "running",
        periods_json: JSON.stringify(run.periods),
        stats_json: null,
        error: null,
      }),
    );
  }

  finishRun(id: string, result: TeamReportsOperations["finishRun"]["input"]["result"]): void {
    const updated = executeSqliteQuerySync(
      this.db,
      this.query
        .updateTable("team_reports_runs")
        .set({
          finished_at_ms: result.finishedAtMs,
          status: result.status,
          stats_json: result.stats ? JSON.stringify(result.stats) : null,
          error: result.error?.slice(0, 2000) ?? null,
        })
        .where("id", "=", id)
        .where("status", "=", "running"),
    );
    if (updated.numAffectedRows !== 1n) {
      throw new Error(`Team Reports run ${id} is not running.`);
    }
  }

  listRuns(
    limit = 20,
    filter: TeamReportsOperations["listRuns"]["input"]["filter"] = {},
  ): ReportRun[] {
    let query = this.query.selectFrom("team_reports_runs").selectAll();
    if (filter.kind) {
      query = query.where("kind", "=", filter.kind);
    }
    if (filter.status) {
      query = query.where("status", "=", filter.status);
    }
    return executeSqliteQuerySync(
      this.db,
      query.orderBy("started_at_ms", "desc").orderBy("id", "asc").limit(limit),
    ).rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      startedAtMs: row.started_at_ms,
      finishedAtMs: row.finished_at_ms,
      status: row.status,
      periods: runPeriodsSchema.parse(JSON.parse(row.periods_json)),
      stats: row.stats_json === null ? null : runStatsSchema.parse(JSON.parse(row.stats_json)),
      error: row.error,
    }));
  }

  prune(
    retentionDays: number,
    nowMs = Date.now(),
  ): { periods: number; personDays: number; runs: number } {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 0) {
      throw new Error("Team Reports retention days must be a nonnegative integer.");
    }
    if (retentionDays === 0) {
      return { periods: 0, personDays: 0, runs: 0 };
    }
    const cutoffMs = Math.floor(nowMs / DAY_MS) * DAY_MS - retentionDays * DAY_MS;
    const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
    return runSqliteImmediateTransactionSync(this.db, () => ({
      // Preserve week/month reports that overlap the retained window.
      periods: Number(
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("team_reports_periods").where("until_ms", "<=", cutoffMs),
        ).numAffectedRows ?? 0n,
      ),
      personDays: Number(
        executeSqliteQuerySync(
          this.db,
          this.query.deleteFrom("team_reports_person_days").where("day_key", "<", cutoffDay),
        ).numAffectedRows ?? 0n,
      ),
      runs: Number(
        executeSqliteQuerySync(
          this.db,
          this.query
            .deleteFrom("team_reports_runs")
            .where("started_at_ms", "<", cutoffMs)
            .where("status", "!=", "running"),
        ).numAffectedRows ?? 0n,
      ),
    }));
  }

  withWriteTransaction<T>(operation: () => T): T {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
    return runSqliteImmediateTransactionSync(this.db, operation, {
      withCommit(commit) {
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        commit();
      },
    });
  }
}

export function openTeamReportsDatabase(dbPath: string, input?: DatabaseEngineInput) {
  const { db, close } = openTeamReportsConnection(dbPath, input);
  try {
    return new TeamReportsDatabase(db, close, input);
  } catch (error) {
    close();
    throw error;
  }
}

export function createSqliteWorkerBackend(
  input: DatabaseEngineInput,
  context: { databasePath: string },
) {
  const database = openTeamReportsDatabase(context.databasePath, input);
  const execute = (command: SqliteWorkerCommand<TeamReportsOperations>) => {
    switch (command.type) {
      case "resetActivity":
        return database.resetActivity();
      case "appendActivity":
        return database.appendActivity(command.input);
      case "aggregateActivity":
        return database.aggregateActivity(command.input);
      case "aggregatePeriod":
        return database.aggregatePeriod(command.input);
      case "upsertPeriod":
        return database.upsertPeriod(command.input);
      case "getPeriod":
        return database.getPeriod(command.input.period, command.input.key);
      case "getPeriodDocument":
        return database.getPeriodDocument(command.input.period, command.input.key);
      case "listPeriods":
        return database.listPeriods(command.input);
      case "latestSourceWarnings":
        return database.latestSourceWarnings();
      case "latestPeople":
        return database.latestPeople();
      case "getDayReports":
        return database.getDayReports(command.input.sinceMs, command.input.untilMs);
      case "listPersonDays":
        return database.listPersonDays(command.input.login, command.input.options);
      case "listPersonDaysSince":
        return database.listPersonDaysSince(command.input);
      case "startRun":
        return database.startRun(command.input);
      case "finishRun":
        return database.finishRun(command.input.id, command.input.result);
      case "listRuns":
        return database.listRuns(command.input.limit, command.input.filter);
      case "prune":
        return database.prune(command.input.retentionDays, command.input.nowMs);
    }
  };
  return {
    execute(command: SqliteWorkerCommand<TeamReportsOperations>) {
      return TEAM_REPORTS_WRITES.has(command.type)
        ? runEngineWorkerWrite(
            input,
            () => execute(command),
            (operation) => database.withWriteTransaction(operation),
          )
        : execute(command);
    },
    close: () => database.close(),
  };
}
