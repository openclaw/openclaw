import { summarizeCpuProfile, type ColdLoadCpuProfile } from "./control-ui-cold-load-trace.ts";

type Owner = "app" | "Solid" | "browser" | "automation" | "dependency" | "unmapped";
type Entry = {
  name: string;
  file: string;
  line: number;
  column: number;
  owner: Owner;
  selfMs: number;
  flows: Map<string, number>;
};

function sourceOwner(file: string, name: string, line: number): Owner {
  if (/(?:solid-js|@solidjs)[/+.]/u.test(file)) {
    return "Solid";
  }
  if (!file) {
    // Evaluated scripts may have source positions but no URL; do not call them native.
    return line >= 0 && !/^\(.+\)$/u.test(name) ? "unmapped" : "browser";
  }
  if (
    /(?:playwright|__playwright|pptr:|utilityScript|injectedScript|test-helpers\/|scripts\/lib\/)/iu.test(
      file,
    )
  ) {
    return "automation";
  }
  if (/^(?:https?:|blob:|wasm:)/u.test(file)) {
    return "unmapped";
  }
  if (file.includes("node_modules/")) {
    return "dependency";
  }
  return "app";
}

/** Sum leaf samples, never inclusive stacks; every active sample contributes once. */
export function createControlUiCpuCensus() {
  const functions = new Map<string, Entry>();
  const files = new Map<string, Entry>();
  const observations: Array<{
    flow: string;
    sampledMs: number;
    idleMs: number;
    profilerLeadInMs: number;
    activeMs: number;
    outOfOrderSamples: number;
  }> = [];
  function add(flow: string, profile: ColdLoadCpuProfile) {
    const summary = summarizeCpuProfile(profile, { includeTables: true });
    const firstFrame = profile.nodes.find((node) => node.id === profile.samples?.[0])?.callFrame;
    // The engine harness awaits Profiler.start before running the action. V8
    // charges its initialization delay to the first (program) sample.
    const profilerLeadInMs =
      firstFrame?.functionName === "(program)" ? profile.timeDeltas![0]! / 1_000 : 0;
    let activeMs = 0;
    for (const row of summary.tables!.functions) {
      const isFirstFrame =
        firstFrame &&
        row.functionName === firstFrame.functionName &&
        row.url === firstFrame.url &&
        row.lineNumber === firstFrame.lineNumber &&
        row.columnNumber === firstFrame.columnNumber;
      const selfMs = row.selfMs - (isFirstFrame ? profilerLeadInMs : 0);
      if (selfMs === 0) {
        continue;
      }
      activeMs += selfMs;
      const entry: Entry = {
        name: row.functionName || "(anonymous)",
        file: row.url,
        line: row.lineNumber,
        column: row.columnNumber,
        owner: sourceOwner(row.url, row.functionName, row.lineNumber),
        selfMs: 0,
        flows: new Map(),
      };
      const functionKey = JSON.stringify([entry.file, entry.name, entry.line, entry.column]);
      for (const [table, key] of [
        [functions, functionKey],
        [files, JSON.stringify([entry.file, entry.owner])],
      ] as const) {
        const total = table.get(key) ?? { ...entry, flows: new Map<string, number>() };
        total.selfMs += selfMs;
        total.flows.set(flow, (total.flows.get(flow) ?? 0) + selfMs);
        table.set(key, total);
      }
    }
    observations.push({
      flow,
      sampledMs: summary.sampledMs,
      idleMs: summary.idleMs,
      profilerLeadInMs,
      activeMs,
      outOfOrderSamples: summary.outOfOrderSamples,
    });
  }
  function report() {
    const activeMs = observations.reduce((sum, row) => sum + row.activeMs, 0);
    const ranked = (table: Map<string, Entry>, byFile = false) =>
      [...table.values()]
        .toSorted((a, b) => b.selfMs - a.selfMs)
        .map(({ flows, name, line, column, file, owner, selfMs }) => ({
          file,
          owner,
          selfMs,
          name: byFile ? undefined : name,
          line: byFile ? undefined : line,
          column: byFile ? undefined : column,
          sharePercent: activeMs ? (selfMs / activeMs) * 100 : 0,
          flowCount: flows.size,
          flows: [...flows]
            .toSorted((a, b) => b[1] - a[1])
            .map(([flow, flowMs]) => ({ flow, selfMs: flowMs })),
        }));
    const owners: Partial<Record<Owner, number>> = {};
    for (const row of functions.values()) {
      owners[row.owner] = (owners[row.owner] ?? 0) + row.selfMs;
    }
    return {
      activeMs,
      observations,
      owners,
      functions: ranked(functions),
      files: ranked(files, true),
      contract:
        "Sampled active self time, excluding root/idle and the leading (program) profiler initialization interval; includes later GC/native, dependencies, automation and unmapped frames. Each scenario is one flow; repeated observations sum time but not flow count. Diagnostic attribution only, not latency or exact consumed CPU. File totals sum self time, not inclusive stacks.",
    };
  }
  return { add, report };
}
