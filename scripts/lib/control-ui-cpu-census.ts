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

function sourceOwner(file: string): Owner {
  if (/(?:solid-js|@solidjs)[/+.]/u.test(file)) {
    return "Solid";
  }
  if (!file) {
    return "browser";
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
    activeMs: number;
    outOfOrderSamples: number;
  }> = [];
  function add(flow: string, profile: ColdLoadCpuProfile) {
    const summary = summarizeCpuProfile(profile, { includeTables: true });
    let activeMs = 0;
    for (const row of summary.tables!.functions) {
      if (row.selfMs === 0) {
        continue;
      }
      activeMs += row.selfMs;
      const entry: Entry = {
        name: row.functionName || "(anonymous)",
        file: row.url,
        line: row.lineNumber,
        column: row.columnNumber,
        owner: sourceOwner(row.url),
        selfMs: 0,
        flows: new Map(),
      };
      const functionKey = JSON.stringify([entry.file, entry.name, entry.line, entry.column]);
      for (const [table, key] of [
        [functions, functionKey],
        [files, entry.file],
      ] as const) {
        const total = table.get(key) ?? { ...entry, flows: new Map<string, number>() };
        total.selfMs += row.selfMs;
        total.flows.set(flow, (total.flows.get(flow) ?? 0) + row.selfMs);
        table.set(key, total);
      }
    }
    observations.push({
      flow,
      sampledMs: summary.sampledMs,
      idleMs: summary.idleMs,
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
        "Sampled active self time, excluding root/idle; includes GC/native, dependencies, automation and unmapped frames. Each scenario is one flow; repeated observations sum time but not flow count. Diagnostic attribution only, not latency or exact consumed CPU. File totals sum self time, not inclusive stacks.",
    };
  }
  return { add, report };
}
