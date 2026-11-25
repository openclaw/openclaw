#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repository = "openclaw/openclaw";
const crabbox = process.env.CRABBOX_BIN || "crabbox";
const labelPattern = /^crabbox-frv-[a-f0-9]{12}$/u;
const profiles = {
  "ubuntu-latest": { type: "m7a.xlarge", arch: "amd64" },
  "ubuntu-24.04": { type: "m7a.xlarge", arch: "amd64" },
  "ubuntu-24.04-arm": { type: "m7g.xlarge", arch: "arm64" },
  "blacksmith-4vcpu-ubuntu-2404": { type: "c7a.xlarge", arch: "amd64" },
  "blacksmith-8vcpu-ubuntu-2404": { type: "c7a.2xlarge", arch: "amd64" },
  "blacksmith-16vcpu-ubuntu-2404": { type: "c7a.4xlarge", arch: "amd64" },
  "blacksmith-32vcpu-ubuntu-2404": { type: "c7a.8xlarge", arch: "amd64" },
};

function command(binary, args, { inherit = false, timeout = 30_000, includeStderr = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, {
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        accept(includeStderr ? stdout + stderr : stdout);
      } else {
        reject(new Error(`${binary} ${args[0]} failed (${signal || code}): ${stderr.trim()}`));
      }
    });
  });
}

async function github(path, method = "GET") {
  return JSON.parse(await command("gh", ["api", path, "--method", method]));
}

async function pages(path, key) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const response = await github(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    rows.push(...response[key]);
    if (response[key].length < 100) {
      return rows;
    }
  }
}

function capacityBaseline(capacity, label) {
  if (typeof capacity !== "string" || !capacity.startsWith(`${label}-`)) {
    return null;
  }
  const baseline = capacity.slice(label.length + 1);
  return Object.hasOwn(profiles, baseline) ? baseline : null;
}

// Capacity is campaign-scoped so ordinary jobs cannot claim these one-job runners.
export function planRunnerAdmissions(jobs, label, leases, maximum) {
  const demand = new Map();
  for (const job of jobs) {
    if (
      job.status !== "queued" ||
      !job.labels.some((entry) => entry === label || entry.startsWith(`${label}-`))
    ) {
      continue;
    }
    const baseline = job.labels.filter(
      (entry) => entry !== label && entry !== "self-hosted" && entry !== "crabbox",
    );
    const capacity = baseline.length === 1 ? capacityBaseline(baseline[0], label) : null;
    if (!capacity) {
      throw new Error(
        `Unsupported Crabbox runner labels for job ${job.id}: ${baseline.join(", ")}`,
      );
    }
    demand.set(capacity, (demand.get(capacity) || 0) + 1);
  }
  for (const lease of leases) {
    if (!jobs.some((job) => job.runner_name === lease.name && job.status === "in_progress")) {
      demand.set(lease.baseline, Math.max(0, (demand.get(lease.baseline) || 0) - 1));
    }
  }
  const admissions = [];
  let available = maximum - leases.length;
  // Round-robin admission prevents a broad test matrix from starving another resource class.
  while (available > 0) {
    let admitted = false;
    for (const [baseline, count] of demand) {
      if (count < 1 || available < 1) {
        continue;
      }
      admissions.push({ baseline, ...profiles[baseline] });
      demand.set(baseline, count - 1);
      available -= 1;
      admitted = true;
    }
    if (!admitted) {
      break;
    }
  }
  return admissions;
}

function parseArgs(argv) {
  const options = { maximum: 10, attach: "", dispatcherArgs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.dispatcherArgs = argv.slice(index + 1);
      break;
    }
    if (arg === "--max-runners") {
      options.maximum = Number(argv[++index]);
    } else if (arg === "--attach") {
      options.attach = argv[++index];
    } else if (arg === "--help") {
      console.log(
        "Usage: node scripts/full-release-crabbox.mjs [--max-runners 10] -- <full-release-validation-at-sha arguments>\n       node scripts/full-release-crabbox.mjs [--max-runners 10] --attach <retained-request.json>\n\nUses existing Crabbox broker and gh authentication. Provisions one-job AWS runners only for this release's Linux labels; native Windows/macOS retain their routes. Keep this command running through validation; it stops its VMs on completion. --attach resumes provisioning for a retained request, without redispatching it.",
      );
      return null;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isSafeInteger(options.maximum) || options.maximum < 1 || options.maximum > 50) {
    throw new Error("--max-runners must be between 1 and 50; broker admission limits still apply");
  }
  if (!options.attach && options.dispatcherArgs.length === 0) {
    throw new Error("Pass release arguments after --, or --attach a retained request");
  }
  if (options.attach && options.dispatcherArgs.length) {
    throw new Error("--attach cannot be combined with dispatch arguments");
  }
  return options;
}

async function readRequest(path) {
  let record;
  try {
    record = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const { request } = record;
  const envelope = JSON.parse(request.wireInputs.trusted_workflow_json);
  const label = envelope.crabboxRunnerLabel;
  if (
    request.repository !== repository ||
    !labelPattern.test(label) ||
    !request.workflowRef.startsWith("release-ci/")
  ) {
    throw new Error("Retained request is not an OpenClaw Crabbox release dispatch");
  }
  return { record, request, label };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }
  await command(crabbox, ["--version"]);
  const listHelp = await command(crabbox, ["list", "--help"], { includeStderr: true });
  // Newer Crabbox hides kept terminal history unless explicitly requested.
  const retainedInventory = /^\s+--?retained(?:\s|$)/mu.test(listHelp) ? ["--retained"] : [];
  await command("gh", ["auth", "status"]);
  // Check both read and registration authority before dispatch can queue self-hosted work.
  await github(`repos/${repository}/actions/runners?per_page=1`);
  await github(`repos/${repository}/actions/runners/registration-token`, "POST");
  const label = `crabbox-frv-${randomBytes(6).toString("hex")}`;
  const requestPath = resolve(options.attach || `.artifacts/full-release-validation/${label}.json`);
  let dispatcher;
  let dispatcherResult;
  let interrupted = false;
  const leases = new Map();
  let sequence = 0;
  const controllerId = randomBytes(6).toString("hex");
  let context;
  let failures = 0;
  let completed = false;
  let adopted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  async function stop(lease) {
    // Remove an idle registration too; deleting a VM alone leaves stale runner records.
    try {
      const runners = await pages(`repos/${repository}/actions/runners`, "runners");
      const runner = runners.find((entry) => entry.name === lease.name);
      if (runner) {
        await command("gh", [
          "api",
          `repos/${repository}/actions/runners/${runner.id}`,
          "--method",
          "DELETE",
        ]);
      }
    } finally {
      await command(crabbox, ["stop", "--provider", "aws", lease.id], {
        inherit: true,
        timeout: 300_000,
      });
      leases.delete(lease.id);
    }
  }

  async function cancelRemainingRuns() {
    if (context?.rootRunId) {
      const path = `repos/${repository}/actions/runs?branch=${encodeURIComponent(context.request.workflowRef)}`;
      const active = (runs) =>
        runs.filter(
          (run) => run.head_sha === context.request.workflowSha && run.status !== "completed",
        );
      const cancelled = new Set();
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        const runs = active(await pages(path, "workflow_runs"));
        if (!runs.length) {
          return;
        }
        // Dispatch can settle after the first inventory; cancel each newly visible child.
        for (const run of runs) {
          if (cancelled.has(run.id)) {
            continue;
          }
          try {
            await command("gh", [
              "api",
              `repos/${repository}/actions/runs/${run.id}/cancel`,
              "--method",
              "POST",
            ]);
          } catch (error) {
            if (
              (await github(`repos/${repository}/actions/runs/${run.id}`)).status !== "completed"
            ) {
              throw error;
            }
          }
          cancelled.add(run.id);
        }
        if (Date.now() >= deadline) {
          throw new Error("Release cancellation has not settled after five minutes");
        }
        await delay(5_000);
      }
    }
  }

  try {
    if (!options.attach) {
      if (
        options.dispatcherArgs.some(
          (arg) => arg === "--request-file" || arg.includes("crabbox_runner_label="),
        )
      ) {
        throw new Error(
          "This command owns the request file and Crabbox label; use --attach for recovery",
        );
      }
      await mkdir(dirname(requestPath), { recursive: true });
      console.log(`Crabbox release request: ${requestPath}; max runners: ${options.maximum}`);
      dispatcher = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./full-release-validation-at-sha.mjs", import.meta.url)),
          "--request-file",
          requestPath,
          "-f",
          `crabbox_runner_label=${label}`,
          ...options.dispatcherArgs,
        ],
        { stdio: "inherit" },
      );
      dispatcherResult = new Promise((accept) => {
        dispatcher.on("error", (error) => accept({ code: 1, error }));
        dispatcher.on("close", (code, signal) => accept({ code, signal }));
      });
    }

    for (;;) {
      if (interrupted) {
        break;
      }
      context = await readRequest(requestPath);
      if (context && !context.record.run) {
        // The dispatch owner records run authority only after its first-job witness.
        // Discover this unique transport's run to bootstrap that job, without writing
        // the request or substituting our queue observation for its witness proof.
        const candidates = await pages(
          `repos/${repository}/actions/workflows/${context.request.workflowId}/runs?branch=${encodeURIComponent(context.request.workflowRef)}&event=workflow_dispatch`,
          "workflow_runs",
        );
        const matching = candidates.filter((run) => run.head_sha === context.request.workflowSha);
        if (matching.length > 1) {
          throw new Error(
            "Multiple release runs match the retained transport; reconcile before provisioning",
          );
        }
        context.rootRunId = matching[0]?.id;
      } else if (context) {
        context.rootRunId = context.record.run.id;
      }
      if (!context?.rootRunId) {
        if (dispatcher && dispatcher.exitCode !== null) {
          break;
        }
        if (options.attach) {
          throw new Error(
            "Request has no observed run; reconcile it with full-release-validation-at-sha before attaching",
          );
        }
        await Promise.race([delay(5_000), dispatcherResult || new Promise(() => {})]);
        continue;
      }
      const { rootRunId, request, label: runLabel } = context;
      let root;
      let jobs;
      try {
        root = await github(`repos/${repository}/actions/runs/${rootRunId}`);
        if (root.head_sha !== request.workflowSha || root.head_branch !== request.workflowRef) {
          throw new Error("Release run no longer matches its retained dispatch identity");
        }
        if (!adopted) {
          const runners = await pages(`repos/${repository}/actions/runners`, "runners");
          for (const runner of runners) {
            if (!runner.labels.some((entry) => entry.name === runLabel)) {
              continue;
            }
            const id = runner.name.slice(runLabel.length + 1);
            const capacities = runner.labels
              .map((entry) => capacityBaseline(entry.name, runLabel))
              .filter(Boolean);
            const baseline = capacities.length === 1 ? capacities[0] : null;
            if (
              !runner.name.startsWith(`${runLabel}-`) ||
              !/^cbx_[a-f0-9]{12}$/u.test(id) ||
              !baseline
            ) {
              throw new Error("Cannot recover a runner with an unexpected release identity");
            }
            leases.set(id, { id, name: runner.name, baseline, created: Date.now() });
          }
          // Broker slugs recover allocations that crashed before GitHub registration.
          const inventory = JSON.parse(
            await command(crabbox, ["list", "--provider", "aws", "--json", ...retainedInventory]),
          );
          for (const machine of inventory) {
            const prefix = `${runLabel}-`;
            if (!machine.slug?.startsWith(prefix) || leases.has(machine.id)) {
              continue;
            }
            // Crabbox's stop owner decides whether provider deletion is confirmed;
            // a released broker record can still carry cleanup debt.
            const baseline =
              Object.keys(profiles)[Number(machine.slug.slice(prefix.length).split("-")[0])];
            if (!baseline || !/^cbx_[a-f0-9]{12}$/u.test(machine.id)) {
              throw new Error("Cannot recover a Crabbox lease with an unexpected release identity");
            }
            leases.set(machine.id, {
              id: machine.id,
              name: `${runLabel}-${machine.id}`,
              baseline,
              created: 0,
            });
          }
          adopted = true;
        }
        if (root.status === "completed") {
          completed = true;
          if (options.attach) {
            process.exitCode = root.conclusion === "success" ? 0 : 1;
          }
          break;
        }
        const runs = await pages(
          `repos/${repository}/actions/runs?branch=${encodeURIComponent(request.workflowRef)}`,
          "workflow_runs",
        );
        jobs = [];
        for (const run of runs) {
          if (run.head_sha !== request.workflowSha) {
            continue;
          }
          jobs.push(
            ...(await pages(`repos/${repository}/actions/runs/${run.id}/jobs?filter=all`, "jobs")),
          );
        }
        failures = 0;
      } catch (error) {
        failures += 1;
        console.error(`Queue observation failed (${failures}/3): ${error.message}`);
        if (failures >= 3) {
          throw error;
        }
        await delay(15_000);
        continue;
      }
      for (const lease of leases.values()) {
        const assigned = jobs.filter((job) => job.runner_name === lease.name);
        if (
          (assigned.length && assigned.every((job) => job.status === "completed")) ||
          (!assigned.length && Date.now() - lease.created > 15 * 60_000)
        ) {
          await stop(lease);
        }
      }
      const admissions = planRunnerAdmissions(
        jobs,
        runLabel,
        [...leases.values()],
        options.maximum,
      );
      const provisioning = await Promise.allSettled(
        admissions.map(async (admission) => {
          if (interrupted) {
            return;
          }
          const id = `cbx_${createHash("sha256").update(`${runLabel}:${controllerId}:${sequence++}`).digest("hex").slice(0, 12)}`;
          const lease = {
            id,
            name: `${runLabel}-${id}`,
            baseline: admission.baseline,
            created: Date.now(),
          };
          // Record ownership before warmup: a failed response can still have allocated the known ID.
          leases.set(id, lease);
          console.log(`Provisioning ${id}: ${admission.baseline} -> ${admission.type}`);
          await command(
            crabbox,
            [
              "warmup",
              "--provider",
              "aws",
              "--type",
              admission.type,
              "--arch",
              admission.arch,
              "--os",
              "ubuntu:24.04",
              "--lease-id",
              id,
              "--slug",
              `${runLabel}-${Object.keys(profiles).indexOf(admission.baseline)}-${id.slice(4)}`,
              "--keep",
              "--ttl",
              "13h",
              "--idle-timeout",
              "13h",
              "--timing-json",
            ],
            { inherit: true, timeout: 30 * 60_000 },
          );
          // Container jobs initialize before workflow steps can prepare their host.
          await command(
            crabbox,
            [
              "run",
              "--no-sync",
              "--no-hydrate",
              "--shell",
              "--provider",
              "aws",
              "--id",
              id,
              "--",
              "set -e; if ! command -v docker >/dev/null; then sudo apt-get update; sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io; fi; if ! docker compose version >/dev/null 2>&1; then sudo apt-get update; sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2; fi; sudo systemctl enable --now docker; sudo usermod -aG docker $(id -un)",
            ],
            { inherit: true, timeout: 10 * 60_000 },
          );
          // A new SSH session admits the updated supplementary Docker group.
          await command(
            crabbox,
            [
              "run",
              "--no-sync",
              "--no-hydrate",
              "--shell",
              "--provider",
              "aws",
              "--id",
              id,
              "--",
              "docker info >/dev/null && docker compose version",
            ],
            { inherit: true, timeout: 60_000 },
          );
          const current = await github(`repos/${repository}/actions/runs/${rootRunId}`);
          if (
            current.head_sha !== request.workflowSha ||
            current.head_branch !== request.workflowRef
          ) {
            throw new Error("Release authority changed while provisioning a runner");
          }
          if (interrupted || current.status === "completed") {
            await stop(lease);
            return;
          }
          await command(
            crabbox,
            [
              "actions",
              "register",
              "--provider",
              "aws",
              "--id",
              id,
              "--repo",
              repository,
              "--name",
              lease.name,
              "--labels",
              `${runLabel},${runLabel}-${admission.baseline}`,
              "--ephemeral=true",
            ],
            { inherit: true, timeout: 10 * 60_000 },
          );
        }),
      );
      const failed = provisioning.find((result) => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
      console.log(
        `Crabbox release ${root.id}: ${jobs.filter((job) => job.status === "queued" && job.labels.some((entry) => entry === runLabel || entry.startsWith(`${runLabel}-`))).length} queued Linux jobs; ${leases.size}/${options.maximum} owned runners`,
      );
      if (dispatcher && dispatcher.exitCode !== null) {
        break;
      }
      await delay(15_000);
    }
  } finally {
    try {
      await cancelRemainingRuns();
    } catch (error) {
      console.error(
        `Release cancellation could not be verified: ${error.message}. Inspect ${requestPath} before recovering.`,
      );
      process.exitCode = 1;
    } finally {
      if (!completed && dispatcher?.exitCode === null) {
        dispatcher.kill("SIGTERM");
      }
      if (dispatcherResult) {
        const result = await dispatcherResult;
        if (result.error) {
          console.error(result.error.message);
        }
        process.exitCode ||= interrupted ? 130 : result.code || (result.signal ? 1 : 0);
      }
      const cleanup = await Promise.allSettled([...leases.values()].map(stop));
      for (const result of cleanup) {
        if (result.status === "rejected") {
          console.error(
            `Crabbox cleanup failed: ${result.reason.message}. Retain ${requestPath} and inspect owned lease IDs above; TTL is the fallback.`,
          );
          process.exitCode = 1;
        }
      }
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
