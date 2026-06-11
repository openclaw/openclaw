import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBookWriterConfig } from "./config.js";
import { writeJsonFile } from "./files.js";
import type { OvernightRunReport } from "./overnight.js";
import {
  installBookWriterSchedule,
  runBookWriterSchedulerTick,
  type SchedulerCommandRunner,
  type SchedulerState,
} from "./scheduler.js";

async function tempOutputDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-book-writer-scheduler-"));
}

function schedulerPath(outputDir: string, file: string): string {
  return path.join(outputDir, "scheduler", file);
}

function completedOvernightReport(runId = "scheduled-run"): OvernightRunReport {
  return {
    status: "completed",
    runId,
    backlog: {
      generatedAt: "2026-05-18T05:00:00.000Z",
      entries: [],
    },
    gaps: [],
    createdAt: "2026-05-18T05:00:00.000Z",
  };
}

function gatewayCronJob(params: {
  id: string;
  name?: string;
  scriptPath: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
}): Record<string, unknown> {
  return {
    id: params.id,
    name: params.name ?? "Book Writer Overnight",
    description: `openclaw:book-writer-nightly ${params.scriptPath}`,
    enabled: params.enabled ?? true,
    schedule: {
      kind: "cron",
      expr: params.cron ?? "30 20 * * *",
      tz: params.timezone ?? "America/New_York",
    },
    payload: {
      kind: "command",
      command: params.scriptPath,
    },
  };
}

describe("book-writer scheduler", () => {
  it("writes explicit scheduler files without mutating cron by default", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const report = await installBookWriterSchedule({
      config,
      request: {
        runId: "nightly-book",
        model: "qwen2.5:32b",
        targetWords: 12000,
      },
      workingDir: "/tmp/openclaw-repo",
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(report.installed).toBe(false);
    expect(report.automationEnabled).toBe(false);
    expect(report.cronExpression).toBe("30 20 * * *");
    expect(report.workingDir).toBe("/tmp/openclaw-repo");
    expect(report.openclawCronCommand).toContain("cron");
    expect(report.openclawCronCommand).toContain("--command");
    const script = await fs.readFile(report.scriptPath, "utf8");
    expect(script).toContain("cd '/tmp/openclaw-repo'");
    expect(script).toContain("books");
    expect(script).toContain("scheduler-tick");
    expect(script).toContain("qwen2.5:32b");
    expect(script).not.toContain("--enable-autonomous-writing");
    await expect(fs.stat(report.manifestPath)).resolves.toBeTruthy();
    const state = JSON.parse(await fs.readFile(report.statePath, "utf8")) as SchedulerState;
    expect(state.consecutiveFailures).toBe(0);
  });

  it("can explicitly enable autonomous writing for a managed schedule", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const report = await installBookWriterSchedule({
      config,
      request: {
        runId: "nightly-book",
        model: "qwen2.5:32b",
        targetWords: 12000,
      },
      enableAutonomousWriting: true,
      workingDir: "/tmp/openclaw-repo",
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(report.automationEnabled).toBe(true);
    const script = await fs.readFile(report.scriptPath, "utf8");
    expect(script).toContain("--enable-autonomous-writing");
  });

  it("preserves non-secret OpenClaw env overrides in the generated script", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const report = await installBookWriterSchedule({
      config,
      request: {
        model: "qwen2.5:32b",
        targetWords: 12000,
      },
      workingDir: "/tmp/openclaw-repo",
      env: {
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-book-writer/config.json",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-book-writer/state",
        OPENCLAW_PROFILE: "dev",
        OPENCLAW_GATEWAY_TOKEN: "secret-token",
      },
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    const script = await fs.readFile(report.scriptPath, "utf8");
    expect(script).toContain("cd '/tmp/openclaw-repo'");
    expect(script).toContain("export OPENCLAW_CONFIG_PATH='/tmp/openclaw-book-writer/config.json'");
    expect(script).toContain("export OPENCLAW_STATE_DIR='/tmp/openclaw-book-writer/state'");
    expect(script).toContain("export OPENCLAW_PROFILE='dev'");
    expect(script).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(script).not.toContain("secret-token");
  });

  it("replaces only the managed system crontab block when explicitly requested", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    let installedCrontab = "";
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const runner: SchedulerCommandRunner = async (command, args, input) => {
      calls.push({ command, args, input });
      if (args[0] === "-l") {
        return {
          stdout: [
            "0 1 * * * /usr/bin/true",
            "# BEGIN OPENCLAW BOOK WRITER",
            "old managed line",
            "# END OPENCLAW BOOK WRITER",
            "",
          ].join("\n"),
          stderr: "",
          code: 0,
        };
      }
      installedCrontab = input ?? "";
      return { stdout: "", stderr: "", code: 0 };
    };

    const report = await installBookWriterSchedule({
      config,
      request: { model: "qwen2.5:32b" },
      installSystemCron: true,
      commandRunner: runner,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(report.installed).toBe(true);
    expect(calls.map((call) => call.args.join(" "))).toEqual(["-l", "-"]);
    expect(installedCrontab).toContain("0 1 * * * /usr/bin/true");
    expect(installedCrontab).toContain("# BEGIN OPENCLAW BOOK WRITER");
    expect(installedCrontab).toContain(report.systemCronLine);
    expect(installedCrontab).not.toContain("old managed line");
  });

  it("creates and verifies a managed Gateway cron job without duplicates", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const scriptPath = schedulerPath(outputDir, "book-writer-nightly.sh");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: SchedulerCommandRunner = async (command, args) => {
      calls.push({ command, args });
      const cronCommand = args.slice(1).join(" ");
      if (cronCommand === "cron list --all --json") {
        return { stdout: JSON.stringify({ jobs: [] }), stderr: "", code: 0 };
      }
      if (cronCommand.startsWith("cron add ")) {
        return {
          stdout: JSON.stringify({ job: gatewayCronJob({ id: "cron-book-writer", scriptPath }) }),
          stderr: "",
          code: 0,
        };
      }
      if (cronCommand === "cron show cron-book-writer --json") {
        return {
          stdout: JSON.stringify(gatewayCronJob({ id: "cron-book-writer", scriptPath })),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected command: ${cronCommand}`, code: 1 };
    };

    const report = await installBookWriterSchedule({
      config,
      request: { model: "qwen2.5:32b" },
      registerGatewayCron: true,
      commandRunner: runner,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(report.gatewayCron?.status).toBe("created");
    expect(report.gatewayCron?.action).toBe("create");
    expect(report.gatewayCron?.verified).toBe(true);
    expect(report.gatewayCron?.matchedJobId).toBe("cron-book-writer");
    expect(calls.map((call) => call.args.slice(1, 3).join(" "))).toEqual([
      "cron list",
      "cron add",
      "cron show",
    ]);
  });

  it("updates an existing managed Gateway cron job instead of creating another", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const scriptPath = schedulerPath(outputDir, "book-writer-nightly.sh");
    const mutationVerbs: string[] = [];
    const runner: SchedulerCommandRunner = async (_command, args) => {
      const cronCommand = args.slice(1).join(" ");
      if (cronCommand === "cron list --all --json") {
        return {
          stdout: JSON.stringify({
            jobs: [gatewayCronJob({ id: "cron-existing", scriptPath, enabled: false })],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (cronCommand.startsWith("cron edit cron-existing ")) {
        mutationVerbs.push("edit");
        return {
          stdout: JSON.stringify({ job: gatewayCronJob({ id: "cron-existing", scriptPath }) }),
          stderr: "",
          code: 0,
        };
      }
      if (cronCommand === "cron show cron-existing --json") {
        return {
          stdout: JSON.stringify(gatewayCronJob({ id: "cron-existing", scriptPath })),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected command: ${cronCommand}`, code: 1 };
    };

    const report = await installBookWriterSchedule({
      config,
      request: { model: "qwen2.5:32b" },
      registerGatewayCron: true,
      commandRunner: runner,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(report.gatewayCron?.status).toBe("updated");
    expect(report.gatewayCron?.action).toBe("update");
    expect(report.gatewayCron?.verified).toBe(true);
    expect(mutationVerbs).toEqual(["edit"]);
    expect(report.gatewayCron?.editCommand?.join(" ")).toContain("cron edit cron-existing");
  });

  it("blocks Gateway cron registration on unmarked same-name conflicts", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const calls: string[] = [];
    const runner: SchedulerCommandRunner = async (_command, args) => {
      const cronCommand = args.slice(1).join(" ");
      calls.push(cronCommand);
      if (cronCommand === "cron list --all --json") {
        return {
          stdout: JSON.stringify({
            jobs: [
              {
                id: "cron-conflict",
                name: "Book Writer Overnight",
                enabled: true,
                schedule: { kind: "cron", expr: "0 1 * * *", tz: "America/New_York" },
                payload: { kind: "command", command: "/tmp/other-script.sh" },
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected command: ${cronCommand}`, code: 1 };
    };

    const report = await installBookWriterSchedule({
      config,
      request: { model: "qwen2.5:32b" },
      registerGatewayCron: true,
      commandRunner: runner,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(report.gatewayCron?.status).toBe("blocked");
    expect(report.gatewayCron?.action).toBe("none");
    expect(report.gatewayCron?.conflictJobIds).toEqual(["cron-conflict"]);
    expect(calls).toEqual(["cron list --all --json"]);
  });

  it("skips overlapping scheduler ticks while an active lock is fresh", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const statePath = schedulerPath(outputDir, "scheduler-state.json");
    const lockDir = schedulerPath(outputDir, "overnight.lock");
    await fs.mkdir(lockDir, { recursive: true });
    await writeJsonFile(statePath, {
      activeLock: {
        pid: 123,
        startedAt: "2026-05-18T04:58:00.000Z",
      },
      consecutiveFailures: 0,
      updatedAt: "2026-05-18T04:58:00.000Z",
    } satisfies SchedulerState);

    const report = await runBookWriterSchedulerTick({
      config,
      request: { model: "qwen2.5:32b" },
      automationEnabled: true,
      now: new Date("2026-05-18T05:00:00.000Z"),
      runner: async () => {
        throw new Error("runner should not execute while locked");
      },
    });

    expect(report.status).toBe("skipped-overlap");
    expect(report.lockAcquired).toBe(false);
    expect(report.gaps.join(" ")).toContain("already running");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as SchedulerState;
    expect(state.lastStatus).toBe("skipped-overlap");
  });

  it("skips scheduled drafting by default when autonomous writing is disabled", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const report = await runBookWriterSchedulerTick({
      config,
      request: { model: "qwen2.5:32b" },
      now: new Date("2026-05-18T05:00:00.000Z"),
      runner: async () => {
        throw new Error("runner should not execute while automation is disabled");
      },
    });

    expect(report.status).toBe("skipped-disabled");
    expect(report.lockAcquired).toBe(false);
    expect(report.gaps.join(" ")).toContain("disabled");
    const state = JSON.parse(
      await fs.readFile(schedulerPath(outputDir, "scheduler-state.json"), "utf8"),
    ) as SchedulerState;
    expect(state.lastStatus).toBe("skipped-disabled");
  });

  it("recovers missed runs and clears stale locks after a completed tick", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const statePath = schedulerPath(outputDir, "scheduler-state.json");
    await writeJsonFile(statePath, {
      lastSuccessfulAt: "2026-05-16T05:00:00.000Z",
      consecutiveFailures: 1,
      updatedAt: "2026-05-16T05:00:00.000Z",
    } satisfies SchedulerState);

    const report = await runBookWriterSchedulerTick({
      config,
      request: { model: "qwen2.5:32b" },
      automationEnabled: true,
      missedAfterHours: 26,
      now: new Date("2026-05-18T06:00:00.000Z"),
      runner: async () => completedOvernightReport("recovered-run"),
    });

    expect(report.status).toBe("completed");
    expect(report.missedRunDetected).toBe(true);
    expect(report.state.lastRunId).toBe("recovered-run");
    expect(report.state.consecutiveFailures).toBe(0);
    await expect(
      fs.stat(schedulerPath(outputDir, "scheduler-tick-report.json")),
    ).resolves.toBeTruthy();
    await expect(fs.stat(schedulerPath(outputDir, "overnight.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
