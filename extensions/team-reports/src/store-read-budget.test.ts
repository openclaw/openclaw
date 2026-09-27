import path from "node:path";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { describePeriod } from "./periods.js";
import { buildRoster } from "./roster.js";
import { createSqliteWorkerBackend } from "./store.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("aggregates across payload pages without paging metadata already retained for sorting", () => {
  const directory = tempDirs.make("team-reports-read-budget-");
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
    const reads = vi.spyOn(sqliteRuntime, "executeSqliteQuerySync");
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
    expect(reads.mock.calls.length).toBeLessThanOrEqual(5);
    const payloadSizes = reads.mock.results.flatMap((result) =>
      result.type === "return" &&
      result.value.rows.some(
        (row) => typeof row === "object" && row !== null && Object.hasOwn(row, "data_json"),
      )
        ? [result.value.rows.length]
        : [],
    );
    expect(payloadSizes.length).toBeGreaterThan(0);
    expect(Math.max(...payloadSizes)).toBeLessThanOrEqual(100);
  } finally {
    backend.close();
  }
});
