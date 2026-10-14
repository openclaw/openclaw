#!/usr/bin/env node
import { readFileSync } from "node:fs";
import type { Profiler } from "node:inspector";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

type CpuProfileInput = Profiler.Profile | { profile: Profiler.Profile; startBlockedMs?: number };

function isNativeFrame(frame: Profiler.ProfileNode["callFrame"]) {
  return (
    frame.functionName === "[native]" ||
    (frame.scriptId === "0" &&
      frame.url === "" &&
      frame.lineNumber < 0 &&
      !["(root)", "(idle)", "(program)", "(garbage collector)"].includes(frame.functionName))
  );
}

/** Attributes native self samples without charging their JavaScript descendants twice. */
export function attributeNativeCpuSamples(input: CpuProfileInput) {
  const profile = "profile" in input ? input.profile : input;
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parents.set(child, node.id);
    }
  }
  if (
    !profile.samples ||
    !profile.timeDeltas ||
    profile.samples.length !== profile.timeDeltas.length
  ) {
    throw new Error("CPU profile must contain matching samples and timeDeltas");
  }
  const rows = new Map<string, { micros: number; workloadMicros: number }>();
  let nativeMicros = 0;
  let startupMicros = 0;
  for (const [index, id] of profile.samples.entries()) {
    const node = byId.get(id);
    if (!node) {
      throw new Error(`Unknown CPU profile sample node: ${id}`);
    }
    if (!isNativeFrame(node.callFrame)) {
      continue;
    }
    const ancestors: Profiler.ProfileNode[] = [];
    let parentId = parents.get(id);
    while (parentId !== undefined) {
      const parent = byId.get(parentId);
      if (!parent || ancestors.some((ancestor) => ancestor.id === parentId)) {
        throw new Error("Invalid CPU profile parent chain");
      }
      ancestors.push(parent);
      parentId = parents.get(parentId);
    }
    const parent = ancestors.find(
      ({ callFrame }) =>
        !isNativeFrame(callFrame) && (callFrame.url !== "" || callFrame.scriptId !== "0"),
    )?.callFrame;
    const label = parent
      ? `${parent.functionName || "(anonymous)"} ${parent.url || "[redacted]"}:${parent.lineNumber + 1}:${parent.columnNumber + 1}`
      : "(unattributed)";
    const micros = profile.timeDeltas[index]!;
    // Only a diagnostics envelope identifies blocked start. Raw profiles retain all samples.
    const startup =
      index === 0 &&
      "profile" in input &&
      (input.startBlockedMs ?? 0) > 0 &&
      micros > 0 &&
      ancestors.some(
        ({ callFrame }) => callFrame.url === "node:inspector" && callFrame.functionName === "post",
      ) &&
      ancestors.some(
        ({ callFrame }) =>
          callFrame.functionName === "start" && callFrame.url.includes("diagnostic-cpu-profile"),
      );
    nativeMicros += micros;
    if (startup) {
      startupMicros += micros;
    }
    const row = rows.get(label) ?? { micros: 0, workloadMicros: 0 };
    row.micros += micros;
    row.workloadMicros += startup ? 0 : micros;
    rows.set(label, row);
  }
  const windowMicros = profile.endTime - profile.startTime;
  const workloadWindowMicros = windowMicros - startupMicros;
  const percent = (micros: number, total: number) => (total > 0 ? (100 * micros) / total : 0);
  return {
    windowMs: windowMicros / 1_000,
    nativeMs: nativeMicros / 1_000,
    nativePercent: percent(nativeMicros, windowMicros),
    startupSampleMs: startupMicros / 1_000,
    startBlockedMs: "profile" in input ? (input.startBlockedMs ?? null) : null,
    workloadWindowMs: workloadWindowMicros / 1_000,
    workloadNativePercent: percent(nativeMicros - startupMicros, workloadWindowMicros),
    parents: [...rows]
      .toSorted((a, b) => b[1].micros - a[1].micros)
      .map(([parent, row]) => ({
        parent,
        nativeMs: row.micros / 1_000,
        windowPercent: percent(row.micros, windowMicros),
        nativePercent: percent(row.micros, nativeMicros),
        workloadPercent: percent(row.workloadMicros, workloadWindowMicros),
      })),
  };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { json: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help || !positionals.length) {
    console.log("Usage: node scripts/diagnostic-cpu-native-parents.mts [--json] <profile.json>...");
    return;
  }
  const reports = positionals.map((file) =>
    Object.assign({ file }, attributeNativeCpuSamples(JSON.parse(readFileSync(file, "utf8")))),
  );
  if (values.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  for (const report of reports) {
    console.log(
      `\n${report.file}: native ${report.nativePercent.toFixed(2)}% of ${report.windowMs.toFixed(1)} ms`,
    );
    console.log(
      `Profiler-start sample ${report.startupSampleMs.toFixed(1)} ms; recorded startBlockedMs ${report.startBlockedMs ?? "unavailable"}`,
    );
    console.log(
      `Workload native ${report.workloadNativePercent.toFixed(2)}% of ${report.workloadWindowMs.toFixed(1)} ms`,
    );
    console.log(" window%  native% workload% parent (one-based line:column)");
    for (const row of report.parents.slice(0, 20)) {
      console.log(
        `${row.windowPercent.toFixed(2).padStart(8)} ${row.nativePercent.toFixed(2).padStart(8)} ${row.workloadPercent.toFixed(2).padStart(9)} ${row.parent}`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
