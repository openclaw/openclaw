/**
 * Opt-in counts, not a latency benchmark or a normal-CI performance assertion.
 * Run: node scripts/perf/cron-run-history-sort-measure.mjs
 * Use the same script on base and candidate; it never changes production source.
 * Warm native Automations page, 50-row appends with 50/250/1000 rows held.
 * Acceptance: no full-history sorts on ordered appends; identical rendered order,
 * one RPC per append, and expanding the appended row still works without an RPC.
 * The native page and Gateway history projector are real; transport is a fixture.
 * The single append-boundary comparison is not an Array.sort comparator call.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(
  new URL("../../ui/src/pages/cron/run-history-sort.measurement.test.ts", import.meta.url),
);
const source = String.raw`
import { expect, it, vi } from "vitest";
import { projectCronRunHistoryPage } from "../../../../src/cron/run-history.js";
import type { CronRunRecord } from "../../../../src/cron/store/run-history.types.js";
import type { CronRunLogEntry } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { callsFor } from "./cron-assertions.test-support.ts";
import { cronRpc, mountCronPage } from "./cron-rpc.test-support.ts";

it("measures native history paging and subsequent expansion", async () => {
  const records: CronRunRecord[] = Array.from({ length: 1050 }, (_, i) => ({
    id: "row-" + String(i).padStart(5, "0"),
    jobId: "scheduled-report",
    agentId: "main",
    createdAt: 1700000000000 + i * 60000,
    status: "succeeded",
    detail: {
      kind: "cron-run",
      storeKey: "fixture",
      status: "ok",
      summary: "**Report** " + i,
      runId: "run-" + i,
    },
  }));
  const request = cronRpc({
    "cron.runs": (raw) => {
      if (typeof raw !== "object" || raw === null) {
        throw new Error("Missing history request");
      }
      return projectCronRunHistoryPage(records, { storeKey: "fixture", ...raw });
    },
  });
  const { page } = mountCronPage(request);
  let held = new Set<CronRunLogEntry>();
  let sorts = 0,
    comparisons = 0,
    withHeld = 0;
  let touched = new Set<CronRunLogEntry>(),
    sizes: number[] = [];
  const reset = () => {
    sorts = 0;
    comparisons = 0;
    withHeld = 0;
    touched.clear();
    sizes = [];
  };
  const observers = (["sort", "toSorted"] as const).map((method) => {
    const native = Array.prototype[method];
    return vi.spyOn(Array.prototype, method).mockImplementation(function (
      this: CronRunLogEntry[],
      compare,
    ) {
      if (this[0]?.action !== "finished") {
        return native.call(this, compare);
      }
      if (!compare) {
        throw new Error("Expected timestamp comparison");
      }
      sorts++;
      sizes.push(this.length);
      return native.call(this, (a, b) => {
        comparisons++;
        if (held.has(a) || held.has(b)) {
          withHeld++;
        }
        if (held.has(a)) {
          touched.add(a);
        }
        if (held.has(b)) {
          touched.add(b);
        }
        return compare(a, b);
      });
    });
  });
  try {
    page.routeSearch = "?activity";
    const entries = () => page.querySelectorAll(".cron-run-entry");
    await waitForSolid(() => expect(entries()).toHaveLength(50));
    for (let prior = 50; prior <= 1000; prior += 50) {
      held = new Set(page.cron.cronRuns);
      reset();
      const before = callsFor(request, "cron.runs").length;
      page.querySelector<HTMLButtonElement>(".cron-load-more")!.click();
      await waitForSolid(() => expect(entries()).toHaveLength(prior + 50));
      expect(callsFor(request, "cron.runs").length - before).toBe(1);
      expect(callsFor(request, "cron.runs").at(-1)?.[1]).toMatchObject({
        sortDir: "desc",
        offset: prior,
        limit: 50,
      });
      if (![50, 250, 1000].includes(prior)) {
        continue;
      }
      expect(
        [...entries()].map((row) =>
          row.querySelector(".cron-run-entry__summary")?.textContent?.trim(),
        ),
      ).toEqual(Array.from({ length: prior + 50 }, (_, i) => "Report " + (1049 - i)));
      console.log(
        "RUN_HISTORY_APPEND",
        JSON.stringify({
          prior,
          sorts,
          sizes,
          comparisons,
          withHeld,
          distinctHeld: touched.size,
          rpcs: 1,
        }),
      );
      const row = entries()[prior + 49];
      reset();
      const calls = callsFor(request, "cron.runs").length;
      row.querySelector<HTMLButtonElement>(".cron-run-entry__header")!.click();
      await waitForSolid(() =>
        expect(row.querySelector(".cron-run-entry__summary strong")?.textContent).toBe("Report"),
      );
      expect(callsFor(request, "cron.runs")).toHaveLength(calls);
      console.log(
        "RUN_HISTORY_EXPAND",
        JSON.stringify({
          prior,
          sorts,
          comparisons,
          withHeld,
          rpcs: 0,
        }),
      );
    }
  } finally {
    observers.forEach((observer) => observer.mockRestore());
    page.remove();
  }
});
`;

// Exclusive creation avoids overwriting another measurement or user work.
writeFileSync(fixture, source, { flag: "wx" });
try {
  const result = spawnSync(
    process.execPath,
    ["scripts/run-vitest.mjs", fixture, "--maxWorkers=1"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(fixture);
}
