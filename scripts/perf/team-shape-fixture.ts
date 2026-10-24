// Offline synthetic state only. Run with node --import ./scripts/tsx.mjs.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../src/daemon/constants.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { runManagedCommand } from "../lib/managed-child-process.mts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

export function parseTeamShapeOptions(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "state-dir": { type: "string" },
      sessions: { type: "string" },
      runs: { type: "string" },
      "settled-runs": { type: "boolean" },
      approvals: { type: "string" },
      cron: { type: "string" },
      "cron-announce-last": { type: "boolean" },
      projects: { type: "string" },
      "local-placements": { type: "string" },
      seed: { type: "string" },
      now: { type: "string" },
      "transcript-mib": { type: "string" },
      "long-transcript-entries": { type: "string" },
      "long-transcript-sessions": { type: "string" },
      "worktree-files": { type: "string" },
      "worktree-file-bytes": { type: "string" },
      "worktree-install-failure": { type: "boolean" },
      "worktree-cold-commits": { type: "string" },
      "nested-repository": { type: "boolean" },
      "github-options-connected": { type: "boolean" },
      port: { type: "string" },
      launch: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const integer = (name: keyof typeof values, fallback: number, min = 0) =>
    parseStrictIntegerOption({
      raw: String(values[name] ?? ""),
      label: `--${name}`,
      fallback,
      min,
    });
  const port = integer("port", 40967, 40000);
  if (port > 65535) {
    throw new Error("--port must be between 40000 and 65535");
  }
  if (!values.help && !values["state-dir"]) {
    throw new Error("--state-dir is required and must name a new directory");
  }
  const sessions = integer("sessions", 5_000, 1);
  const retainedRuns = integer("runs", 6_000);
  if (retainedRuns > 0 && sessions < 2) {
    throw new Error("--runs requires at least two sessions (parent and child)");
  }
  const cronJobs = integer("cron", 100);
  const cronAnnounceLast = values["cron-announce-last"] ?? false;
  if (cronAnnounceLast && (sessions < 2 || cronJobs === 0)) {
    throw new Error("--cron-announce-last requires at least two sessions and one cron job");
  }
  const transcriptBytes = integer("transcript-mib", 64) * 1024 * 1024;
  if (!Number.isSafeInteger(transcriptBytes)) {
    throw new Error("--transcript-mib exceeds the safe byte range");
  }
  const longTranscriptEntries = integer("long-transcript-entries", 0);
  const longTranscriptSessions = Math.min(integer("long-transcript-sessions", 4, 1), sessions);
  // Includes text, signatures and envelope headroom; keep opt-in stress writes bounded.
  if (
    longTranscriptEntries > 0 &&
    transcriptBytes + longTranscriptEntries * longTranscriptSessions * 18 * 1024 > 1024 ** 3
  ) {
    throw new Error("Long transcripts plus --transcript-mib must fit within 1 GiB");
  }
  const projects = integer("projects", 12);
  const localPlacements = integer("local-placements", 0);
  if (localPlacements > sessions) {
    throw new Error("--local-placements must not exceed --sessions");
  }
  const worktreeFiles = integer("worktree-files", 0);
  const worktreeFileBytes = integer("worktree-file-bytes", 0);
  if (worktreeFiles * worktreeFileBytes > 256 * 1024 ** 2) {
    throw new Error("Synthetic worktree contents must fit within 256 MiB");
  }
  const worktreeColdCommits = integer("worktree-cold-commits", 0);
  if (worktreeFiles > 500_000) {
    throw new Error("--worktree-files must not exceed 500000 files");
  }
  if (
    (worktreeFiles > 0 ||
      worktreeColdCommits > 0 ||
      values["nested-repository"] ||
      values["worktree-install-failure"]) &&
    projects === 0
  ) {
    throw new Error("Worktree fixture options require at least one project");
  }
  if (values["github-options-connected"] && projects === 0) {
    throw new Error("--github-options-connected requires at least one project");
  }
  return {
    stateDir: path.resolve(values["state-dir"] ?? "."),
    sessions,
    retainedRuns,
    settledRuns: values["settled-runs"] ?? false,
    localPlacements,
    approvals: integer("approvals", 200),
    cronJobs,
    cronAnnounceLast,
    projects,
    seed: integer("seed", 967),
    now: integer("now", Date.parse("2026-10-13T12:00:00Z"), 1),
    transcriptBytes,
    longTranscriptEntries,
    longTranscriptSessions,
    worktreeFiles,
    worktreeFileBytes,
    worktreeColdCommits,
    worktreeInstallFailure: values["worktree-install-failure"] ?? false,
    nestedRepository: values["nested-repository"] ?? false,
    githubOptionsConnected: values["github-options-connected"] ?? false,
    port,
    launch: values.launch ?? false,
    help: values.help ?? false,
  };
}

export async function generateTeamShapeFixture(options: ReturnType<typeof parseTeamShapeOptions>) {
  const startedAt = performance.now();
  const { stateDir } = options;
  mkdirSync(path.dirname(stateDir), { recursive: true });
  // Exclusive creation refuses existing state, including empty directories and symlinks.
  mkdirSync(stateDir, { mode: 0o700 });
  const configPath = path.join(stateDir, "openclaw.json");
  for (const directory of ["home", "tmp", "workspace"]) {
    mkdirSync(path.join(stateDir, directory));
  }
  const profile = `team-shape-${options.port}`;
  const env = {
    ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
    OPENCLAW_STATE_DIR: stateDir,
    TMPDIR: path.join(stateDir, "tmp"),
    TMP: path.join(stateDir, "tmp"),
    TEMP: path.join(stateDir, "tmp"),
    USERPROFILE: path.join(stateDir, "home"),
    OPENCLAW_SKIP_CHANNELS: "1",
    // Dev builds inspect service ownership; never select the host's default Gateway.
    OPENCLAW_PROFILE: profile,
    OPENCLAW_LAUNCHD_LABEL: resolveGatewayLaunchAgentLabel(profile),
    OPENCLAW_SYSTEMD_UNIT: resolveGatewaySystemdServiceName(profile),
    OPENCLAW_WINDOWS_TASK_NAME: resolveGatewayWindowsTaskName(profile),
    ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
  };
  // Git and source resolvers inherit this process: routing variables must not escape the fixture.
  const previousEnv = process.env;
  try {
    process.env = { ...env };
    const config = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: options.port,
        auth: { mode: "none" },
        controlUi: { enabled: false },
        tailscale: { mode: "off" },
      },
      discovery: { mdns: { mode: "off" } },
      browser: { enabled: false },
      plugins: { enabled: false },
      cron: { enabled: false },
      update: { checkOnStart: false },
      agents: {
        entries: { main: { workspace: path.join(stateDir, "workspace") } },
      },
      logging: { file: path.join(stateDir, "gateway.log") },
    } satisfies OpenClawConfig;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    // Resolvers capture environment on import; bind the fixture before loading storage owners.
    const [{ seedTeamShapeSessions }, { seedTeamShapeExtras }, agentDb, stateDb] =
      await Promise.all([
        import("./team-shape-sessions.ts"),
        import("./team-shape-extras.ts"),
        import("../../src/state/openclaw-agent-db.js"),
        import("../../src/state/openclaw-state-db.js"),
      ]);
    const agent = agentDb.openOpenClawAgentDatabase({ agentId: "main" });
    const state = stateDb.openOpenClawStateDatabase();
    let summary;
    try {
      const seeded = await seedTeamShapeSessions(options);
      const extras = await seedTeamShapeExtras({ ...options, sessions: seeded.sessions });
      agent.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const { sessions, generationMs: sessionGenerationMs, ...sessionMetrics } = seeded;
      summary = {
        format: "openclaw-team-shape-v1",
        profile,
        seed: options.seed,
        now: options.now,
        sessionCount: sessions.length,
        ...sessionMetrics,
        sessionGenerationMs,
        ...extras,
        agentDatabaseBytes: statSync(agent.path).size,
        stateDatabaseBytes: statSync(state.path).size,
        generationMs: performance.now() - startedAt,
        node: process.version,
      };
    } finally {
      await agentDb.closeOpenClawAgentDatabasesAsync();
      await stateDb.closeOpenClawStateDatabaseAsync();
    }
    writeFileSync(
      path.join(stateDir, "team-shape-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    return { summary, env };
  } finally {
    process.env = previousEnv;
  }
}

async function main() {
  const options = parseTeamShapeOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts --state-dir <new-dir> [options]
  --sessions 5000 --runs 6000 --approvals 200 --cron 100 --projects 12
  --settled-runs           Keep run history terminal and delivered, without a subagent recovery backlog.
  --local-placements 0    Retain local placement rows for startup orphan-workspace discovery.
  --cron-announce-last     Seed disabled isolated cron jobs with announce/last delivery.
  --seed 967 --now <epoch-ms> --transcript-mib 64
  --long-transcript-entries 0 --long-transcript-sessions 4
  --worktree-files 0 --worktree-file-bytes 0 --nested-repository
  --worktree-cold-commits 0  Add same-tree commits for cold dependency-template measurements.
  --worktree-install-failure  Add a synthetic pnpm package that cannot install in the probe image.
  --github-options-connected  Register synthetic GitHub origins for dashboard measurements.
  --launch --port 40967    Start an isolated loopback dev Gateway after generation.
State is synthetic and must not exist. Existing state is never overwritten.
Transcript MiB is logical text before compression; actual database sizes are reported.
Long transcript entries append 1 KiB messages with distinct 16 KiB assistant thinking signatures.
Worktree files are unchanged tracked files in the first project (maximum 500000).
Optional deterministic distinct contents are capped at 256 MiB across that inventory.
Linux generation pauses at 1 GiB of dirty pages and stops at 2 GiB.`);
    return;
  }
  const { summary, env } = await generateTeamShapeFixture(options);
  console.log(JSON.stringify(summary, null, 2));
  if (options.launch) {
    console.log(`Starting fixture Gateway at ws://127.0.0.1:${options.port}`);
    const result = await runManagedCommand({
      bin: "pnpm",
      args: ["openclaw", "gateway", "run", "--bind", "loopback", "--port", String(options.port)],
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env,
      stdio: "inherit",
      requireProcessTreeExit: process.platform !== "win32",
    });
    process.exitCode = typeof result === "number" ? result : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
