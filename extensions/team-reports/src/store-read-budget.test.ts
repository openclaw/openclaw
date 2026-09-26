import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { describePeriod } from "./periods.js";
import { buildRoster } from "./roster.js";
import { createSqliteWorkerBackend } from "./store.worker.js";

it("aggregates across payload pages without paging metadata already retained for sorting", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-reports-read-budget-"));
  const prepare = DatabaseSync.prototype.prepare;
  let reads = 0;
  let maxPayloadRows = 0;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith("select") && sql.includes('"team_reports_activity"')) {
      const all = statement.all.bind(statement);
      statement.all = new Proxy(all, {
        apply(target, receiver, args) {
          const rows: ReturnType<typeof all> = Reflect.apply(target, receiver, args);
          reads += 1;
          if (sql.includes('"data_json"')) {
            maxPayloadRows = Math.max(maxPayloadRows, rows.length);
          }
          return rows;
        },
      });
    }
    return statement;
  });
  const backend = createSqliteWorkerBackend(undefined, {
    databasePath: path.join(directory, "reports.sqlite"),
  });
  try {
    const period = describePeriod("day", "2026-08-20");
    for (let start = 0; start < 201; start += 100) {
      backend.execute({
        type: "appendActivity",
        input: {
          source: "github",
          entries: Array.from({ length: Math.min(100, 201 - start) }, (_, offset) => {
            const index = start + offset;
            return {
              key: `comment-${index}`,
              value: {
                kind: "issue_comment",
                actor: "alice",
                repo: "example/app",
                atMs: period.sinceMs + index,
                title: `Comment ${index}`,
                body: "Same discussion across all pages",
                url: `https://github.com/example/app/issues/1#comment-${index}`,
              },
            };
          }),
        },
      });
    }
    const report = backend.execute({
      type: "aggregateActivity",
      input: {
        period,
        nowMs: period.untilMs,
        orgs: ["example"],
        roster: buildRoster([{ github: ["alice"] }]),
        githubStatus: { ok: true, warnings: [], stats: {} },
      },
    });
    expect(report).toMatchObject({
      totals: { github: { issueComments: 1 } },
      members: [{ login: "alice", github: { items: [{ title: "Comment 200" }] } }],
    });
    // Two source metadata reads plus three bounded payload reads.
    expect(reads).toBeLessThanOrEqual(5);
    expect(maxPayloadRows).toBeLessThanOrEqual(100);
  } finally {
    vi.restoreAllMocks();
    backend.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
