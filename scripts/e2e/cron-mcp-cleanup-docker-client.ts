import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { assert, connectGateway, waitFor } from "./mcp-channels-harness.ts";

const execFileAsync = promisify(execFile);

type CronJob = { id?: string };
type CronRunResult = { ok?: boolean; enqueued?: boolean; runId?: string };

async function readProbePid(pidPath: string): Promise<number | undefined> {
  try {
    const raw = (await fs.readFile(pidPath, "utf-8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function describeProbePid(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "args="]);
    const args = stdout.trim();
    return args.length > 0 ? args : undefined;
  } catch {
    return undefined;
  }
}

async function waitForProbePid(pidPath: string): Promise<number | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const pid = await readProbePid(pidPath);
    if (pid) {
      return pid;
    }
    await delay(100);
  }
  return undefined;
}

async function waitForProbeExit(pid: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const args = await describeProbePid(pid);
    if (!args || !args.includes("openclaw-cron-mcp-cleanup-probe")) {
      return;
    }
    await delay(100);
  }
  const args = await describeProbePid(pid);
  throw new Error(`cron MCP probe process still alive after run: pid=${pid} args=${args}`);
}

async function main() {
  const gatewayUrl = process.env.GW_URL?.trim();
  const gatewayToken = process.env.GW_TOKEN?.trim();
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const pidPath = path.join(stateDir, "cron-mcp-cleanup", "probe.pid");
  assert(gatewayUrl, "missing GW_URL");
  assert(gatewayToken, "missing GW_TOKEN");

  const gateway = await connectGateway({ url: gatewayUrl, token: gatewayToken });
  try {
    const job = await gateway.request<CronJob>("cron.add", {
      name: "cron mcp cleanup docker e2e",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "agentTurn",
        message: "Use available context and then stop.",
        timeoutSeconds: 12,
        lightContext: true,
      },
      delivery: { mode: "none" },
    });
    assert(job.id, `cron.add did not return an id: ${JSON.stringify(job)}`);

    const run = await gateway.request<CronRunResult>("cron.run", {
      id: job.id,
      mode: "force",
    });
    assert(
      run.ok === true && run.enqueued === true,
      `cron.run was not enqueued: ${JSON.stringify(run)}`,
    );

    const started = await waitFor(
      "cron started event",
      () =>
        gateway.events.find(
          (entry) =>
            entry.event === "cron" &&
            entry.payload.jobId === job.id &&
            entry.payload.action === "started",
        )?.payload,
      60_000,
    );
    assert(started, "missing cron started event");

    const pid = await waitForProbePid(pidPath);
    assert(
      pid,
      `cron MCP probe did not start; missing pid file at ${pidPath}; events=${JSON.stringify(
        gateway.events.slice(-10),
      )}`,
    );
    const initialArgs = await describeProbePid(pid);
    assert(
      initialArgs?.includes("openclaw-cron-mcp-cleanup-probe"),
      `cron MCP probe pid did not look like the test server: pid=${pid} args=${initialArgs}`,
    );

    const finished = await waitFor(
      "cron finished event",
      () =>
        gateway.events.find(
          (entry) =>
            entry.event === "cron" &&
            entry.payload.jobId === job.id &&
            entry.payload.action === "finished",
        )?.payload,
      90_000,
    );
    assert(finished, "missing cron finished event");

    await waitForProbeExit(pid);
    process.stdout.write(
      JSON.stringify({
        ok: true,
        jobId: job.id,
        runId: run.runId,
        pid,
        status: finished.status,
      }) + "\n",
    );
  } finally {
    await gateway.close();
  }
}

await main();
