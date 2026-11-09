// Observational browser workload; use only an isolated Gateway with synthetic state.
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { asOptionalRecord } from "../../packages/normalization-core/src/record-coerce.ts";

type Kind = "jobs" | "history";
type Row = { key: string; node: number; top: number; visible: boolean };
type Snapshot = { at: number; count: number; scrollTop: number; rows: Row[] };
type Append = {
  beforeAt: number;
  at: number;
  from: number;
  to: number;
  scrollDelta: number;
  common: Array<{ key: string; retained: boolean; displacement: number | null }>;
  settledScrollDelta?: number;
  settledCommon?: Append["common"];
  settledAt?: number;
};
type ProbeResult = {
  frames: number[];
  wheels: Array<{ at: number; deltaY: number }>;
  longTasks: Array<{ start: number; duration: number }>;
  appends: Append[];
  maxRenderedRows: number;
  final: Snapshot;
};
type ProbeWindow = Window & { cronPagingProbe?: { stop(): ProbeResult } };
type Request = {
  params: Record<string, unknown>;
  sent: number;
  received?: number;
  ok?: boolean;
  ids?: string[];
};
function parseFrame(payload: string | Buffer) {
  try {
    return asOptionalRecord(JSON.parse(String(payload)));
  } catch {
    return undefined;
  }
}

export async function measureCronPagingPage(page: Page, url: string, kind: Kind, total: number) {
  const wire: Request[] = [];
  const pending = new Map<string, Request>();
  const maxFlightByProjection = { full: 0, compact: 0 };
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = parseFrame(payload);
      if (frame?.type !== "req" || frame.method !== (kind === "jobs" ? "cron.list" : "cron.runs")) {
        return;
      }
      const request = { params: asOptionalRecord(frame.params) ?? {}, sent: performance.now() };
      wire.push(request);
      pending.set(String(frame.id), request);
      for (const projection of ["full", "compact"] as const) {
        const count = [...pending.values()].filter(
          (item) => (item.params.compact === true ? "compact" : "full") === projection,
        ).length;
        maxFlightByProjection[projection] = Math.max(maxFlightByProjection[projection], count);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = parseFrame(payload);
      const request = pending.get(String(frame?.id));
      if (!request) {
        return;
      }
      request.received = performance.now();
      request.ok = frame?.ok === true;
      const result = asOptionalRecord(frame?.payload);
      const rows = result?.jobs ?? result?.entries;
      request.ids = Array.isArray(rows)
        ? rows.map((row) => {
            const value = asOptionalRecord(row);
            if (typeof value?.id === "string") {
              return value.id;
            }
            if (typeof value?.runId === "string") {
              return value.runId;
            }
            return JSON.stringify([value?.jobId, value?.ts]);
          })
        : [];
      pending.delete(String(frame?.id));
    });
  });
  await page.goto(url);
  await page.locator(".cron-table__row").first().waitFor({ timeout: 60_000 });
  if (kind === "history") {
    await page.locator('[data-test-id="cron-list-tab-activity"]').click();
    await page.locator(".cron-run-entry").first().waitFor();
  }
  const selector = kind === "jobs" ? ".cron-table__row" : ".cron-runs__list > .cron-run-entry";
  const count = () =>
    page
      .locator(selector)
      .evaluateAll(
        (rows, view) =>
          view === "jobs"
            ? Number(rows[0]?.getAttribute("aria-setsize"))
            : Math.max(
                rows.length,
                ...rows.map((row) => Number(row.getAttribute("data-index") ?? -1) + 1),
              ),
        kind,
      );
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  await page.evaluate(() => document.fonts.ready);
  await settle();
  if ((await count()) !== 50) {
    throw new Error("Expected the initial 50-row presentation window");
  }
  const initialWireRequests = wire.length;
  await page.evaluate(
    ({ kind: viewKind, selector: rowSelector }) => {
      const target = window as ProbeWindow;
      target.cronPagingProbe?.stop();
      const content = document.querySelector<HTMLElement>(".content")!;
      const identities = new WeakMap<Element, number>();
      const frames: number[] = [];
      const wheels: ProbeResult["wheels"] = [];
      const longTasks: ProbeResult["longTasks"] = [];
      const appends: Append[] = [];
      let nextIdentity = 0;
      let maxRenderedRows = 0;
      let frameId = 0;
      let lastFrame = performance.now();
      const snapshot = (): Snapshot => {
        const clip = content.getBoundingClientRect();
        const rows = [...document.querySelectorAll(rowSelector)];
        maxRenderedRows = Math.max(maxRenderedRows, rows.length);
        return {
          at: performance.now(),
          count:
            viewKind === "jobs"
              ? Number(rows[0]?.getAttribute("aria-setsize"))
              : Math.max(
                  rows.length,
                  ...rows.map((row) => Number(row.getAttribute("data-index") ?? -1) + 1),
                ),
          scrollTop: content.scrollTop,
          rows: rows.map((row, index) => {
            if (!identities.has(row)) {
              identities.set(row, ++nextIdentity);
            }
            const bounds = row.getBoundingClientRect();
            return {
              key:
                viewKind === "jobs"
                  ? row.getAttribute("data-test-id")!
                  : `run-${row.getAttribute("data-index") ?? index}`,
              node: identities.get(row)!,
              top: bounds.top - clip.top,
              visible: bounds.bottom > clip.top && bounds.top < clip.bottom,
            };
          }),
        };
      };
      let previous = snapshot();
      const compare = (before: Snapshot, after: Snapshot): Append["common"] =>
        before.rows
          .filter((row) => row.visible)
          .map((row) => {
            const next = after.rows.find((candidate) => candidate.key === row.key);
            return {
              key: row.key,
              retained: next?.node === row.node,
              displacement: next ? next.top - row.top : null,
            };
          });
      const scrolled = () => {
        previous = snapshot();
      };
      content.addEventListener("scroll", scrolled, { passive: true });
      const wheeled = (event: WheelEvent) => {
        wheels.push({ at: performance.now(), deltaY: event.deltaY });
      };
      content.addEventListener("wheel", wheeled, { passive: true });
      const mutations = new MutationObserver(() => {
        const current = snapshot();
        if (current.count > previous.count) {
          const beforeAppend = previous;
          const append: Append = {
            beforeAt: beforeAppend.at,
            at: performance.now(),
            from: previous.count,
            to: current.count,
            scrollDelta: current.scrollTop - previous.scrollTop,
            common: compare(beforeAppend, current),
          };
          appends.push(append);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const settled = snapshot();
              append.settledScrollDelta = settled.scrollTop - beforeAppend.scrollTop;
              append.settledCommon = compare(beforeAppend, settled);
              append.settledAt = settled.at;
            }),
          );
        }
        previous = current;
      });
      mutations.observe(
        document.querySelector(viewKind === "jobs" ? ".cron-table" : ".cron-runs")!,
        {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-setsize"],
        },
      );
      const tasks = new PerformanceObserver((list) =>
        longTasks.push(
          ...list
            .getEntries()
            .map((entry) => ({ start: entry.startTime, duration: entry.duration })),
        ),
      );
      tasks.observe({ type: "longtask", buffered: false });
      const frame = (time: number) => {
        frames.push(time - lastFrame);
        lastFrame = time;
        frameId = requestAnimationFrame(frame);
      };
      frameId = requestAnimationFrame(frame);
      target.cronPagingProbe = {
        stop() {
          cancelAnimationFrame(frameId);
          mutations.disconnect();
          longTasks.push(
            ...tasks
              .takeRecords()
              .map((entry) => ({ start: entry.startTime, duration: entry.duration })),
          );
          tasks.disconnect();
          content.removeEventListener("scroll", scrolled);
          content.removeEventListener("wheel", wheeled);
          return { frames, wheels, longTasks, appends, maxRenderedRows, final: snapshot() };
        },
      };
    },
    { kind, selector },
  );
  const steps = [];
  let current = 50;
  while (current < total) {
    const started = performance.now();
    const requests = wire.length;
    const manual = page.locator(".cron-load-more");
    if (await manual.count()) {
      await manual.scrollIntoViewIfNeeded();
      await settle();
      await manual.click();
    } else {
      const bounds = await page.locator(".content").boundingBox();
      if (!bounds) {
        throw new Error("Missing scroll container");
      }
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      for (let move = 0; move < 100 && (await count()) === current; move++) {
        await page.mouse.wheel(0, 500);
        await settle();
      }
    }
    await page.waitForFunction(
      ({ selector: rowSelector, current: previousCount, kind: viewKind }) => {
        const rows = [...document.querySelectorAll(rowSelector)];
        const size =
          viewKind === "jobs"
            ? Number(rows[0]?.getAttribute("aria-setsize"))
            : Math.max(
                rows.length,
                ...rows.map((row) => Number(row.getAttribute("data-index") ?? -1) + 1),
              );
        return size > previousCount;
      },
      { selector, current, kind },
      { timeout: 15_000 },
    );
    await settle();
    const next = await count();
    steps.push({
      from: current,
      to: next,
      elapsedMs: performance.now() - started,
      wireRequests: wire.length - requests,
    });
    if (next !== current + 50) {
      throw new Error(`Expected one 50-row append, got ${current} → ${next}`);
    }
    current = next;
  }
  const probe = await page.evaluate(() => (window as ProbeWindow).cronPagingProbe!.stop());
  let terminalScrollRequests = 0;
  if (total === 1000) {
    const requests = wire.length;
    const bounds = await page.locator(".content").boundingBox();
    if (!bounds) {
      throw new Error("Missing scroll container");
    }
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.mouse.wheel(0, 100000);
      await settle();
    }
    terminalScrollRequests = wire.length - requests;
    if (terminalScrollRequests || (await count()) !== total) {
      throw new Error("Terminal scrolling changed the completed inventory");
    }
  }
  const full = wire.filter((request) => request.params.compact !== true);
  const ids = full.flatMap((request) => request.ids ?? []);
  if (pending.size || wire.some((request) => !request.ok)) {
    throw new Error("Incomplete or failed paging requests");
  }
  if (maxFlightByProjection.full > 1 || ids.length !== new Set(ids).size) {
    throw new Error("Paging issued overlapping requests or returned duplicate identities");
  }
  return {
    kind,
    timingScope:
      "elapsedMs includes scrolling to the page boundary; it is traversal time, not append latency. Native frame and long-task observers run only during warm traversal.",
    hostLoad: os.loadavg(),
    initialWireRequests,
    wireRequests: wire.length,
    maxFlightByProjection,
    fullInventoryRequests: full.length,
    duplicateFullInventoryIds: ids.length - new Set(ids).size,
    terminalScrollRequests,
    wire,
    steps,
    ...probe,
  };
}

// Fresh offline fixture only; the existing generator rejects all pre-existing state.
export async function createCronPagingFixture(stateDir: string) {
  const { generateTeamShapeFixture, parseTeamShapeOptions } =
    await import("./team-shape-fixture.ts");
  const { env } = await generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      stateDir,
      "--cron",
      "1000",
      "--sessions",
      "3",
      "--runs",
      "0",
      "--approvals",
      "0",
      "--projects",
      "0",
      "--transcript-mib",
      "0",
    ]),
  );
  // The existing fixture generator refuses any existing directory and owns isolation.
  process.env = { ...env };
  const [
    { recordCronRun },
    { cronRunLogEntryToDetail },
    { cronStoreKey },
    { closeOpenClawStateDatabaseAsync },
  ] = await Promise.all([
    import("../../src/cron/store/run-history.ts"),
    import("../../src/cron/run-history-detail.ts"),
    import("../../src/cron/store/key.ts"),
    import("../../src/state/openclaw-state-db.ts"),
  ]);
  const storeKey = cronStoreKey(path.join(stateDir, "cron", "jobs.json"));
  try {
    for (let index = 0; index < 1000; index++) {
      const jobId = `team-shape-cron-${index}`;
      const runAtMs = Date.now() - (index + 1) * 60_000;
      const entry = {
        jobId,
        action: "finished" as const,
        ts: runAtMs + 20,
        status: "ok" as const,
        completionStatus: "succeeded" as const,
        runId: `paging-history-${index}`,
        runAtMs,
        durationMs: 20,
        deliveryStatus: "not-requested" as const,
        summary: "Synthetic workspace check completed.",
      };
      await recordCronRun({
        storeKey,
        jobId,
        runId: entry.runId,
        agentId: "main",
        startedAt: runAtMs,
        endedAt: entry.ts,
        status: "succeeded",
        summary: entry.summary,
        detail: cronRunLogEntryToDetail(entry, { storeKey }),
      });
    }
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
}
