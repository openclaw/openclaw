import { execSync } from "node:child_process";
import type { Command } from "commander";
import { tailLogs } from "./logs.js";
import { dashboardPath } from "./paths.js";
import { formatStatus, status } from "./status.js";
import { isProcessAlive, readPid, runSupervisor, stopSupervisor, writePid } from "./supervisor.js";

const DEFAULT_PORT = 3001;

interface StartOptions {
  port?: string;
  adopt?: boolean;
  public?: boolean;
  dev?: boolean;
}

interface LogsOptions {
  follow?: boolean;
  lines?: string;
  err?: boolean;
}

interface StatusOptions {
  port?: string;
  public?: boolean;
}

function resolvePort(flag: string | undefined): number {
  const fromFlag = flag != null ? Number(flag) : Number.NaN;
  if (Number.isFinite(fromFlag) && fromFlag > 0) {
    return fromFlag;
  }
  const fromEnv = process.env.OPENCLAW_DASHBOARD_PORT;
  if (fromEnv != null) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
}

function lsofPid(port: number): number | null {
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) {
      return null;
    }
    const pid = Number.parseInt(out.split(/\s+/)[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function registerDashboardCli(program: Command): void {
  const dashboard = program
    .command("dashboard")
    .description("Supervise the Mission Control dashboard (Next.js companion)");

  dashboard
    .command("start")
    .description("Spawn Mission Control and supervise it until stopped")
    .option("--port <port>", "Override port (default 3001 / OPENCLAW_DASHBOARD_PORT)")
    .option("--adopt", "Take over an already-running dashboard on the target port", false)
    .option("--public", "Run with MISSION_CONTROL_PUBLIC=1 (requires MC_AUTH_TOKEN)", false)
    .option("--dev", "Spawn 'npm run dev' instead of 'node server.js'", false)
    .action(async (opts: StartOptions) => {
      const port = resolvePort(opts.port);
      const cwd = dashboardPath();
      const incumbent = lsofPid(port);
      if (incumbent != null && incumbent !== process.pid) {
        if (opts.adopt) {
          writePid(incumbent);
          process.stdout.write(
            `adopted dashboard already running on :${port} (pid ${incumbent})\n`,
          );
          return;
        }
        process.stderr.write(
          `dashboard already running on :${port} (pid ${incumbent}). Pass --adopt to take it over, or stop it first.\n`,
        );
        process.exitCode = 1;
        return;
      }
      const publicMode = Boolean(opts.public) || process.env.MISSION_CONTROL_PUBLIC === "1";
      await runSupervisor({
        env: {
          port,
          publicMode,
          authToken: process.env.MC_AUTH_TOKEN,
          dev: Boolean(opts.dev),
        },
        cwd,
      });
    });

  dashboard
    .command("stop")
    .description("Stop the supervised dashboard process")
    .action(async () => {
      const result = await stopSupervisor();
      if (result.pid == null) {
        process.stdout.write("no dashboard running\n");
      } else {
        process.stdout.write(`stopped dashboard (pid ${result.pid})\n`);
      }
    });

  dashboard
    .command("status")
    .description("Report the supervised dashboard's PID, intent, port, and health")
    .option("--port <port>", "Probe a non-default port")
    .option("--public", "Treat the dashboard as public-mode for the auth header", false)
    .action(async (opts: StatusOptions) => {
      const port = resolvePort(opts.port);
      const publicMode = Boolean(opts.public) || process.env.MISSION_CONTROL_PUBLIC === "1";
      const result = await status({
        port,
        publicMode,
        authToken: process.env.MC_AUTH_TOKEN,
      });
      process.stdout.write(`${formatStatus(result)}\n`);
      const pid = readPid();
      if (pid != null && !isProcessAlive(pid)) {
        process.exitCode = 1;
      }
    });

  dashboard
    .command("logs")
    .description("Tail the supervised dashboard's combined log")
    .option("--follow", "Stream new lines as they're written", false)
    .option("--lines <n>", "Initial line count (default 50)")
    .option("--err", "Tail dashboard.err.log instead of dashboard.out.log", false)
    .action(async (opts: LogsOptions) => {
      const lines = opts.lines != null ? Number(opts.lines) : undefined;
      await tailLogs({
        follow: Boolean(opts.follow),
        lines: Number.isFinite(lines) ? lines : undefined,
        stream: opts.err ? "err" : "out",
      });
    });
}
