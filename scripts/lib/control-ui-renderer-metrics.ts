import { execFileSync } from "node:child_process";
import type { CDPSession } from "playwright";

export async function readControlUiPerformanceMetrics(
  cdp: CDPSession,
): Promise<Record<string, number> & { JSHeapUsedSize: number }> {
  const result: { metrics: Array<{ name: string; value: number }> } =
    await cdp.send("Performance.getMetrics");
  const measured = Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
  const heapUsed = measured.JSHeapUsedSize;
  if (heapUsed === undefined) {
    throw new Error("Chromium did not report the required JS heap metric");
  }
  return { ...measured, JSHeapUsedSize: heapUsed };
}

export type RendererProcessSnapshot = Array<{ id: number; cpuSeconds: number; rssBytes: number }>;

export async function readRendererProcessSnapshot(
  cdp: CDPSession,
): Promise<RendererProcessSnapshot> {
  const { processInfo }: { processInfo: Array<{ id: number; type: string; cpuTime: number }> } =
    await cdp.send("SystemInfo.getProcessInfo");
  const renderers = processInfo.filter(({ type }) => type === "renderer");
  if (
    !renderers.length ||
    renderers.some(
      ({ id, cpuTime }) => !Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(cpuTime),
    )
  ) {
    throw new Error("The owned browser did not provide valid renderer processes");
  }
  // Only CDP-reported PIDs from this benchmark-owned browser reach ps.
  const rows = execFileSync(
    "/bin/ps",
    ["-o", "pid=,rss=", "-p", renderers.map(({ id }) => id).join(",")],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  )
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  return renderers.map(({ id, cpuTime }) => {
    const rss = rows.find(([pid]) => pid === id)?.[1];
    if (rss === undefined || !Number.isFinite(rss) || rss < 0) {
      throw new Error(`Renderer ${id} did not supply a valid RSS snapshot`);
    }
    return { id, cpuSeconds: cpuTime, rssBytes: rss * 1024 };
  });
}

export function measureRendererProcessMetrics(
  beforeRows: RendererProcessSnapshot,
  afterRows: RendererProcessSnapshot,
) {
  if (
    beforeRows.length !== afterRows.length ||
    beforeRows.some(({ id }) => !afterRows.some((row) => row.id === id))
  ) {
    throw new Error("Owned renderer process set changed during the interval");
  }
  const cpuSeconds = afterRows.reduce(
    (sum, row) => sum + row.cpuSeconds - beforeRows.find(({ id }) => id === row.id)!.cpuSeconds,
    0,
  );
  if (cpuSeconds < 0) {
    throw new Error("Owned renderer CPU counters moved backwards");
  }
  return {
    rendererCpuMs: cpuSeconds * 1000,
    rendererRssBeforeBytes: beforeRows.reduce((sum, row) => sum + row.rssBytes, 0),
    rendererRssAfterBytes: afterRows.reduce((sum, row) => sum + row.rssBytes, 0),
  };
}
