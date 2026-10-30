/**
 * Reusable isolated dist-Gateway stress campaign. Usage and metric caveats:
 * scripts/perf/team-shape-stress.md. Run with node --import ./scripts/tsx.mjs.
 * This controller never connects to an existing Gateway or builds either revision.
 * --auth-availability-storm seeds a shared synthetic profile and alternates primary HTTP 429/success.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runManagedCommand } from "../lib/managed-child-process.mts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { TEAM_STRESS_PLUGIN_IDS } from "./team-shape-stress-fixture.ts";
import {
  summarizeStressRun,
  compareStressRuns,
  type StressRun,
} from "./team-shape-stress-report.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const headlineMetrics = new Set([
  "mainThreadCpuPercent",
  "allocationMiBPerSecond",
  "sampledSurvivorMiBPerSecond",
  "gcSecondsPerMinute",
  "eventLoopP99Ms",
  "eventLoopP999Ms",
  "sessionsListP99Ms",
  "rssMiB",
  "heapMiB",
  "oldGenerationAfterGcMiB",
  "workerHeapMiB",
]);
const rounded = (value: number | null) => (value === null ? null : Number(value.toFixed(3)));

export function parseStressOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      base: { type: "string" },
      candidate: { type: "string", default: root },
      output: { type: "string" },
      minutes: { type: "string", default: "10" },
      pairs: { type: "string", default: "2" },
      "aa-pairs": { type: "string", default: "0" },
      clients: { type: "string", default: "65" },
      runs: { type: "string", default: "4" },
      sessions: { type: "string", default: "10800" },
      agents: { type: "string", default: "4" },
      plugins: { type: "string", default: "40" },
      seed: { type: "string", default: "1711" },
      now: { type: "string", default: String(Date.now()) },
      "transcript-mib": { type: "string", default: "128" },
      "poll-ms": { type: "string", default: "25000" },
      "list-weight": { type: "string", default: "16" },
      "round-ms": { type: "string", default: "60000" },
      "churn-ms": { type: "string", default: "6000" },
      "warmup-ms": { type: "string", default: "60000" },
      mode: { type: "string", default: "both" },
      "smoke-seconds": { type: "string" },
      "fixture-only": { type: "boolean" },
      "operator-model-policy": { type: "boolean" },
      "gateway-preload": { type: "string" },
      "worker-heap-snapshot": { type: "boolean" },
      "knowledge-worker-heap": { type: "boolean" },
      "worktree-tool-churn": { type: "boolean" },
      "auth-availability-storm": { type: "boolean" },
      port: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const integer = (name: keyof typeof values, min: number) =>
    parseStrictIntegerOption({
      raw: String(values[name] ?? ""),
      label: `--${name}`,
      min,
      fallback: min,
    });
  if (!values.help && !values.output) {
    throw new Error("--output must name a new directory");
  }
  if (!["timing", "allocation", "retention", "both"].includes(values.mode)) {
    throw new Error("--mode must be timing, allocation, retention, or both");
  }
  const minutes = integer("minutes", 10);
  const pairs = integer("pairs", 1);
  const aaPairs = integer("aa-pairs", 0);
  if (aaPairs > pairs || (aaPairs > 0 && !values.base)) {
    throw new Error("--aa-pairs requires --base and must not exceed --pairs");
  }
  const smokeSeconds = values["smoke-seconds"] ? integer("smoke-seconds", 1) : undefined;
  const port = integer("port", 40000);
  const plugins = integer("plugins", 4);
  const listWeight = integer("list-weight", 1);
  if (listWeight > 64) {
    throw new Error("--list-weight must not exceed 64");
  }
  if (plugins > TEAM_STRESS_PLUGIN_IDS.length) {
    throw new Error(`--plugins must not exceed ${TEAM_STRESS_PLUGIN_IDS.length}`);
  }
  if (port > 65535) {
    throw new Error("--port must be between 40000 and 65535");
  }
  return {
    base: values.base ? path.resolve(values.base) : undefined,
    candidate: path.resolve(values.candidate),
    output: path.resolve(values.output ?? "."),
    durationMs: smokeSeconds ? smokeSeconds * 1000 : minutes * 60_000,
    smoke: smokeSeconds !== undefined,
    pairs,
    aaPairs,
    clients: integer("clients", 4),
    runs: integer("runs", 1),
    sessions: integer("sessions", 100),
    agents: integer("agents", 1),
    plugins,
    seed: integer("seed", 0),
    now: integer("now", 1),
    transcriptMiB: integer("transcript-mib", 1),
    pollMs: integer("poll-ms", 1),
    listWeight,
    roundMs: integer("round-ms", 1),
    churnMs: integer("churn-ms", 1),
    warmupMs: integer("warmup-ms", 0),
    mode: values.mode,
    fixtureOnly: values["fixture-only"] ?? false,
    operatorModelPolicy: values["operator-model-policy"] ?? false,
    gatewayPreload: values["gateway-preload"] ? path.resolve(values["gateway-preload"]) : undefined,
    workerHeapSnapshot: values["worker-heap-snapshot"] ?? false,
    knowledgeWorkerHeap: values["knowledge-worker-heap"] ?? false,
    worktreeToolChurn: values["worktree-tool-churn"] ?? false,
    authAvailabilityStorm: values["auth-availability-storm"] ?? false,
    port,
    help: values.help,
  };
}

async function freePort(excluded: Set<number>) {
  // Bind probing cannot reserve across exec; the Gateway also refuses an occupied port.
  for (let attempt = 0; attempt < 100; attempt++) {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("No loopback port"));
        } else {
          resolve(address.port);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (port >= 40000 && !excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new Error("No free loopback port >=40000 found");
}

async function command(args: string[], logPath: string) {
  const fd = openSync(logPath, "wx", 0o600);
  try {
    const exit = await runManagedCommand({
      bin: process.execPath,
      args,
      cwd: root,
      stdio: ["ignore", fd, fd],
    });
    if (exit !== 0) {
      throw new Error(`Stress command exited ${exit}; see ${logPath}`);
    }
  } finally {
    closeSync(fd);
  }
}

async function main() {
  const options = parseStressOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts
  --base <built-repo> --candidate <built-repo> --output <new-dir>
  [--minutes 10 --pairs 2 --clients 65 --runs 4 --sessions 10800 --agents 4 --plugins 40]
  [--mode both|timing|allocation|retention --poll-ms 25000 --list-weight 16 --round-ms 60000 --churn-ms 6000]
  [--warmup-ms 60000 --seed 1711 --transcript-mib 128]
  [--aa-pairs 0: insert a baseline/baseline control after each of the first N pairs]
  [--operator-model-policy --auth-availability-storm]
  --smoke-seconds 30 is setup proof only, never performance evidence.
Timing and allocation are separate fresh-fixture passes. Pairs run AB then BA.
Without --base, run candidate once per mode. See team-shape-stress.md.`);
    return;
  }
  if (options.fixtureOnly) {
    const { generateTeamShapeStressFixture } = await import("./team-shape-stress-fixture.ts");
    const { summary } = await generateTeamShapeStressFixture({
      ...options,
      stateDir: options.output,
    });
    console.log(JSON.stringify(summary));
    return;
  }
  const builds = Object.fromEntries(
    Object.entries({ base: options.base, candidate: options.candidate })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([label, directory]) => {
        const entry = realpathSync(path.join(directory, "dist/entry.js"));
        const metadata = path.join(directory, "dist/build-info.json");
        return [
          label,
          {
            directory: realpathSync(directory),
            entry,
            entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
            buildInfo: existsSync(metadata) ? JSON.parse(readFileSync(metadata, "utf8")) : null,
          },
        ];
      }),
  );
  mkdirSync(path.dirname(options.output), { recursive: true });
  mkdirSync(options.output, { mode: 0o700 });
  const runs: StressRun[] = [];
  const manifest = {
    format: "openclaw-team-stress-v1",
    options,
    builds,
    node: process.version,
    order: "serial counterbalanced AB/BA; no CPU affinity on macOS",
    runs,
  };
  writeFileSync(path.join(options.output, "campaign.json"), JSON.stringify(manifest, null, 2));
  const modes = options.mode === "both" ? ["timing", "allocation"] : [options.mode];
  for (const mode of modes) {
    const schedule = Array.from({ length: options.base ? options.pairs : 1 }, (_, pair) => [
      { pair, control: false },
      ...(pair < options.aaPairs ? [{ pair, control: true }] : []),
    ]).flat();
    for (const { pair, control } of schedule) {
      const order: Array<"base" | "candidate"> = options.base
        ? pair % 2
          ? ["candidate", "base"]
          : ["base", "candidate"]
        : ["candidate"];
      for (const side of order) {
        const runName = `${mode}-${control ? "aa-" : ""}${pair + 1}-${side}`;
        const state = path.join(options.output, runName);
        const ports = new Set<number>();
        const port = await freePort(ports);
        ports.add(port + 1);
        const mockPort = await freePort(ports);
        console.log(`PREPARE ${runName}: ${options.sessions} sessions, ${options.clients} clients`);
        await command(
          [
            "--import",
            "./scripts/tsx.mjs",
            "scripts/perf/team-shape-stress.ts",
            "--fixture-only",
            ...(options.authAvailabilityStorm ? ["--auth-availability-storm"] : []),
            "--output",
            state,
            "--port",
            String(port),
            "--seed",
            String(options.seed),
            "--now",
            String(options.now),
            "--sessions",
            String(options.sessions),
            "--agents",
            String(options.agents),
            "--transcript-mib",
            String(options.transcriptMiB),
          ],
          path.join(options.output, `${runName}-fixture.log`),
        );
        console.log(`RUN ${runName}: ${options.durationMs / 60_000} minutes, port ${port}`);
        await command(
          [
            "--import",
            "./scripts/tsx.mjs",
            "scripts/perf/transcript-broadcast-measure.ts",
            "--state-dir",
            state,
            "--entry",
            builds[control ? "base" : side]!.entry,
            "--port",
            String(port),
            "--mock-port",
            String(mockPort),
            "--scenario",
            "memory-soak",
            "--team-stress",
            ...(options.knowledgeWorkerHeap ? ["--knowledge-worker-heap"] : []),
            ...(options.gatewayPreload ? ["--gateway-preload", options.gatewayPreload] : []),
            "--mixed-rpc",
            "--stress-tools",
            "--stress-subagents",
            ...(options.authAvailabilityStorm ? ["--auth-availability-storm"] : []),
            ...(options.worktreeToolChurn ? ["--worktree-tool-churn"] : []),
            ...(options.operatorModelPolicy ? ["--operator-model-policy"] : []),
            "--clients",
            String(options.clients),
            "--exact-clients",
            String(options.clients - 1),
            "--runs",
            String(options.runs),
            "--plugins",
            String(options.plugins),
            "--duration-ms",
            String(options.durationMs),
            "--warmup-ms",
            String(options.warmupMs),
            "--round-interval-ms",
            String(options.roundMs),
            "--list-interval-ms",
            String(options.pollMs),
            "--team-stress-churn-ms",
            String(options.churnMs),
            "--team-stress-list-weight",
            String(options.listWeight),
            "--poll-seed",
            String(options.seed),
            "--memory-interval-ms",
            "60000",
            "--retained-profile-ms",
            "0",
            "--reset-every-rounds",
            "0",
            "--chunks",
            "30",
            "--chunk-interval-ms",
            "20",
            "--prompt-kib",
            "8",
            "--worker-memory",
            ...(options.workerHeapSnapshot
              ? ["--worker-retained-heap", "--worker-heap-snapshot"]
              : []),
            "--diagnostics",
            ...(mode !== "timing" ? ["--team-stress-allocation-sampling"] : []),
            ...(mode === "retention" ? ["--team-stress-retention-sampling"] : []),
          ],
          path.join(options.output, `${runName}.log`),
        );
        const outputs = readdirSync(state).filter((name) => name.startsWith("broadcast-measure-"));
        if (outputs.length !== 1) {
          throw new Error(`Expected one measurement output in ${state}`);
        }
        const resultDir = path.join(state, outputs[0]!);
        runs.push(
          summarizeStressRun({
            resultDir,
            side,
            pair: pair + 1,
            mode,
            control,
            smoke: options.smoke,
          }),
        );
        writeFileSync(
          path.join(options.output, "campaign.json"),
          JSON.stringify(manifest, null, 2),
        );
        console.table(
          Object.entries(runs.at(-1)!.metrics)
            .filter(([metric]) => headlineMetrics.has(metric))
            .map(([metric, value]) => ({ metric, value: rounded(value) })),
        );
      }
    }
  }
  const comparison = compareStressRuns(runs);
  writeFileSync(path.join(options.output, "comparison.json"), JSON.stringify(comparison, null, 2));
  console.table(
    comparison
      .filter((row) => headlineMetrics.has(row.metric))
      .map((row) => ({
        metric: row.metric,
        mode: row.mode,
        control: row.control,
        base: rounded(row.base),
        candidate: rounded(row.candidate),
        delta: rounded(row.absolute),
        percent: rounded(row.percent),
        pairs: row.pairs,
      })),
  );
  console.log(`RESULT ${path.join(options.output, "campaign.json")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--restart-chaos")) {
    const { runRestartStress } = await import("./team-shape-restart-stress.ts");
    await runRestartStress(process.argv.slice(2));
  } else {
    await main();
  }
}
