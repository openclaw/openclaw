// Opt-in evidence for the existing compiler process, never another compiler pass.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { readFlagValue } from "./arg-utils.mts";
import { runManagedCommand } from "./managed-child-process.mts";
import { findRepoRoot } from "./repo-root.mjs";

type Command = Parameters<typeof runManagedCommand>[0];
const SAMPLE_INTERVAL_MS = 100;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

function readFile(file: string | undefined): Buffer | null {
  if (!file) {
    return null;
  }
  try {
    if (fs.statSync(file).size > MAX_METADATA_BYTES) {
      return null;
    }
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function digest(bytes: Buffer | null) {
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

/** Linux stat accounts for all threads; status VmHWM is the process RSS high-water mark. */
export function parseTsgoProcessSample(stat: string, status: string, ticksPerSecond: number) {
  // comm can contain spaces and parentheses. Fields after its final ')' start at field 3.
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const startTicks = fields[19];
  const rssKiB = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(status)?.[1];
  if (
    !/^\d+$/u.test(startTicks ?? "") ||
    !Number.isFinite(userTicks) ||
    userTicks < 0 ||
    !Number.isFinite(systemTicks) ||
    systemTicks < 0 ||
    !Number.isFinite(ticksPerSecond) ||
    ticksPerSecond <= 0
  ) {
    return null;
  }
  return {
    startTicks,
    cpuMs: ((userTicks + systemTicks) / ticksPerSecond) * 1000,
    peakRssBytes: rssKiB === undefined ? null : Number(rssKiB) * 1024,
  };
}

export function createTsgoResourceSampler({
  platform = process.platform,
  ticksPerSecond,
  read = (file: string) => fs.readFileSync(file, "utf8"),
}: {
  platform?: NodeJS.Platform;
  ticksPerSecond: number | null;
  read?: (file: string) => string;
}) {
  let startTicks: string | undefined;
  let samples = 0;
  let cpuMs: number | null = null;
  let peakRssBytes: number | null = null;
  const unavailableReason =
    platform !== "linux"
      ? "unsupported-platform"
      : ticksPerSecond === null
        ? "clock-tick-frequency-unavailable"
        : null;
  return {
    sample(pid: number) {
      if (unavailableReason || ticksPerSecond === null) {
        return;
      }
      try {
        const sample = parseTsgoProcessSample(
          read(`/proc/${pid}/stat`),
          read(`/proc/${pid}/status`),
          ticksPerSecond,
        );
        if (!sample || (startTicks !== undefined && startTicks !== sample.startTicks)) {
          return;
        }
        startTicks ??= sample.startTicks;
        samples += 1;
        cpuMs = Math.max(cpuMs ?? 0, sample.cpuMs);
        if (sample.peakRssBytes !== null) {
          peakRssBytes = Math.max(peakRssBytes ?? 0, sample.peakRssBytes);
        }
      } catch {
        // Short-lived children, restricted procfs, and exit races leave missing samples.
      }
    },
    result() {
      return {
        source: "linux-procfs",
        scope: "compiler-process-all-threads-not-descendants",
        accuracy: "sampled-lower-bound",
        intervalMs: SAMPLE_INTERVAL_MS,
        samples,
        cpuMs,
        peakRssBytes,
        unavailableReason:
          unavailableReason ?? (samples === 0 ? "process-samples-unavailable" : null),
        peakRssUnavailableReason:
          peakRssBytes === null
            ? (unavailableReason ??
              (samples === 0 ? "process-samples-unavailable" : "rss-high-water-unavailable"))
            : null,
      };
    },
  };
}

/** Counts only metadata written by this invocation; unchanged input is not fresh graph evidence. */
export function summarizeTsgoBuildInfo(before: Buffer | null, after: Buffer | null) {
  const missing = (reason: string) => ({
    totalFiles: null,
    rootFiles: null,
    transitiveFiles: null,
    unavailableReason: reason,
  });
  if (!after) {
    return missing("build-info-unavailable");
  }
  if (before?.equals(after)) {
    return missing("build-info-unchanged");
  }
  try {
    const info = JSON.parse(after.toString("utf8"));
    if (
      !Array.isArray(info.fileNames) ||
      !info.fileNames.every((name: unknown) => typeof name === "string") ||
      !Array.isArray(info.root)
    ) {
      return missing("unsupported-build-info");
    }
    const ranges: Array<[number, number]> = [];
    for (const entry of info.root) {
      const [start, end] = Array.isArray(entry) && entry.length === 2 ? entry : [entry, entry];
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start ||
        end > info.fileNames.length
      ) {
        return missing("unsupported-build-info");
      }
      ranges.push([start, end]);
    }
    ranges.sort(([left], [right]) => left - right);
    let rootFiles = 0;
    let previousEnd = 0;
    for (const [start, end] of ranges) {
      rootFiles += Math.max(0, end - Math.max(start - 1, previousEnd));
      previousEnd = Math.max(previousEnd, end);
    }
    return {
      totalFiles: info.fileNames.length,
      rootFiles,
      transitiveFiles: info.fileNames.length - rootFiles,
      unavailableReason: null,
    };
  } catch {
    return missing("unsupported-build-info");
  }
}

function provenance(cwd: string, env: NodeJS.ProcessEnv) {
  const root = findRepoRoot(cwd) ?? cwd;
  const git = (args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
  const revision = git(["rev-parse", "HEAD"]);
  const dirty = git(["diff", "--quiet", "HEAD", "--"]);
  let compilerVersion: string | null = null;
  try {
    const require = createRequire(path.join(root, "package.json"));
    compilerVersion =
      JSON.parse(fs.readFileSync(require.resolve("typescript-native/package.json"), "utf8"))
        .version ?? null;
  } catch {
    /* A missing package manifest is not a compiler failure. */
  }
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    trackedDirty: dirty.status === 0 ? false : dirty.status === 1 ? true : null,
    lockfileSha256: digest(readFile(path.join(root, "pnpm-lock.yaml"))),
    compilerVersion,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    resources: Object.fromEntries(
      ["OPENCLAW_LOCAL_CHECK_MODE", "GOMAXPROCS", "GOGC", "GOMEMLIMIT"].map((key) => [
        key,
        env[key] ?? null,
      ]),
    ),
  };
}

/** Keep the managed child as the sole signal/deadline/cleanup owner. Metrics never replace its result. */
export async function runMeasuredTsgoCommand(command: Command, directory: string) {
  const cwd = command.cwd ?? process.cwd();
  let artifact: string;
  let inputs: ReturnType<typeof provenance>;
  try {
    const destination = path.resolve(cwd, directory);
    fs.mkdirSync(destination, { recursive: true });
    artifact = path.join(destination, `tsgo-${randomUUID()}.json`);
    inputs = provenance(cwd, command.env ?? process.env);
  } catch {
    console.error("[tsgo-metrics] evidence setup unavailable; running compiler without metrics");
    return runManagedCommand(command);
  }
  const args = command.args ?? [];
  const buildInfoArg = readFlagValue(args, "--tsBuildInfoFile");
  const buildInfo = buildInfoArg ? path.resolve(cwd, buildInfoArg) : undefined;
  const before = readFile(buildInfo);
  const ticks =
    process.platform === "linux"
      ? spawnSync("getconf", ["CLK_TCK"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2_000,
        })
      : null;
  const ticksPerSecond =
    ticks?.status === 0 && Number(ticks.stdout) > 0 ? Number(ticks.stdout) : null;
  const sampler = createTsgoResourceSampler({ ticksPerSecond });
  let timer: ReturnType<typeof setInterval> | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let forwardedSignal: NodeJS.Signals | null = null;
  let errorCode: string | null = null;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    exitCode = await runManagedCommand({
      ...command,
      onReady(child) {
        const sample = () => {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            sampler.sample(child.pid);
          }
        };
        sample();
        if (process.platform === "linux" && ticksPerSecond !== null) {
          timer = setInterval(sample, SAMPLE_INTERVAL_MS);
          timer.unref();
        }
        child.once("exit", (_code, signal) => {
          exitSignal = signal;
          clearInterval(timer);
        });
        command.onReady?.(child);
      },
      onSignal(signal) {
        forwardedSignal = signal;
        command.onSignal?.(signal);
      },
    });
    return exitCode;
  } catch (error) {
    errorCode =
      error && typeof error === "object" && "code" in error ? String(error.code) : "command-failed";
    throw error;
  } finally {
    const wallMs = performance.now() - started;
    clearInterval(timer);
    try {
      const after = readFile(buildInfo);
      const evidence = {
        schemaVersion: 1,
        startedAt,
        ...inputs,
        command: { bin: command.bin, args, cwd, timeoutMs: command.timeoutMs ?? null },
        outcome: { exitCode, exitSignal, forwardedSignal, errorCode },
        wallMs,
        wallScope: "managed-invocation-including-cleanup-excluding-evidence-io",
        resources: { policy: inputs.resources, ...sampler.result() },
        cache: {
          buildInfoFile: buildInfoArg ?? null,
          beforeSha256: digest(before),
          afterSha256: digest(after),
          hit: "unknown",
          osPageCache: "uncontrolled",
        },
        graph: { source: "changed-tsbuildinfo", ...summarizeTsgoBuildInfo(before, after) },
        pprofDir: readFlagValue(args, "--pprofDir") ?? null,
      };
      fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    } catch {
      console.error("[tsgo-metrics] could not write evidence; compiler outcome preserved");
    }
  }
}
