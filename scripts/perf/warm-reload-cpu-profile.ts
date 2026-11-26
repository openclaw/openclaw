import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession } from "playwright";
import {
  mapColdLoadCpuProfile,
  summarizeCpuProfile,
  type ColdLoadCpuProfile,
} from "../lib/control-ui-cold-load-trace.ts";
import { clipInteractionCpuProfile } from "../lib/control-ui-interaction-trace.ts";
import type { installWarmReloadBrowserProbe } from "./warm-reload-browser-probe.ts";

type Metrics = Array<{ name: string; value: number }>;
type Profile = ColdLoadCpuProfile & { startTime: number; endTime: number };
type Probe = Pick<
  NonNullable<ReturnType<typeof installWarmReloadBrowserProbe>>,
  "helloHandledMs" | "firstPaintedRowsMs" | "cpuAttribution"
> & { capturedUntilMs: number };

const metric = (metrics: Metrics, name: string) => {
  const value = metrics.find((entry) => entry.name === name)?.value;
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`Cold CPU capture lacks ${name}`);
  }
  return value;
};

/** CPU samples use monotonic microseconds; DOM paint timestamps use navigation-relative ms. */
export function summarizeWarmReloadCpu(
  profile: Profile,
  probe: Probe,
  snapshots: Array<{ title: string; metrics: Metrics }>,
  finalMetrics: Metrics,
) {
  const snapshot = (title: string) => {
    const found = snapshots.filter((entry) => entry.title === title);
    if (found.length !== 1) {
      throw new Error(`Cold CPU capture needs one ${title} counter snapshot`);
    }
    return found[0]!.metrics;
  };
  const hello = snapshot("warm-reload-cpu:hello-handled");
  const rows = snapshot("warm-reload-cpu:rows-observed");
  const navigationStart = metric(hello, "NavigationStart");
  if (
    navigationStart <= 0 ||
    metric(rows, "NavigationStart") !== navigationStart ||
    metric(finalMetrics, "NavigationStart") !== navigationStart
  ) {
    throw new Error("Cold CPU milestones do not belong to one navigation");
  }
  const startMs = probe.helloHandledMs;
  const endMs = probe.firstPaintedRowsMs;
  const observedMs = probe.cpuAttribution?.rowObservedAtMs;
  if (
    startMs === null ||
    endMs === null ||
    observedMs == null ||
    ![startMs, endMs, observedMs].every(Number.isFinite) ||
    endMs <= startMs ||
    observedMs < endMs ||
    observedMs > probe.capturedUntilMs
  ) {
    throw new Error("Cold CPU capture lacks ordered hello, row paint and observer milestones");
  }
  const startUs = navigationStart * 1_000_000 + startMs * 1_000;
  const endUs = navigationStart * 1_000_000 + endMs * 1_000;
  const captureEndUs = navigationStart * 1_000_000 + probe.capturedUntilMs * 1_000;
  if (
    profile.startTime > navigationStart * 1_000_000 ||
    profile.endTime < captureEndUs ||
    metric(finalMetrics, "Timestamp") * 1_000_000 < captureEndUs
  ) {
    throw new Error("Cold CPU profile does not cover the complete cold capture window");
  }
  const counterStartMs = (metric(hello, "Timestamp") - navigationStart) * 1_000;
  const counterEndMs = (metric(rows, "Timestamp") - navigationStart) * 1_000;
  if (counterEndMs <= counterStartMs) {
    throw new Error("Cold CPU counter snapshots are out of order");
  }
  const durations = [
    "ThreadTime",
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "V8CompileDuration",
    "DevToolsCommandDuration",
    "TaskOtherDuration",
  ];
  const counterDelta = (name: string) => metric(rows, name) - metric(hello, name);
  if (counterDelta("ThreadTime") < 0) {
    throw new Error("Cold CPU thread counter reset between milestones");
  }
  const interval = clipInteractionCpuProfile(profile, startUs, endUs);
  return {
    navigationStartSeconds: navigationStart,
    capturedUntilMs: probe.capturedUntilMs,
    sampleClock: "CDP monotonic microseconds; signed cumulative timeDeltas from profile.startTime",
    sampleWeight: "Elapsed sampling weight, not measured thread CPU",
    helloToRowPaint: { startMs, endMs, ...summarizeCpuProfile(interval, { includeTables: true }) },
    counters: {
      timeDomain: "threadTicks",
      scope: "Hello callback to first-row observer delivery; not historical row paint",
      startMs: counterStartMs,
      endMs: counterEndMs,
      helloSnapshotOffsetMs: counterStartMs - startMs,
      rowSnapshotOffsetMs: counterEndMs - observedMs,
      rowObserverDelayMs: observedMs - endMs,
      durationsMs: Object.fromEntries(durations.map((name) => [name, counterDelta(name) * 1_000])),
      counts: Object.fromEntries(
        ["LayoutCount", "RecalcStyleCount"].map((name) => [name, counterDelta(name)]),
      ),
    },
  };
}

/** One cold timing capture owns these CDP domains; no tracing, screenshots or extra sampler. */
export async function captureWarmReloadColdCpu<T extends Probe>(
  cdp: CDPSession,
  options: { outputDir: string; assetBaseUrl: string; assetDirectory: string },
  capture: () => Promise<T>,
) {
  const snapshots: Array<{ title: string; metrics: Metrics }> = [];
  let overflow = false;
  const onMetrics = (event: (typeof snapshots)[number]) => {
    if (
      event.title !== "warm-reload-cpu:hello-handled" &&
      event.title !== "warm-reload-cpu:rows-observed"
    ) {
      return;
    }
    if (snapshots.length === 2) {
      overflow = true;
      return;
    }
    snapshots.push(event);
  };
  let performanceRequested = false;
  let profilerRequested = false;
  let startRequested = false;
  let profile: Profile | undefined;
  let probe: T | undefined;
  let before: Metrics | undefined;
  let after: Metrics | undefined;
  const failures: unknown[] = [];
  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  };
  cdp.on("Performance.metrics", onMetrics);
  try {
    performanceRequested = true;
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    profilerRequested = true;
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1_000 });
    before = (await cdp.send("Performance.getMetrics")).metrics;
    startRequested = true;
    await cdp.send("Profiler.start");
    probe = await capture();
  } catch (error) {
    failures.push(error);
  } finally {
    // Each cleanup runs even when the preceding command or capture failed. The
    // outer browser/Gateway owner still settles the process before releasing inputs.
    if (startRequested) {
      await attempt(async () => {
        profile = (await cdp.send("Profiler.stop")).profile;
      });
    }
    if (performanceRequested) {
      await attempt(async () => {
        after = (await cdp.send("Performance.getMetrics")).metrics;
      });
    }
    if (profilerRequested) {
      await attempt(() => cdp.send("Profiler.disable"));
    }
    if (performanceRequested) {
      await attempt(() => cdp.send("Performance.disable"));
    }
    cdp.off("Performance.metrics", onMetrics);
  }
  const save = async (file: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) {
      throw new Error(`Cold CPU artifact exceeds 16 MiB: ${file}; capture is incomplete`);
    }
    await writeFile(path.join(options.outputDir, file), bytes);
  };
  // Preserve raw samples and clocks before attempting source-map analysis.
  await attempt(() =>
    save("cold-cpu-clocks.json", {
      timeDomain: "threadTicks",
      before,
      after,
      snapshots,
      overflow,
      probe,
    }),
  );
  if (profile) {
    await attempt(() => save("cold.cpuprofile", profile));
  }
  if (failures.length) {
    throw new AggregateError(failures, "Cold CPU capture or cleanup failed");
  }
  if (
    !profile ||
    !after ||
    !probe?.cpuAttribution?.supported ||
    overflow ||
    probe.cpuAttribution.overflow ||
    (probe.cpuAttribution.droppedEntries ?? 0) > 0
  ) {
    throw new Error("Cold CPU attribution is incomplete or exceeded its capture limit");
  }
  const mapped = await mapColdLoadCpuProfile(profile, options);
  const mappedProfile = { ...profile, nodes: mapped.profile.nodes };
  await save("cold.mapped.cpuprofile", mappedProfile);
  const attribution = {
    ...summarizeWarmReloadCpu(mappedProfile, probe, snapshots, after),
    mappedFrames: mapped.mappedFrames,
    unmappedFrames: mapped.unmappedFrames,
    mappingCoverage: !mapped.mappedFrames
      ? "unknown"
      : mapped.unmappedFrames
        ? "incomplete"
        : "all reported asset frames mapped",
    droppedLoafEntries: probe.cpuAttribution.droppedEntries,
    nativeCoverage: "Only browser-reported LoAF scripts; not an exhaustive task or function census",
  };
  await save("cold-cpu-attribution.json", attribution);
  return { probe, attribution };
}
