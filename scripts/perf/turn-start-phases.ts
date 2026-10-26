// Real dist Gateway turn-start phases: sessions.create with an initial message defers
// default-branch worktree preparation into chat.send; warm turns call chat.send directly.
// Build the revision first; run each arm into a new directory:
// node --import ./scripts/tsx.mjs scripts/perf/turn-start-phases.ts --output .local/turn-start-base --port 41920
// Uses canonical Team-shaped fixtures (10,800 sessions), 40 bundled plugins, 65 clients,
// eight exact subscribers, sidebar/list/search churn, four simultaneous turns, an origin README change before each fresh burst, and a
// 200 ms mock first-token delay. --unchanged-origin keeps the remote fixed; --cpu-profile
// records a separate diagnostic CPU/Git-trace pass; --git-trace records Git Trace2 alone.
// --state-dir reuses an existing
// synthetic fixture after a setup failure; --output must always be new. Phase timings exclude
// provider delay. Fresh bursts are separated by 31s to expire the base-refresh TTL. p95 at 40 samples is descriptive, not a regression gate. All state is synthetic.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { generateTeamShapeStressFixture } from "./team-shape-stress-fixture.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "state-dir": { type: "string" },
    "start-file": { type: "string" },
    port: { type: "string", default: "41920" },
    entry: { type: "string", default: "dist/entry.js" },
    "cpu-profile": { type: "boolean", default: false },
    "git-trace": { type: "boolean", default: false },
    "unchanged-origin": { type: "boolean", default: false },
    "cold-rounds": { type: "string", default: "10" },
    "warm-rounds": { type: "string", default: "10" },
  },
});
if (!values.output) {
  throw new Error("--output must name a new directory");
}
const output = path.resolve(values.output);
const port = Number(values.port);
const coldRounds = Number(values["cold-rounds"]);
const warmRounds = Number(values["warm-rounds"]);
if (
  ![port, coldRounds, warmRounds].every(Number.isSafeInteger) ||
  port < 40000 ||
  port > 65532 ||
  coldRounds < 1 ||
  warmRounds < 1
) {
  throw new Error("Use port 40000–65532 and positive integer round counts");
}
mkdirSync(output);
const entry = path.resolve(values.entry);
const stateDir = values["state-dir"]
  ? path.resolve(values["state-dir"])
  : path.join(output, "state");
const before = { at: new Date().toISOString(), load: loadavg() };
const identity = {
  workload: {
    sessions: 10800,
    plugins: 40,
    clients: 65,
    runs: 4,
    coldRounds,
    warmRounds,
    freshRoundGapMs: 31000,
    warmRoundGapMs: 0,
    files: 3000,
    fileBytes: 256,
    providerDelayMs: 200,
    advanceOrigin: !values["unchanged-origin"],
    cpuProfile: values["cpu-profile"],
    gitTrace: values["git-trace"] || values["cpu-profile"],
  },
  stateDir,
  entry,
  entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
  worktreeRuntime: Object.fromEntries(
    readdirSync(path.dirname(entry))
      .filter(
        (name) => name.startsWith("git-worktree-operations.runtime-") && name.endsWith(".mjs"),
      )
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(path.join(path.dirname(entry), name)))
          .digest("hex"),
      ]),
  ),
  checkoutRuntime: Object.fromEntries(
    readdirSync(path.dirname(entry))
      .filter((name) => /^(?:service|checkout-apfs)-.*\.mjs$/.test(name))
      .flatMap((name) => {
        const contents = readFileSync(path.join(path.dirname(entry), name));
        return contents.includes("copyApfsCloneIndex")
          ? [[name, createHash("sha256").update(contents).digest("hex")]]
          : [];
      }),
  ),
  revision: spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
  }).stdout.trim(),
};
writeFileSync(path.join(output, "identity.json"), JSON.stringify(identity, null, 2));
if (!values["state-dir"]) {
  await generateTeamShapeStressFixture({
    stateDir,
    port,
    seed: 1823,
    now: 1792961880000,
    worktreeFiles: 3000,
    worktreeFileBytes: 256,
    worktreeLocalOrigin: true,
  });
}
const previousProbeDirs = new Set(readdirSync(stateDir));
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./scripts/tsx.mjs",
    "scripts/perf/transcript-broadcast-measure.ts",
    "--state-dir",
    stateDir,
    "--entry",
    entry,
    "--port",
    String(port),
    "--mock-port",
    String(port + 2),
    ...(values["cpu-profile"] ? ["--cpu-profile"] : []),
    ...(values["git-trace"] || values["cpu-profile"] ? ["--git-trace"] : []),
    ...(values["start-file"] ? ["--start-file", path.resolve(values["start-file"])] : []),
    ...(values["unchanged-origin"] ? [] : ["--turn-start-advance-origin"]),
    "--scenario",
    "chat.send",
    "--turn-start-phases",
    "--diagnostics",
    "--prep-trace",
    "--plugins",
    "40",
    "--clients",
    "65",
    "--exact-clients",
    "8",
    "--runs",
    "4",
    "--rounds",
    String(coldRounds + warmRounds),
    "--cold-session-rounds",
    String(coldRounds),
    "--stress-tools",
    "--mixed-rpc",
    "--list-filter-churn",
    "--row-mode",
    "sidebar",
    "--poll-between-rounds",
    "--list-interval-ms",
    "1000",
    "--poll-seed",
    "1823",
    "--round-interval-ms",
    "31000",
    "--provider-delay-ms",
    "200",
    "--chunks",
    "10",
    "--chunk-interval-ms",
    "20",
    "--prompt-kib",
    "8",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
  },
);
if (result.status !== 0) {
  throw new Error(`Gateway probe failed: ${result.status ?? result.error}`);
}
const probeDir = readdirSync(stateDir).find(
  (name) => name.startsWith("broadcast-measure-") && !previousProbeDirs.has(name),
);
if (!probeDir) {
  throw new Error("Missing Gateway probe output");
}
const phaseFile = path.join(stateDir, probeDir, "turn-start-phases.json");
const captured = JSON.parse(readFileSync(phaseFile, "utf8")) as {
  phases: Array<{
    round: number;
    name: string;
    durationMs: number;
    startedAt: number;
    endedAt: number;
    details?: Record<string, unknown> & { stage?: string };
  }>;
};
const groups = new Map<string, number[]>();
function add(key: string, value: number) {
  const samples = groups.get(key) ?? [];
  samples.push(value);
  groups.set(key, samples);
}
for (const phase of captured.phases) {
  const cohort = phase.round < coldRounds ? "fresh" : "warm";
  add(`${cohort}/${phase.details?.stage ?? "worktree"}/${phase.name}`, phase.durationMs);
  if (phase.name === "worktree.preparation") {
    for (const [name, duration] of Object.entries(phase.details ?? {})) {
      if (typeof duration === "number" && !name.startsWith("template.")) {
        add(`${cohort}/worktree/${name}`, duration);
      }
    }
  }
}
const summary = [...groups]
  .map(([phase, samples]) => {
    samples.sort((a, b) => a - b);
    return {
      phase,
      count: samples.length,
      p50: samples[Math.ceil(samples.length * 0.5) - 1],
      p95: samples[Math.ceil(samples.length * 0.95) - 1],
      max: samples.at(-1),
    };
  })
  .toSorted((a, b) => b.p50! - a.p50!);
if (!summary.length) {
  throw new Error("No production phase diagnostics captured");
}
writeFileSync(
  path.join(output, "summary.json"),
  JSON.stringify(
    { identity, before, after: { at: new Date().toISOString(), load: loadavg() }, summary },
    null,
    2,
  ),
);
console.table(summary.slice(0, 50));

if (values["git-trace"] || values["cpu-profile"]) {
  type GitTraceEvent = {
    event: string;
    sid: string;
    time: string;
    argv?: string[];
    t_abs?: number;
    code?: number;
  };
  const traceDir = path.join(stateDir, probeDir, "git-trace");
  const commands = readdirSync(traceDir).flatMap((filename) => {
    const events = readFileSync(path.join(traceDir, filename), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GitTraceEvent);
    const start = events.find((event) => event.event === "start");
    const exit = events.find((event) => event.event === "exit");
    if (!start?.argv || typeof exit?.t_abs !== "number") {
      return [];
    }
    const args = start.argv.slice(1);
    let commandIndex = 0;
    while (commandIndex < args.length) {
      const arg = args[commandIndex]!;
      if (["-C", "-c", "--git-dir", "--work-tree", "--config-env"].includes(arg)) {
        commandIndex += 2;
      } else if (arg.startsWith("--")) {
        commandIndex++;
      } else {
        break;
      }
    }
    const executable = path.basename(start.argv[0] ?? "git");
    const command = executable === "git" ? (args[commandIndex] ?? "unknown") : executable;
    const commandArgs = executable === "git" ? args.slice(commandIndex + 1) : args;
    const argvClass = [
      command,
      ...(["worktree", "remote", "sparse-checkout"].includes(command)
        ? commandArgs.slice(0, 1)
        : []),
      ...commandArgs.filter((arg) => arg.startsWith("-")).map((arg) => arg.split("=")[0]),
    ].join(" ");
    const startedAt = Date.parse(start.time);
    const containing = captured.phases.find(
      (phase) => phase.startedAt <= startedAt && phase.endedAt >= startedAt,
    );
    return [
      {
        argvClass,
        argv: start.argv,
        sid: start.sid,
        nested: start.sid.includes("/"),
        startedAt,
        durationMs: exit.t_abs * 1000,
        code: exit.code,
        round: containing?.round,
        cohort: containing ? (containing.round < coldRounds ? "fresh" : "warm") : "setup-or-gap",
      },
    ];
  });
  writeFileSync(path.join(output, "git-commands.json"), JSON.stringify(commands, null, 2));
  const classes = new Map<string, number[]>();
  for (const command of commands) {
    const key = `${command.cohort}/${command.nested ? "nested" : "direct"}/${command.argvClass}`;
    const samples = classes.get(key) ?? [];
    samples.push(command.durationMs);
    classes.set(key, samples);
  }
  const gitSummary = [...classes]
    .map(([argvClass, samples]) => {
      samples.sort((a, b) => a - b);
      return {
        argvClass,
        count: samples.length,
        totalMs: samples.reduce((sum, value) => sum + value, 0),
        p50: samples[Math.ceil(samples.length * 0.5) - 1],
        p95: samples[Math.ceil(samples.length * 0.95) - 1],
        max: samples.at(-1),
      };
    })
    .toSorted((a, b) => b.totalMs - a.totalMs);
  writeFileSync(path.join(output, "git-summary.json"), JSON.stringify(gitSummary, null, 2));
  console.table(gitSummary.slice(0, 40));
}
