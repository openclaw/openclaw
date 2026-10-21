import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { withEngineStoreAdmission } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGithubSource } from "./sources/github/index.js";
import {
  commit,
  config,
  emptyRoute,
  json,
  logger,
  roster,
  window,
} from "./sources/github/responses.fixtures.js";
import { exercise, report } from "./store-conformance.test-support.js";
import { openTeamReportsDatabase, type createSqliteWorkerBackend } from "./store.worker.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;

function operations(database: ReturnType<typeof openTeamReportsDatabase>) {
  return {
    execute(command: Parameters<ReturnType<typeof createSqliteWorkerBackend>["execute"]>[0]) {
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
    },
    close: () => database.close(),
  };
}

describe.skipIf(!connection)("Team Reports PostgreSQL runtime", () => {
  const observer = new Client({ connectionString: connection });
  let directory: string;
  let databasePath: string;
  let namespace: string;
  let database: ReturnType<typeof openTeamReportsDatabase>;
  const input = { connection: connection!, schemaPrefix: "team_reports_test" };

  beforeAll(async () => {
    directory = fs.mkdtempSync(
      path.join(process.env.OPENCLAW_TEST_TMPDIR ?? os.tmpdir(), "team-reports-postgres-"),
    );
    databasePath = path.join(directory, "anchor.sqlite");
    await observer.connect();
    database = withEngineStoreAdmission(() => openTeamReportsDatabase(databasePath, input));
    using anchor = openNodeSqliteDatabase(databasePath);
    const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get();
    if (typeof row?.schema !== "string") {
      throw new Error("Missing PostgreSQL anchor");
    }
    namespace = row.schema;
  });
  afterAll(async () => {
    database?.close();
    if (namespace) {
      await observer.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await observer.end();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("matches SQLite runtime results, including all eight numeric JSON projections", async () => {
    expect(
      (await observer.query(`SELECT id FROM "${namespace}".team_reports_schema_migrations`)).rows,
    ).toEqual([{ id: "schema-1" }]);
    const sqlite = openTeamReportsDatabase(path.join(directory, "sqlite.sqlite"));
    try {
      const expected = exercise(operations(sqlite));
      expect(withEngineStoreAdmission(() => exercise(operations(database)))).toEqual(expected);
      withEngineStoreAdmission(() =>
        database.upsertPeriod({ report: report(), markdown: "retained" }),
      );
      const invalid = report();
      invalid.members = [invalid.members[0]!, invalid.members[0]!];
      expect(() =>
        withEngineStoreAdmission(() =>
          database.upsertPeriod({ report: invalid, markdown: "invalid" }),
        ),
      ).toThrow();
      expect(withEngineStoreAdmission(() => database.getPeriod("day", "2026-08-20"))).toEqual({
        report: report(),
        summary: null,
        markdown: "retained",
      });
      expect(withEngineStoreAdmission(() => database.listPersonDays("bob"))).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("keeps activity private to each connection and discards scratch at close", async () => {
    const options = {
      period: report().period,
      nowMs: report().generatedAtMs,
      orgs: ["example"],
      roster: { members: [], byLogin: new Map(), byDiscordId: new Map() },
      githubStatus: { ok: true, warnings: [], stats: {} },
    };
    withEngineStoreAdmission(() => database.resetActivity());
    withEngineStoreAdmission(() =>
      database.appendActivity({
        source: "github",
        entries: [
          {
            key: "private",
            value: {
              kind: "commit",
              actor: "outside",
              repo: "example/app",
              title: "Private activity",
              url: "https://example.test/commit/private",
              atMs: options.period.sinceMs + 1,
            },
          },
        ],
      }),
    );
    const sibling = withEngineStoreAdmission(() => openTeamReportsDatabase(databasePath, input));
    try {
      expect(
        withEngineStoreAdmission(() => sibling.aggregateActivity(options)).totals.github.total,
      ).toBe(0);
      expect(
        withEngineStoreAdmission(() => database.aggregateActivity(options)).totals.github.total,
      ).toBe(1);
      expect(
        (
          await observer.query(
            "SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = 'team_reports_activity'",
            [namespace],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      sibling.close();
    }
    database.close();
    database = withEngineStoreAdmission(() => openTeamReportsDatabase(databasePath, input));
    expect(
      withEngineStoreAdmission(() => database.aggregateActivity(options)).totals.github.total,
    ).toBe(0);
  });

  it.each(["sqlite", "postgres"] as const)(
    "collects GitHub activity into %s and replaces duplicate events across batches",
    async (engine) => {
      const target =
        engine === "postgres"
          ? database
          : openTeamReportsDatabase(path.join(directory, "github-source.sqlite"));
      let title = "Original commit";
      const source = createGithubSource({
        logger,
        fetchImpl: async (request) => {
          const url = new URL(request);
          return url.pathname === "/repos/example/app/commits"
            ? json([commit("first", title), commit("second", "Second commit")])
            : emptyRoute(url);
        },
      });
      try {
        withEngineStoreAdmission(() => target.resetActivity());
        const collect = () =>
          source.collect(config, window, roster, async (entries) => {
            withEngineStoreAdmission(() => target.appendActivity({ source: "github", entries }));
          });
        expect(await collect()).toMatchObject({ ok: true, warnings: [] });
        title = "Updated commit";
        const githubStatus = await collect();
        expect(githubStatus).toMatchObject({ ok: true, warnings: [] });
        const result = withEngineStoreAdmission(() =>
          target.aggregateActivity({
            period: report().period,
            nowMs: report().generatedAtMs,
            orgs: ["example"],
            roster,
            githubStatus,
          }),
        );
        expect(result.totals.github.commits).toBe(2);
        expect(result.members.find((member) => member.login === "builder")?.github.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ title: "Updated commit" }),
            expect.objectContaining({ title: "Second commit" }),
          ]),
        );
      } finally {
        if (engine === "sqlite") {
          target.close();
        }
      }
    },
  );
});
