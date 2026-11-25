/**
 * node scripts/perf/main-module-census-report.mjs <module-census.json>
 *   [--edges module-edges.json] [--output report.json]
 * Join main-module-census-preload.mjs scripts to precise coverage by script ID.
 * Optional startupExecution is coverage taken/reset at the workload boundary.
 * Run coverage separately from timing: it changes optimization and residency.
 * Static declarations are verified against the parent's current on-disk source;
 * analyze before rebuilding. Other edges remain unclassified loader resolutions.
 * Importer groups overlap and do not establish exclusive retention ownership.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "acorn";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    edges: { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/perf/main-module-census-report.mjs <module-census.json> [--edges module-edges.json] [--output report.json]",
  );
  process.exit(0);
}
if (positionals.length !== 1) {
  throw new Error("Expected one module-census.json input; see --help");
}
const input = path.resolve(positionals[0]);
const output = path.resolve(values.output ?? `${input}.report.json`);
if (output === input || (values.edges && output === path.resolve(values.edges))) {
  throw new Error("Report output must differ from its inputs");
}
const census = JSON.parse(readFileSync(input, "utf8"));
const edges = values.edges ? JSON.parse(readFileSync(values.edges, "utf8")) : [];
const execution = new Map((census.execution ?? []).map((entry) => [entry.scriptId, entry]));
const startupExecution = new Map(
  (census.startupExecution ?? []).map((entry) => [entry.scriptId, entry]),
);
const staticImports = new Map();
function classifyEdge(edge) {
  if (!edge.parent?.startsWith("file:")) {
    return "unclassified-resolution";
  }
  if (!staticImports.has(edge.parent)) {
    let specifiers;
    try {
      const source = readFileSync(new URL(edge.parent), "utf8");
      const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
      specifiers = new Set(
        ast.body
          .filter((node) =>
            ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(
              node.type,
            ),
          )
          .map((node) => node.source?.value)
          .filter((value) => typeof value === "string"),
      );
    } catch {
      // Built JS can be missing or use syntax this parser does not understand.
      specifiers = new Set();
    }
    staticImports.set(edge.parent, specifiers);
  }
  return staticImports.get(edge.parent).has(edge.specifier)
    ? "static-declaration"
    : "unclassified-resolution";
}
const incoming = new Map();
for (const edge of edges) {
  const entries = incoming.get(edge.url) ?? new Map();
  entries.set(JSON.stringify([edge.parent, edge.specifier]), {
    ...edge,
    kind: classifyEdge(edge),
  });
  incoming.set(edge.url, entries);
}

function packageOrPath(url) {
  if (!url.startsWith("file:")) {
    return url.startsWith("node:") ? "node:" : "anonymous-or-non-file";
  }
  const filename = fileURLToPath(url).replaceAll("\\", "/");
  const dependency = filename.lastIndexOf("/node_modules/");
  if (dependency !== -1) {
    const parts = filename.slice(dependency + "/node_modules/".length).split("/");
    return `node_modules/${parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/")}`;
  }
  const workspace = filename.match(/\/(packages|extensions)\/([^/]+)\//u);
  return workspace ? `${workspace[1]}/${workspace[2]}` : path.dirname(filename);
}

const scripts = census.scripts.map((script) => {
  const covered = execution.get(script.scriptId);
  const startup = startupExecution.get(script.scriptId);
  // V8's unnamed, whole-script range is module evaluation, not a callable body.
  const callableFunctions = (entry) =>
    (entry?.functions ?? []).filter((fn, index) => {
      const range = fn.ranges[0];
      return !(
        index === 0 &&
        fn.functionName === "" &&
        range.startOffset === 0 &&
        range.endOffset === script.length
      );
    });
  const functions = callableFunctions(covered);
  const knownFunctions = new Set(
    [...callableFunctions(startup), ...functions].map((fn) =>
      JSON.stringify([fn.ranges[0].startOffset, fn.ranges[0].endOffset]),
    ),
  ).size;
  const knownCoverage = Boolean(covered || (census.coverage && startup));
  const executedFunctions = functions.filter((fn) => fn.ranges[0].count > 0).length;
  const status = !knownCoverage
    ? "unknown"
    : knownFunctions === 0
      ? "no-recorded-functions"
      : !covered
        ? "absent-in-covered-window"
        : executedFunctions === 0
          ? "unexecuted"
          : "executed";
  return Object.assign({}, script, {
    group: packageOrPath(script.url),
    status,
    recordedFunctions: knownCoverage ? knownFunctions : null,
    executedFunctions: knownCoverage ? executedFunctions : null,
    observedCalls: knownCoverage
      ? functions.reduce((sum, fn) => sum + fn.ranges[0].count, 0)
      : null,
    incomingResolutions: [...(incoming.get(script.url)?.values() ?? [])],
  });
});

function summarize(entries) {
  return {
    scripts: entries.length,
    sourceBytes: entries.reduce((sum, script) => sum + (script.sourceBytes ?? 0), 0),
    recordedFunctions: entries.reduce((sum, script) => sum + (script.recordedFunctions ?? 0), 0),
    executedFunctions: entries.reduce((sum, script) => sum + (script.executedFunctions ?? 0), 0),
    observedCalls: entries.reduce((sum, script) => sum + (script.observedCalls ?? 0), 0),
  };
}
function groupScripts(entries, keys) {
  const groups = new Map();
  for (const script of entries) {
    for (const key of new Set(keys(script))) {
      const group = groups.get(key) ?? [];
      group.push(script);
      groups.set(key, group);
    }
  }
  return [...groups]
    .map(([group, members]) =>
      Object.assign({ group }, summarize(members), {
        scriptIds: members.map((script) => script.scriptId),
      }),
    )
    .toSorted((a, b) => b.sourceBytes - a.sourceBytes || a.group.localeCompare(b.group));
}
const unexecuted = scripts.filter((script) =>
  ["unexecuted", "absent-in-covered-window"].includes(script.status),
);
const report = {
  input,
  coverage: census.coverage,
  notes: [
    "Unexecuted means no recorded callable function ran during the coverage window; module evaluation is excluded.",
    "Absent-in-covered-window means the startup inventory recorded functions but workload coverage recorded none; V8 omits idle preloaded scripts. Without startup inventory, missing coverage is unknown.",
    "Function counts combine startup and workload records; V8 may omit nested functions that were never compiled. Calls count only the workload window, not lifetime execution.",
    "Source bytes are script text size, not heap retention. Inspect import callers before changing evaluation timing.",
    "Static declarations are verified in the current on-disk parent source; analyze frozen artifacts before rebuilding. Other resolutions are unclassified.",
    "Importer groups overlap and do not prove exclusive ownership or identify the first importer.",
  ],
  totals: summarize(scripts),
  statuses: Object.fromEntries(
    ["executed", "unexecuted", "absent-in-covered-window", "unknown", "no-recorded-functions"].map(
      (status) => [status, summarize(scripts.filter((script) => script.status === status))],
    ),
  ),
  unexecutedByPackageOrPath: groupScripts(unexecuted, (script) => [script.group]),
  unexecutedByImporter: groupScripts(unexecuted, (script) =>
    script.incomingResolutions.length
      ? script.incomingResolutions.map((edge) => edge.parent ?? "(entrypoint)")
      : ["(no recorded resolution)"],
  ),
  unexecutedByStaticImporter: groupScripts(unexecuted, (script) =>
    script.incomingResolutions
      .filter((edge) => edge.kind === "static-declaration")
      .map((edge) => edge.parent),
  ),
  scripts,
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, totals: report.totals, statuses: report.statuses }));
console.table(
  report.unexecutedByPackageOrPath.slice(0, 15).map((group) => ({
    group: group.group,
    scripts: group.scripts,
    sourceBytes: group.sourceBytes,
    recordedFunctions: group.recordedFunctions,
  })),
);
