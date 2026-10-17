// Compare synthetic reloads with sanitized, source-mapped live CPU/RPC evidence.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { gzipSync } from "node:zlib";

const execute = promisify(execFile);
const TOP_FUNCTIONS = 20;
const REQUIRED_MATCHES = 15;

type AppFunction = {
  source: string;
  line: number;
  names: string[];
  milliseconds: number;
};
type CpuReport = { busyMs: number; functions: AppFunction[] };
type Distribution = { median: number; q1: number; q3: number; samples: number[] };
type RpcCounts = Record<string, number>;
type RpcCensus = { complete: boolean; counts: RpcCounts };
type BenchRun = { run: number; cpu: CpuReport; rpcs: RpcCounts };
type Scenario = {
  name: string;
  directory: string;
  liveCpu: string;
  liveRpcs: string;
  assets?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourcePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const workspace = /(?:^|\/)((?:ui|packages\/[^/]+|extensions\/[^/]+)\/.*)$/u.exec(normalized);
  if (workspace?.[1]) {
    return workspace[1];
  }
  const core = /(?:^|\/)(src\/.*)$/u.exec(normalized);
  return core?.[1] ?? normalized.replace(/^(?:\.\.\/|\.\/)+/u, "");
}

/** Same-line aliases describe nested/minified frames, not additive CPU time. */
export function parseFidelityCpuReport(text: string): CpuReport {
  const busy = /^profile .+ busy (\d+(?:\.\d+)?) ms idle /mu.exec(text);
  if (!busy || Number(busy[1]) <= 0) {
    throw new Error("CPU report has no positive busy-time denominator");
  }
  const marker = "--- inclusive by function (app sources, top 70)";
  const start = text.indexOf(marker);
  if (start < 0) {
    throw new Error("CPU report has no inclusive app-function section");
  }
  const grouped = new Map<string, AppFunction>();
  for (const line of text.slice(start + marker.length).split("\n")) {
    if (/^(?:---|==)/u.test(line)) {
      break;
    }
    const match = /^\s*(\d+(?:\.\d+)?)\s+([^\s]+\.[cm]?[jt]sx?):(\d+)\s+(.+)$/u.exec(line);
    const [, duration, rawSource, rawLine, rawName] = match ?? [];
    if (
      !duration ||
      !rawSource ||
      !rawLine ||
      !rawName ||
      rawSource.includes("node_modules") ||
      rawSource.includes("@")
    ) {
      continue;
    }
    const source = sourcePath(rawSource);
    const sourceLine = Number(rawLine);
    const key = `${source}:${sourceLine}`;
    const milliseconds = Number(duration);
    const name = rawName.trim();
    const previous = grouped.get(key);
    if (previous) {
      previous.milliseconds = Math.max(previous.milliseconds, milliseconds);
      if (!previous.names.includes(name)) {
        previous.names.push(name);
      }
    } else {
      grouped.set(key, { source, line: sourceLine, names: [name], milliseconds });
    }
  }
  if (!grouped.size) {
    throw new Error("CPU report contains no source-mapped app functions");
  }
  return {
    busyMs: Number(busy[1]),
    functions: [...grouped.values()].toSorted((a, b) => b.milliseconds - a.milliseconds),
  };
}

export function fidelityDistribution(samples: number[]): Distribution {
  if (!samples.length || samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error("Distribution requires finite samples");
  }
  const ordered = samples.toSorted((a, b) => a - b);
  const quantile = (fraction: number) => {
    const index = (ordered.length - 1) * fraction;
    const lower = Math.floor(index);
    // SAFETY: Nonempty samples and fractions in [0, 1] keep both indexes within ordered.
    const low = ordered[lower]!;
    // SAFETY: The same quantile bounds cover the upper index.
    const high = ordered[Math.ceil(index)]!;
    return low + (high - low) * (index - lower);
  };
  return { median: quantile(0.5), q1: quantile(0.25), q3: quantile(0.75), samples };
}

function semanticNames(fn: AppFunction): string[] {
  return fn.names.filter(
    (name) => !/^(?:\(anon\)|#|get |set |<)/u.test(name) && /^[\w$]{4,}$/u.test(name),
  );
}

function matchingFunction(live: AppFunction, bench: CpuReport, liveReport: CpuReport) {
  // Source-map lines can move between revisions; use a named function only if unique on both sides.
  const names = new Set(
    semanticNames(live).filter(
      (name) =>
        liveReport.functions.filter((fn) => fn.source === live.source && fn.names.includes(name))
          .length === 1,
    ),
  );
  const named = bench.functions.filter(
    (fn) => fn.source === live.source && fn.names.some((name) => names.has(name)),
  );
  const [unique] = named;
  if (named.length === 1 && unique) {
    return { fn: unique, match: "name" };
  }
  const exact = bench.functions.find((fn) => fn.source === live.source && fn.line === live.line);
  return exact ? { fn: exact, match: "location" } : undefined;
}

export function parseFidelityRpcCensus(value: unknown): RpcCensus {
  if (!record(value) || typeof value.complete !== "boolean" || !record(value.counts)) {
    throw new Error("Live RPC input must contain complete:boolean and counts:object");
  }
  const counts: RpcCounts = {};
  for (const [method, count] of Object.entries(value.counts)) {
    if (
      !/^[a-zA-Z][\w]*(?:\.[\w]+)*$/u.test(method) ||
      !Number.isSafeInteger(count) ||
      Number(count) < 0
    ) {
      throw new Error("Live RPC input contains an invalid method or count");
    }
    counts[method] = Number(count);
  }
  return { complete: value.complete, counts };
}

export function compareFidelity(
  name: string,
  live: CpuReport,
  liveRpcs: RpcCensus,
  runs: BenchRun[],
) {
  if (!runs.length) {
    throw new Error(`${name}: no measured reloads`);
  }
  const referenceFunctions = live.functions.slice(0, TOP_FUNCTIONS);
  const runMatches = runs.map((run) => {
    const candidates = live.functions.map((fn) => matchingFunction(fn, run.cpu, live));
    return candidates.map((candidate) => {
      if (!candidate) {
        return undefined;
      }
      const claims = candidates.filter((other) => other?.fn === candidate.fn);
      const named = claims.filter((claim) => claim?.match === "name");
      // A moved named function owns its frame over a stale source-line match.
      return claims.length === 1 || (named.length === 1 && named[0] === candidate)
        ? candidate
        : undefined;
    });
  });
  const functions = referenceFunctions.map((fn, index) => {
    const liveShare = (fn.milliseconds / live.busyMs) * 100;
    const samples = runs.map((run, runIndex) => {
      const match = runMatches[runIndex]?.[index];
      return { match, share: match ? (match.fn.milliseconds / run.cpu.busyMs) * 100 : null };
    });
    const observed = samples.flatMap((sample) => (sample.share === null ? [] : [sample.share]));
    const shares = observed.length === runs.length ? fidelityDistribution(observed) : null;
    const ratio = shares ? shares.median / liveShare : null;
    return {
      source: fn.source,
      line: fn.line,
      aliases: fn.names,
      liveMs: fn.milliseconds,
      liveShare,
      benchShare: shares,
      benchShareSamples: samples.map((sample) => sample.share),
      ratio,
      matchedRuns: samples.filter((sample) => sample.match).length,
      matches: samples.map((sample) => sample.match?.match ?? "not observed"),
      pass: ratio !== null && ratio >= 0.5 && ratio <= 2,
    };
  });
  const methods = new Set([
    ...Object.keys(liveRpcs.counts),
    ...runs.flatMap((run) => Object.keys(run.rpcs)),
  ]);
  const rpcs = [...methods].toSorted().map((method) => {
    const count = liveRpcs.counts[method] ?? null;
    const bench = fidelityDistribution(runs.map((run) => run.rpcs[method] ?? 0));
    return {
      method,
      live: count,
      bench,
      delta: count === null ? null : bench.median - count,
      pass: count !== null && bench.samples.every((sample) => Math.abs(sample - count) <= 1),
    };
  });
  const matchedFunctions = functions.filter((fn) => fn.pass).length;
  const cpuPass = functions.length === TOP_FUNCTIONS && matchedFunctions >= REQUIRED_MATCHES;
  const rpcPass = liveRpcs.complete && rpcs.every((rpc) => rpc.pass);
  return {
    name,
    runs: runs.map((run) => run.run),
    busyMs: fidelityDistribution(runs.map((run) => run.cpu.busyMs)),
    liveBusyMs: live.busyMs,
    functions,
    matchedFunctions,
    cpuPass,
    rpcs,
    liveRpcComplete: liveRpcs.complete,
    rpcPass,
    pass: cpuPass && rpcPass,
  };
}

type ScenarioReport = ReturnType<typeof compareFidelity>;
type FidelityReport = { pass: boolean; scenarios: ScenarioReport[] };

export function formatFidelityMarkdown(report: FidelityReport): string {
  const lines = [
    `# Control UI bench fidelity: ${report.pass ? "PASS" : "FAIL"}`,
    "",
    "CPU = inclusive share of sampled non-idle busy time. Same-source-line aliases use the maximum, never their sum. Frames absent from the analyzer's top 70 or unmatched by identity are not observed, not measured zero; incomplete observations fail the gate. IQR uses linear-interpolated quartiles.",
    "",
    "CPU gate: 15 of 20 unique live app locations at 0.5–2× live share, present in every run. RPC gate: complete live census, explicit counts for every observed bench method, and every run within ±1 for every method. Omitted live counts are unknown, never zero.",
  ];
  const number = (value: number) => value.toFixed(2);
  const spread = (value: Distribution) =>
    `${number(value.median)} [${number(value.q1)}, ${number(value.q3)}]`;
  for (const scenario of report.scenarios) {
    lines.push(
      "",
      `## ${scenario.name}: ${scenario.pass ? "PASS" : "FAIL"}`,
      "",
      `${scenario.runs.length} reloads; ${scenario.matchedFunctions}/20 app functions match. Busy time: live ${number(scenario.liveBusyMs)} ms; bench median [IQR] ${spread(scenario.busyMs)} ms.`,
      "",
      "| Function | Live % | Bench % median [IQR] | Ratio | Present | Gate |",
      "| --- | ---: | ---: | ---: | ---: | --- |",
    );
    for (const fn of scenario.functions) {
      const label = `${fn.source}:${fn.line} ${fn.aliases[0]}`
        .replaceAll("|", "\\|")
        .replaceAll("`", "'");
      lines.push(
        `| ${label} | ${number(fn.liveShare)} | ${fn.benchShare ? spread(fn.benchShare) : "not observed in every run"} | ${fn.ratio === null ? "not observed" : `${number(fn.ratio)}×`} | ${fn.matchedRuns}/${scenario.runs.length} | ${fn.pass ? "PASS" : "FAIL"} |`,
      );
    }
    lines.push(
      "",
      `Live RPC census: ${scenario.liveRpcComplete ? "complete" : "incomplete; RPC gate cannot pass"}.`,
      "",
      "| Boot RPC | Live | Bench median [IQR] | Delta | Gate |",
      "| --- | ---: | ---: | ---: | --- |",
    );
    for (const rpc of scenario.rpcs) {
      lines.push(
        `| ${rpc.method} | ${rpc.live ?? "unknown"} | ${spread(rpc.bench)} | ${rpc.delta === null ? "unknown" : number(rpc.delta)} | ${rpc.pass ? "PASS" : "FAIL"} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function readScenario(
  scenario: Scenario,
  analyzer: string,
  python: string,
): Promise<ScenarioReport> {
  const directory = path.resolve(scenario.directory);
  const summary = await readJson(path.join(directory, "summary.json"));
  if (!record(summary) || typeof summary.bundleDir !== "string") {
    throw new Error(`${scenario.name}: summary.json must identify its bundleDir`);
  }
  if (summary.route !== scenario.name) {
    throw new Error(`${scenario.name}: summary.json route must be ${scenario.name}`);
  }
  const requestedRuns = summary.requestedRuns;
  if (
    summary.completed !== true ||
    typeof requestedRuns !== "number" ||
    !Number.isSafeInteger(requestedRuns) ||
    requestedRuns < 1
  ) {
    throw new Error(`${scenario.name}: benchmark capture is incomplete`);
  }
  const runNumber = (filename: string) => Number(filename.slice(4, filename.indexOf(".")));
  const runFiles = (await readdir(directory))
    .filter((filename) => /^run-\d+\.metrics\.json$/u.test(filename))
    .toSorted((a, b) => runNumber(a) - runNumber(b));
  if (
    runFiles.length !== requestedRuns ||
    runFiles.some((filename, index) => runNumber(filename) !== index + 1)
  ) {
    throw new Error(`${scenario.name}: benchmark capture is incomplete`);
  }
  const assets = scenario.assets ?? path.join(summary.bundleDir, "assets");
  if (!(await readdir(assets)).some((filename) => filename.endsWith(".js.map"))) {
    throw new Error(`${scenario.name}: no JavaScript source maps in the bundle assets`);
  }
  const live = parseFidelityCpuReport(await readFile(scenario.liveCpu, "utf8"));
  const liveRpcs = parseFidelityRpcCensus(await readJson(scenario.liveRpcs));
  const scratch = await mkdtemp(path.join(tmpdir(), "control-ui-fidelity-"));
  try {
    const runs: BenchRun[] = [];
    for (const filename of runFiles) {
      const run = runNumber(filename);
      const metrics = await readJson(path.join(directory, filename));
      if (
        !record(metrics) ||
        !Array.isArray(metrics.rpcs) ||
        metrics.pending !== 0 ||
        metrics.queued !== 0
      ) {
        throw new Error(`${scenario.name} run ${run}: missing or unsettled RPC metrics`);
      }
      const rpcs: RpcCounts = {};
      for (const rpc of metrics.rpcs) {
        if (!record(rpc) || typeof rpc.method !== "string") {
          throw new Error(`${scenario.name} run ${run}: invalid RPC metric`);
        }
        rpcs[rpc.method] = (rpcs[rpc.method] ?? 0) + 1;
      }
      const profile = await readJson(path.join(directory, `run-${run}.cpuprofile`));
      if (
        !record(profile) ||
        !Array.isArray(profile.nodes) ||
        !Array.isArray(profile.samples) ||
        !Array.isArray(profile.timeDeltas) ||
        profile.samples.length === 0 ||
        profile.samples.length !== profile.timeDeltas.length ||
        typeof profile.startTime !== "number"
      ) {
        throw new Error(`${scenario.name} run ${run}: missing or invalid sampled CPU profile`);
      }
      // cpuprof2 owns mapping and inclusive accounting; this is only its trace transport envelope.
      const trace = {
        traceEvents: [
          { ph: "M", name: "thread_name", pid: 1, tid: 1, args: { name: "CrRendererMain" } },
          {
            name: "Profile",
            pid: 1,
            tid: 1,
            id: "reload",
            args: { data: { startTime: profile.startTime } },
          },
          {
            name: "ProfileChunk",
            pid: 1,
            tid: 1,
            id: "reload",
            args: {
              data: {
                cpuProfile: { nodes: profile.nodes, samples: profile.samples },
                timeDeltas: profile.timeDeltas,
              },
            },
          },
        ],
      };
      const traceFile = path.join(scratch, `run-${run}.json.gz`);
      await writeFile(traceFile, gzipSync(JSON.stringify(trace)));
      const { stdout } = await execute(python, [analyzer, traceFile, assets, "1"], {
        maxBuffer: 8 * 1024 * 1024,
      });
      runs.push({ run, rpcs, cpu: parseFidelityCpuReport(stdout) });
    }
    return compareFidelity(scenario.name, live, liveRpcs, runs);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      board: { type: "string" },
      "board-live": { type: "string" },
      "board-rpcs": { type: "string" },
      "board-assets": { type: "string" },
      chat: { type: "string" },
      "chat-live": { type: "string" },
      "chat-rpcs": { type: "string" },
      "chat-assets": { type: "string" },
      analyzer: { type: "string" },
      python: { type: "string", default: "python3" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(`Usage: node scripts/control-ui-bench-fidelity.ts
  --board <bench-directory> --board-live <mapped-live-profile.txt> --board-rpcs <method-counts.json>
  --chat <bench-directory> --chat-live <mapped-live-profile.txt> --chat-rpcs <method-counts.json>
  --analyzer <cpuprof2.py> [--python python3] [--output <report-directory>]
  [--board-assets <assets-directory>] [--chat-assets <assets-directory>]

Consumes summary.json, run-N.metrics.json and run-N.cpuprofile from each bench directory.
Live RPC JSON is {"complete":true,"counts":{"connect":1,"sessions.list":5}}. Use complete:false
for partial evidence; it remains reportable but cannot pass the RPC gate. Every observed bench method
requires an explicit live count, including zero. Omitted counts remain unknown even with complete:true.
Assets must contain source maps from the exact measured bundle. Each summary.route must match its
board/chat scenario. Explicit workspace source paths stay distinct; already stripped analyzer labels
remain unqualified. Both scenarios are required.
Prints JSON and Markdown; --output also writes report.json and report.md. Exit 1 = fidelity gate
failed; exit 2 = missing/invalid evidence or analyzer error. No live preambles or RPC params are copied.`);
    return;
  }
  if (
    !values.analyzer ||
    !values.board ||
    !values["board-live"] ||
    !values["board-rpcs"] ||
    !values.chat ||
    !values["chat-live"] ||
    !values["chat-rpcs"]
  ) {
    throw new Error(
      "Provide --analyzer and both board/chat directories, live profiles and RPC counts; see --help",
    );
  }
  const scenarios: ScenarioReport[] = [];
  for (const scenario of [
    {
      name: "board",
      directory: values.board,
      liveCpu: values["board-live"],
      liveRpcs: values["board-rpcs"],
      assets: values["board-assets"],
    },
    {
      name: "chat",
      directory: values.chat,
      liveCpu: values["chat-live"],
      liveRpcs: values["chat-rpcs"],
      assets: values["chat-assets"],
    },
  ]) {
    scenarios.push(await readScenario(scenario, path.resolve(values.analyzer), values.python));
  }
  const report: FidelityReport = { pass: scenarios.every((scenario) => scenario.pass), scenarios };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = formatFidelityMarkdown(report);
  if (values.output) {
    await mkdir(values.output, { recursive: true });
    await writeFile(path.join(values.output, "report.json"), json);
    await writeFile(path.join(values.output, "report.md"), markdown);
  }
  process.stdout.write(`${json}\n${markdown}`);
  process.exitCode = report.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(
      `Fidelity report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  });
}
