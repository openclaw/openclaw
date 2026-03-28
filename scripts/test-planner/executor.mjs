import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getProcessTreeRecords,
  parseCompletedTestFileLines,
  sampleProcessTreeRssKb,
} from "../test-parallel-memory.mjs";
import {
  appendCapturedOutput,
  formatCapturedOutputTail,
  hasFatalTestRunOutput,
  resolveTestRunExitCode,
} from "../test-parallel-utils.mjs";
import { countExplicitEntryFilters, getExplicitEntryFilters } from "./vitest-args.mjs";

export function resolvePnpmCommandInvocation(options = {}) {
  const npmExecPath = typeof options.npmExecPath === "string" ? options.npmExecPath.trim() : "";
  if (npmExecPath && path.isAbsolute(npmExecPath)) {
    const npmExecBase = path.basename(npmExecPath).toLowerCase();
    if (npmExecBase.startsWith("pnpm")) {
      return {
        command: options.nodeExecPath || process.execPath,
        args: [npmExecPath],
      };
    }
  }

  if (options.platform === "win32") {
    return {
      command: options.comSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd"],
    };
  }

  return {
    command: "pnpm",
    args: [],
  };
}

const sanitizeArtifactName = (value) => {
  const normalized = value
    .trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "artifact";
};

const DEFAULT_CI_MAX_OLD_SPACE_SIZE_MB = 4096;
const WARNING_SUPPRESSION_FLAGS = [
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=DEP0040",
  "--disable-warning=DEP0060",
  "--disable-warning=MaxListenersExceededWarning",
];

const formatElapsedMs = (elapsedMs) =>
  elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${Math.round(elapsedMs)}ms`;
const formatMemoryKb = (rssKb) =>
  rssKb >= 1024 ** 2
    ? `${(rssKb / 1024 ** 2).toFixed(2)}GiB`
    : rssKb >= 1024
      ? `${(rssKb / 1024).toFixed(1)}MiB`
      : `${rssKb}KiB`;
const formatMemoryDeltaKb = (rssKb) =>
  `${rssKb >= 0 ? "+" : "-"}${formatMemoryKb(Math.abs(rssKb))}`;

const extractFailedTestFiles = (output) => {
  const failureFiles = new Set();
  const pattern = /^\s*❯\s+([^\s(][^(]*?\.(?:test|spec)\.[cm]?[jt]sx?)/gmu;
  for (const match of output.matchAll(pattern)) {
    const file = match[1]?.trim();
    if (file) {
      failureFiles.add(file);
    }
  }
  return [...failureFiles];
};

const classifyRunResult = ({ resolvedCode, signal, fatalSeen, childError, failedTestFiles }) => {
  if (resolvedCode === 0) {
    return "pass";
  }
  if (childError || signal || fatalSeen || failedTestFiles.length === 0) {
    return "infra-failure";
  }
  return "test-failure";
};

const formatRunLabel = (result) =>
  `unit=${result.unitId}${result.shardLabel ? ` shard=${result.shardLabel}` : ""}`;

const buildFinalRunReport = (results) => {
  const failedResults = results.filter((result) => result.exitCode !== 0);
  const failedUnits = new Set(failedResults.map((result) => result.unitId));
  const failedTestFiles = new Set(failedResults.flatMap((result) => result.failedTestFiles ?? []));
  const infraFailures = failedResults.filter((result) => result.classification === "infra-failure");
  return {
    exitCode: failedResults.length > 0 ? 1 : 0,
    results,
    summary: {
      failedRunCount: failedResults.length,
      failedUnitCount: failedUnits.size,
      failedTestFileCount: failedTestFiles.size,
      infraFailureCount: infraFailures.length,
    },
  };
};

const printFinalRunSummary = (plan, report, reportArtifactPath) => {
  console.log(
    `[test-parallel] summary failurePolicy=${plan.failurePolicy} failedUnits=${String(
      report.summary.failedUnitCount,
    )} failedTestFiles=${String(report.summary.failedTestFileCount)} infraFailures=${String(
      report.summary.infraFailureCount,
    )}`,
  );
  if (report.summary.failedTestFileCount > 0) {
    console.error("[test-parallel] failing tests");
    const failedTestFiles = report.results
      .flatMap((result) => (result.classification === "test-failure" ? result.failedTestFiles : []))
      .filter((file) => typeof file === "string");
    for (const file of new Set(failedTestFiles)) {
      console.error(`- ${String(file)}`);
    }
  }
  if (report.summary.infraFailureCount > 0) {
    console.error("[test-parallel] infrastructure failures");
    for (const result of report.results.filter(
      (entry) => entry.classification === "infra-failure",
    )) {
      console.error(
        `- ${formatRunLabel(result)} code=${String(result.exitCode)} signal=${result.signal ?? "none"} log=${result.logPath}${result.failureArtifactPath ? ` meta=${result.failureArtifactPath}` : ""}`,
      );
    }
  }
  console.error(`[test-parallel] summary artifact ${reportArtifactPath}`);
};

export function createExecutionArtifacts(env = process.env) {
  let tempArtifactDir = null;
  const ensureTempArtifactDir = () => {
    if (tempArtifactDir === null) {
      tempArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-parallel-"));
    }
    return tempArtifactDir;
  };
  const writeTempJsonArtifact = (name, value) => {
    const filePath = path.join(ensureTempArtifactDir(), `${sanitizeArtifactName(name)}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
    return filePath;
  };
  const cleanupTempArtifacts = () => {
    if (tempArtifactDir === null) {
      return;
    }
    if (env.OPENCLAW_TEST_KEEP_TEMP_ARTIFACTS === "1") {
      console.error(`[test-parallel] keeping temp artifacts at ${tempArtifactDir}`);
      return;
    }
    fs.rmSync(tempArtifactDir, { recursive: true, force: true });
    tempArtifactDir = null;
  };
  return { ensureTempArtifactDir, writeTempJsonArtifact, cleanupTempArtifacts };
}

const ensureNodeOptionFlag = (nodeOptions, flagPrefix, nextValue) =>
  nodeOptions.includes(flagPrefix) ? nodeOptions : `${nodeOptions} ${nextValue}`.trim();

const isNodeLikeProcess = (command) => /(?:^|\/)node(?:$|\.exe$)/iu.test(command);

const getShardLabel = (args) => {
  const shardIndex = args.findIndex((arg) => arg === "--shard");
  if (shardIndex < 0) {
    return "";
  }
  return typeof args[shardIndex + 1] === "string" ? args[shardIndex + 1] : "";
};

const normalizeEnvFlag = (value) => value?.trim().toLowerCase();

const isEnvFlagEnabled = (value) => {
  const normalized = normalizeEnvFlag(value);
  return normalized === "1" || normalized === "true";
};

const isEnvFlagDisabled = (value) => {
  const normalized = normalizeEnvFlag(value);
  return normalized === "0" || normalized === "false";
};

const isWindowsEnv = (env, platform = process.platform) => {
  if (platform === "win32") {
    return true;
  }
  return normalizeEnvFlag(env.RUNNER_OS) === "windows";
};

const isFsModuleCacheEnabled = (env, platform = process.platform) => {
  if (isWindowsEnv(env, platform)) {
    return isEnvFlagEnabled(env.OPENCLAW_VITEST_FS_MODULE_CACHE);
  }
  return !isEnvFlagDisabled(env.OPENCLAW_VITEST_FS_MODULE_CACHE);
};

export const resolveVitestFsModuleCachePath = ({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  unitId = "",
} = {}) => {
  const explicitPath = env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH?.trim();
  if (!isFsModuleCacheEnabled(env, platform)) {
    return undefined;
  }
  if (explicitPath) {
    return explicitPath;
  }
  const pathImpl = isWindowsEnv(env, platform) ? path.win32 : path.posix;
  return pathImpl.join(
    cwd,
    "node_modules",
    ".experimental-vitest-cache",
    sanitizeArtifactName(unitId || "default"),
  );
};

export function formatPlanOutput(plan) {
  return [
    `runtime=${plan.runtimeCapabilities.runtimeProfileName} mode=${plan.runtimeCapabilities.mode} intent=${plan.runtimeCapabilities.intentProfile} memoryBand=${plan.runtimeCapabilities.memoryBand} loadBand=${plan.runtimeCapabilities.loadBand} failurePolicy=${plan.failurePolicy} vitestMaxWorkers=${String(plan.executionBudget.vitestMaxWorkers ?? "default")} topLevelParallel=${plan.topLevelParallelEnabled ? String(plan.topLevelParallelLimit) : "off"}`,
    ...plan.selectedUnits.map(
      (unit) =>
        `${unit.id} filters=${String(countExplicitEntryFilters(unit.args) ?? "all")} maxWorkers=${String(
          unit.maxWorkers ?? "default",
        )} surface=${unit.surface} isolate=${unit.isolate ? "yes" : "no"} pool=${unit.pool}`,
    ),
  ].join("\n");
}

export function formatExplanation(explanation) {
  return [
    `file=${explanation.file}`,
    `runtime=${explanation.runtimeProfile} intent=${explanation.intentProfile} memoryBand=${explanation.memoryBand} loadBand=${explanation.loadBand}`,
    `surface=${explanation.surface}`,
    `isolate=${explanation.isolate ? "yes" : "no"}`,
    `pool=${explanation.pool}`,
    `maxWorkers=${String(explanation.maxWorkers ?? "default")}`,
    `reasons=${explanation.reasons.join(",")}`,
    `command=${explanation.args.join(" ")}`,
  ].join("\n");
}

const buildOrderedParallelSegments = (units) => {
  const segments = [];
  let deferredUnits = [];
  for (const unit of units) {
    if (unit.serialPhase) {
      if (deferredUnits.length > 0) {
        segments.push({ type: "deferred", units: deferredUnits });
        deferredUnits = [];
      }
      const lastSegment = segments.at(-1);
      if (lastSegment?.type === "serialPhase" && lastSegment.phase === unit.serialPhase) {
        lastSegment.units.push(unit);
      } else {
        segments.push({ type: "serialPhase", phase: unit.serialPhase, units: [unit] });
      }
      continue;
    }
    deferredUnits.push(unit);
  }
  if (deferredUnits.length > 0) {
    segments.push({ type: "deferred", units: deferredUnits });
  }
  return segments;
};

const prioritizeDeferredUnitsForPhase = (units, phase) => {
  const preferredSurface =
    phase === "extensions" || phase === "channels" ? phase : phase === "unit-fast" ? "unit" : null;
  if (preferredSurface === null) {
    return units;
  }
  const preferred = [];
  const remaining = [];
  for (const unit of units) {
    if (unit.surface === preferredSurface) {
      preferred.push(unit);
    } else {
      remaining.push(unit);
    }
  }
  return preferred.length > 0 ? [...preferred, ...remaining] : units;
};

const partitionUnitsBySurface = (units, surface) => {
  const matching = [];
  const remaining = [];
  for (const unit of units) {
    if (unit.surface === surface) {
      matching.push(unit);
    } else {
      remaining.push(unit);
    }
  }
  return { matching, remaining };
};

export async function executePlan(plan, options = {}) {
  const env = options.env ?? process.env;
  const artifacts = options.artifacts ?? createExecutionArtifacts(env);
  const pnpmInvocation = resolvePnpmCommandInvocation({
    npmExecPath: env.npm_execpath,
    nodeExecPath: process.execPath,
    platform: process.platform,
    comSpec: env.ComSpec,
  });
  const children = new Set();
  const windowsCiArgs = plan.runtimeCapabilities.isWindowsCi
    ? ["--dangerouslyIgnoreUnhandledErrors"]
    : [];
  const silentArgs = env.OPENCLAW_TEST_SHOW_PASSED_LOGS === "1" ? [] : ["--silent=passed-only"];
  const rawMemoryTrace = env.OPENCLAW_TEST_MEMORY_TRACE?.trim().toLowerCase();
  const memoryTraceEnabled =
    process.platform !== "win32" &&
    (rawMemoryTrace === "1" ||
      rawMemoryTrace === "true" ||
      (rawMemoryTrace !== "0" && rawMemoryTrace !== "false" && plan.runtimeCapabilities.isCI));
  const parseEnvNumber = (name, fallback) => {
    const parsed = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const memoryTracePollMs = Math.max(
    250,
    parseEnvNumber("OPENCLAW_TEST_MEMORY_TRACE_POLL_MS", 1000),
  );
  const memoryTraceTopCount = Math.max(
    1,
    parseEnvNumber("OPENCLAW_TEST_MEMORY_TRACE_TOP_COUNT", 6),
  );
  const requestedHeapSnapshotIntervalMs = Math.max(
    0,
    parseEnvNumber("OPENCLAW_TEST_HEAPSNAPSHOT_INTERVAL_MS", 0),
  );
  const heapSnapshotMinIntervalMs = 1000;
  const heapSnapshotIntervalMs =
    requestedHeapSnapshotIntervalMs > 0
      ? Math.max(heapSnapshotMinIntervalMs, requestedHeapSnapshotIntervalMs)
      : 0;
  const heapSnapshotEnabled =
    process.platform !== "win32" && heapSnapshotIntervalMs >= heapSnapshotMinIntervalMs;
  const heapSnapshotSignal = env.OPENCLAW_TEST_HEAPSNAPSHOT_SIGNAL?.trim() || "SIGUSR2";
  const closeGraceMs = Math.max(100, parseEnvNumber("OPENCLAW_TEST_CLOSE_GRACE_MS", 2000));
  const heapSnapshotBaseDir = heapSnapshotEnabled
    ? path.resolve(
        env.OPENCLAW_TEST_HEAPSNAPSHOT_DIR?.trim() ||
          path.join(os.tmpdir(), `openclaw-heapsnapshots-${Date.now()}`),
      )
    : null;
  const maxOldSpaceSizeMb = (() => {
    const raw = env.OPENCLAW_TEST_MAX_OLD_SPACE_SIZE_MB ?? "";
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    if (plan.runtimeCapabilities.isCI && !plan.runtimeCapabilities.isWindows) {
      return DEFAULT_CI_MAX_OLD_SPACE_SIZE_MB;
    }
    return null;
  })();

  const shutdown = (signal) => {
    for (const child of children) {
      child.kill(signal);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", artifacts.cleanupTempArtifacts);

  const shouldCollectAllFailures = plan.failurePolicy === "collect-all";

  const runOnce = (unit, extraArgs = []) =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      const entryArgs = unit.args;
      const explicitEntryFilters = getExplicitEntryFilters(entryArgs);
      const args = unit.maxWorkers
        ? [
            ...entryArgs,
            "--maxWorkers",
            String(unit.maxWorkers),
            ...silentArgs,
            ...windowsCiArgs,
            ...extraArgs,
          ]
        : [...entryArgs, ...silentArgs, ...windowsCiArgs, ...extraArgs];
      const spawnArgs = [...pnpmInvocation.args, ...args];
      const shardLabel = getShardLabel(extraArgs);
      const artifactStem = [
        sanitizeArtifactName(unit.id),
        shardLabel ? `shard-${sanitizeArtifactName(shardLabel)}` : "",
        String(startedAt),
      ]
        .filter(Boolean)
        .join("-");
      const laneLogPath = path.join(artifacts.ensureTempArtifactDir(), `${artifactStem}.log`);
      const laneLogStream = fs.createWriteStream(laneLogPath, { flags: "w" });
      laneLogStream.write(`[test-parallel] entry=${unit.id}\n`);
      laneLogStream.write(`[test-parallel] cwd=${process.cwd()}\n`);
      laneLogStream.write(
        `[test-parallel] command=${[pnpmInvocation.command, ...spawnArgs].join(" ")}\n\n`,
      );
      console.log(
        `[test-parallel] start ${unit.id} workers=${unit.maxWorkers ?? "default"} filters=${String(
          countExplicitEntryFilters(entryArgs) ?? "all",
        )}`,
      );
      const nodeOptions = env.NODE_OPTIONS ?? "";
      const nextNodeOptions = WARNING_SUPPRESSION_FLAGS.reduce(
        (acc, flag) => (acc.includes(flag) ? acc : `${acc} ${flag}`.trim()),
        nodeOptions,
      );
      const heapSnapshotDir =
        heapSnapshotBaseDir === null ? null : path.join(heapSnapshotBaseDir, unit.id);
      let resolvedNodeOptions =
        maxOldSpaceSizeMb && !nextNodeOptions.includes("--max-old-space-size=")
          ? `${nextNodeOptions} --max-old-space-size=${maxOldSpaceSizeMb}`.trim()
          : nextNodeOptions;
      if (heapSnapshotEnabled && heapSnapshotDir) {
        try {
          fs.mkdirSync(heapSnapshotDir, { recursive: true });
        } catch (err) {
          console.error(
            `[test-parallel] failed to create heap snapshot dir ${heapSnapshotDir}: ${String(err)}`,
          );
          resolve({
            unitId: unit.id,
            shardLabel,
            classification: "infra-failure",
            exitCode: 1,
            signal: null,
            elapsedMs: Date.now() - startedAt,
            failedTestFiles: [...explicitEntryFilters],
            explicitEntryFilters,
            failureArtifactPath: null,
            logPath: laneLogPath,
            outputTail: "",
          });
          return;
        }
        resolvedNodeOptions = ensureNodeOptionFlag(
          resolvedNodeOptions,
          "--diagnostic-dir=",
          `--diagnostic-dir=${heapSnapshotDir}`,
        );
        resolvedNodeOptions = ensureNodeOptionFlag(
          resolvedNodeOptions,
          "--heapsnapshot-signal=",
          `--heapsnapshot-signal=${heapSnapshotSignal}`,
        );
      }
      let output = "";
      let fatalSeen = false;
      let childError = null;
      let child;
      let pendingLine = "";
      let memoryPollTimer = null;
      let heapSnapshotTimer = null;
      let closeFallbackTimer = null;
      let failureArtifactPath = null;
      let failureTail = "";
      const memoryFileRecords = [];
      let initialTreeSample = null;
      let latestTreeSample = null;
      let peakTreeSample = null;
      let heapSnapshotSequence = 0;
      let childExitState = null;
      let settled = false;
      const updatePeakTreeSample = (sample, reason) => {
        if (!sample) {
          return;
        }
        if (!peakTreeSample || sample.rssKb > peakTreeSample.rssKb) {
          peakTreeSample = { ...sample, reason };
        }
      };
      const triggerHeapSnapshot = (reason) => {
        if (!heapSnapshotEnabled || !child?.pid || !heapSnapshotDir) {
          return;
        }
        const records = getProcessTreeRecords(child.pid) ?? [];
        const targetPids = records
          .filter((record) => record.pid !== process.pid && isNodeLikeProcess(record.command))
          .map((record) => record.pid);
        if (targetPids.length === 0) {
          return;
        }
        heapSnapshotSequence += 1;
        let signaledCount = 0;
        for (const pid of targetPids) {
          try {
            process.kill(pid, heapSnapshotSignal);
            signaledCount += 1;
          } catch {}
        }
        if (signaledCount > 0) {
          console.log(
            `[test-parallel][heap] ${unit.id} seq=${String(heapSnapshotSequence)} reason=${reason} signaled=${String(
              signaledCount,
            )}/${String(targetPids.length)} dir=${heapSnapshotDir}`,
          );
        }
      };
      const captureTreeSample = (reason) => {
        if (!memoryTraceEnabled || !child?.pid) {
          return null;
        }
        const sample = sampleProcessTreeRssKb(child.pid);
        if (!sample) {
          return null;
        }
        latestTreeSample = sample;
        if (!initialTreeSample) {
          initialTreeSample = sample;
        }
        updatePeakTreeSample(sample, reason);
        return sample;
      };
      const logMemoryTraceForText = (text) => {
        if (!memoryTraceEnabled) {
          return;
        }
        const combined = `${pendingLine}${text}`;
        const lines = combined.split(/\r?\n/u);
        pendingLine = lines.pop() ?? "";
        const completedFiles = parseCompletedTestFileLines(lines.join("\n"));
        for (const completedFile of completedFiles) {
          const sample = captureTreeSample(completedFile.file);
          if (!sample) {
            continue;
          }
          const previousRssKb =
            memoryFileRecords.length > 0
              ? (memoryFileRecords.at(-1)?.rssKb ?? initialTreeSample?.rssKb ?? sample.rssKb)
              : (initialTreeSample?.rssKb ?? sample.rssKb);
          const deltaKb = sample.rssKb - previousRssKb;
          const record = {
            ...completedFile,
            rssKb: sample.rssKb,
            processCount: sample.processCount,
            deltaKb,
          };
          memoryFileRecords.push(record);
          console.log(
            `[test-parallel][mem] ${unit.id} file=${record.file} rss=${formatMemoryKb(
              record.rssKb,
            )} delta=${formatMemoryDeltaKb(record.deltaKb)} peak=${formatMemoryKb(
              peakTreeSample?.rssKb ?? record.rssKb,
            )} procs=${record.processCount}${record.durationMs ? ` duration=${formatElapsedMs(record.durationMs)}` : ""}`,
          );
        }
      };
      const logMemoryTraceSummary = () => {
        if (!memoryTraceEnabled) {
          return;
        }
        captureTreeSample("close");
        const fallbackRecord =
          memoryFileRecords.length === 0 &&
          explicitEntryFilters.length === 1 &&
          latestTreeSample &&
          initialTreeSample
            ? [
                {
                  file: explicitEntryFilters[0],
                  deltaKb: latestTreeSample.rssKb - initialTreeSample.rssKb,
                },
              ]
            : [];
        const totalDeltaKb =
          initialTreeSample && latestTreeSample
            ? latestTreeSample.rssKb - initialTreeSample.rssKb
            : 0;
        const topGrowthFiles = [...memoryFileRecords, ...fallbackRecord]
          .filter((record) => record.deltaKb > 0 && typeof record.file === "string")
          .toSorted((left, right) => right.deltaKb - left.deltaKb)
          .slice(0, memoryTraceTopCount)
          .map((record) => `${record.file}:${formatMemoryDeltaKb(record.deltaKb)}`);
        console.log(
          `[test-parallel][mem] summary ${unit.id} files=${memoryFileRecords.length} peak=${formatMemoryKb(
            peakTreeSample?.rssKb ?? 0,
          )} totalDelta=${formatMemoryDeltaKb(totalDeltaKb)} peakAt=${
            peakTreeSample?.reason ?? "n/a"
          } top=${topGrowthFiles.length > 0 ? topGrowthFiles.join(", ") : "none"}`,
        );
      };
      const clearChildTimers = () => {
        if (memoryPollTimer) {
          clearInterval(memoryPollTimer);
          memoryPollTimer = null;
        }
        if (heapSnapshotTimer) {
          clearInterval(heapSnapshotTimer);
          heapSnapshotTimer = null;
        }
        if (closeFallbackTimer) {
          clearTimeout(closeFallbackTimer);
          closeFallbackTimer = null;
        }
      };
      const finalizeRun = (code, signal, source = "close") => {
        if (settled) {
          return;
        }
        settled = true;
        clearChildTimers();
        children.delete(child);
        const resolvedCode = resolveTestRunExitCode({
          code,
          signal,
          output,
          fatalSeen,
          childError,
        });
        const elapsedMs = Date.now() - startedAt;
        logMemoryTraceSummary();
        if (resolvedCode !== 0) {
          failureTail = formatCapturedOutputTail(output);
          failureArtifactPath = artifacts.writeTempJsonArtifact(`${artifactStem}-failure`, {
            entry: unit.id,
            command: [pnpmInvocation.command, ...spawnArgs],
            elapsedMs,
            error: childError ? String(childError) : null,
            exitCode: resolvedCode,
            fatalSeen,
            logPath: laneLogPath,
            outputTail: failureTail,
            signal: signal ?? null,
          });
          if (failureTail) {
            console.error(`[test-parallel] failure tail ${unit.id}\n${failureTail}`);
          }
          console.error(
            `[test-parallel] failure artifacts ${unit.id} log=${laneLogPath} meta=${failureArtifactPath}`,
          );
        }
        if (source !== "close") {
          laneLogStream.write(
            `\n[test-parallel] finalize source=${source} after child exit without close\n`,
          );
        }
        laneLogStream.write(
          `\n[test-parallel] done ${unit.id} code=${String(resolvedCode)} signal=${
            signal ?? "none"
          } elapsed=${formatElapsedMs(elapsedMs)}\n`,
        );
        laneLogStream.end();
        console.log(
          `[test-parallel] done ${unit.id} code=${String(resolvedCode)} elapsed=${formatElapsedMs(elapsedMs)}`,
        );
        const failedTestFiles = extractFailedTestFiles(output);
        const classification = classifyRunResult({
          resolvedCode,
          signal,
          fatalSeen,
          childError,
          failedTestFiles,
        });
        resolve({
          unitId: unit.id,
          shardLabel,
          classification,
          exitCode: resolvedCode,
          signal: signal ?? null,
          elapsedMs,
          failedTestFiles,
          explicitEntryFilters,
          failureArtifactPath,
          logPath: laneLogPath,
          outputTail: failureTail,
        });
      };
      try {
        const childEnv = {
          ...env,
          ...unit.env,
          VITEST_GROUP: unit.id,
          NODE_OPTIONS: resolvedNodeOptions,
        };
        const vitestFsModuleCachePath = resolveVitestFsModuleCachePath({
          env: childEnv,
          platform: process.platform,
          unitId: unit.id,
        });
        if (vitestFsModuleCachePath) {
          childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH = vitestFsModuleCachePath;
          laneLogStream.write(`[test-parallel] fsModuleCachePath=${vitestFsModuleCachePath}\n`);
        }
        child = spawn(pnpmInvocation.command, spawnArgs, {
          stdio: ["inherit", "pipe", "pipe"],
          env: childEnv,
          shell: false,
        });
        captureTreeSample("spawn");
        if (memoryTraceEnabled) {
          memoryPollTimer = setInterval(() => {
            captureTreeSample("poll");
          }, memoryTracePollMs);
        }
        if (heapSnapshotEnabled) {
          heapSnapshotTimer = setInterval(() => {
            triggerHeapSnapshot("interval");
          }, heapSnapshotIntervalMs);
        }
      } catch (err) {
        laneLogStream.end();
        console.error(`[test-parallel] spawn failed: ${String(err)}`);
        resolve({
          unitId: unit.id,
          shardLabel: getShardLabel(extraArgs),
          classification: "infra-failure",
          exitCode: 1,
          signal: null,
          elapsedMs: Date.now() - startedAt,
          failedTestFiles: [...explicitEntryFilters],
          explicitEntryFilters,
          failureArtifactPath: null,
          logPath: laneLogPath,
          outputTail: String(err),
        });
        return;
      }
      children.add(child);
      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString();
        fatalSeen ||= hasFatalTestRunOutput(`${output}${text}`);
        output = appendCapturedOutput(output, text);
        laneLogStream.write(text);
        logMemoryTraceForText(text);
        process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        fatalSeen ||= hasFatalTestRunOutput(`${output}${text}`);
        output = appendCapturedOutput(output, text);
        laneLogStream.write(text);
        logMemoryTraceForText(text);
        process.stderr.write(chunk);
      });
      child.on("error", (err) => {
        childError = err;
        laneLogStream.write(`\n[test-parallel] child error: ${String(err)}\n`);
        console.error(`[test-parallel] child error: ${String(err)}`);
      });
      child.on("exit", (code, signal) => {
        childExitState = { code, signal };
        if (settled || closeFallbackTimer) {
          return;
        }
        closeFallbackTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finalizeRun(code, signal, "exit-timeout");
        }, closeGraceMs);
      });
      child.on("close", (code, signal) => {
        finalizeRun(childExitState?.code ?? code, childExitState?.signal ?? signal, "close");
      });
    });

  const runUnit = async (unit, extraArgs = []) => {
    const results = [];
    if (unit.fixedShardIndex !== undefined) {
      if (plan.shardIndexOverride !== null && plan.shardIndexOverride !== unit.fixedShardIndex) {
        return results;
      }
      results.push(await runOnce(unit, extraArgs));
      return results;
    }
    const explicitFilterCount = countExplicitEntryFilters(unit.args);
    const topLevelAssignedShard = plan.topLevelSingleShardAssignments.get(unit);
    if (topLevelAssignedShard !== undefined) {
      if (plan.shardIndexOverride !== null && plan.shardIndexOverride !== topLevelAssignedShard) {
        return results;
      }
      results.push(await runOnce(unit, extraArgs));
      return results;
    }
    const effectiveShardCount =
      explicitFilterCount === null
        ? plan.shardCount
        : Math.min(plan.shardCount, Math.max(1, explicitFilterCount - 1));
    if (effectiveShardCount <= 1) {
      if (plan.shardIndexOverride !== null && plan.shardIndexOverride > effectiveShardCount) {
        return results;
      }
      results.push(await runOnce(unit, extraArgs));
      return results;
    }
    if (plan.shardIndexOverride !== null) {
      if (plan.shardIndexOverride > effectiveShardCount) {
        return results;
      }
      results.push(
        await runOnce(unit, [
          "--shard",
          `${plan.shardIndexOverride}/${effectiveShardCount}`,
          ...extraArgs,
        ]),
      );
      return results;
    }
    for (let shardIndex = 1; shardIndex <= effectiveShardCount; shardIndex += 1) {
      results.push(
        // eslint-disable-next-line no-await-in-loop
        await runOnce(unit, ["--shard", `${shardIndex}/${effectiveShardCount}`, ...extraArgs]),
      );
      if (!shouldCollectAllFailures && results.at(-1)?.exitCode !== 0) {
        return results;
      }
    }
    return results;
  };

  const runUnitsWithLimit = async (units, extraArgs = [], concurrency = 1) => {
    const results = [];
    if (units.length === 0) {
      return results;
    }
    const normalizedConcurrency = Math.max(1, Math.floor(concurrency));
    if (normalizedConcurrency <= 1) {
      for (const unit of units) {
        results.push(
          // eslint-disable-next-line no-await-in-loop
          ...(await runUnit(unit, extraArgs)),
        );
        if (!shouldCollectAllFailures && results.some((result) => result.exitCode !== 0)) {
          return results;
        }
      }
      return results;
    }
    let nextIndex = 0;
    let stopScheduling = false;
    const worker = async () => {
      while (!stopScheduling) {
        const unitIndex = nextIndex;
        nextIndex += 1;
        if (unitIndex >= units.length) {
          return;
        }
        const unitResults = await runUnit(units[unitIndex], extraArgs);
        results.push(...unitResults);
        if (!shouldCollectAllFailures && unitResults.some((result) => result.exitCode !== 0)) {
          stopScheduling = true;
        }
      }
    };
    const workerCount = Math.min(normalizedConcurrency, units.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  };

  const runUnits = async (units, extraArgs = []) => {
    if (plan.topLevelParallelEnabled) {
      return runUnitsWithLimit(units, extraArgs, plan.topLevelParallelLimit);
    }
    return runUnitsWithLimit(units, extraArgs);
  };

  if (plan.passthroughMetadataOnly) {
    const report = buildFinalRunReport([
      await runOnce(
        {
          id: "vitest-meta",
          args: ["vitest", "run"],
          maxWorkers: null,
        },
        plan.passthroughOptionArgs,
      ),
    ]);
    const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
    printFinalRunSummary(plan, report, reportArtifactPath);
    return report;
  }

  if (plan.targetedUnits.length > 0) {
    if (plan.passthroughRequiresSingleRun && plan.targetedUnits.length > 1) {
      console.error(
        "[test-parallel] The provided Vitest args require a single run, but the selected test filters span multiple wrapper configs. Run one target/config at a time.",
      );
      return {
        exitCode: 2,
        results: [],
        summary: {
          failedRunCount: 0,
          failedUnitCount: 0,
          failedTestFileCount: 0,
          infraFailureCount: 0,
        },
      };
    }
    const results = [];
    results.push(...(await runUnits(plan.parallelUnits, plan.passthroughOptionArgs)));
    if (!shouldCollectAllFailures && results.some((result) => result.exitCode !== 0)) {
      const report = buildFinalRunReport(results);
      const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
      printFinalRunSummary(plan, report, reportArtifactPath);
      return report;
    }
    for (const unit of plan.serialUnits) {
      results.push(
        // eslint-disable-next-line no-await-in-loop
        ...(await runUnit(unit, plan.passthroughOptionArgs)),
      );
      if (!shouldCollectAllFailures && results.some((result) => result.exitCode !== 0)) {
        const report = buildFinalRunReport(results);
        const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
        printFinalRunSummary(plan, report, reportArtifactPath);
        return report;
      }
    }
    const report = buildFinalRunReport(results);
    const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
    printFinalRunSummary(plan, report, reportArtifactPath);
    return report;
  }

  if (plan.passthroughRequiresSingleRun && plan.passthroughOptionArgs.length > 0) {
    console.error(
      "[test-parallel] The provided Vitest args require a single run. Use the dedicated npm script for that workflow (for example `pnpm test:coverage`) or target a single test file/filter.",
    );
    return {
      exitCode: 2,
      results: [],
      summary: {
        failedRunCount: 0,
        failedUnitCount: 0,
        failedTestFileCount: 0,
        infraFailureCount: 0,
      },
    };
  }

  const results = [];
  if (plan.serialPrefixUnits.length > 0) {
    const orderedSegments = buildOrderedParallelSegments(plan.parallelUnits);
    let pendingDeferredSegment = null;
    let carriedDeferredPromise = null;
    let carriedDeferredSurface = null;
    for (const segment of orderedSegments) {
      if (segment.type === "deferred") {
        pendingDeferredSegment = segment;
        continue;
      }
      // Preserve phase ordering, but let batches inside the same shared phase use
      // the normal top-level concurrency budget.
      let deferredPromise = null;
      let deferredCarryPromise = carriedDeferredPromise;
      let deferredCarrySurface = carriedDeferredSurface;
      if (
        segment.phase === "unit-fast" &&
        pendingDeferredSegment !== null &&
        plan.topLevelParallelEnabled
      ) {
        const availableSlots = Math.max(0, plan.topLevelParallelLimit - segment.units.length);
        if (availableSlots > 0) {
          const prePhaseDeferred = pendingDeferredSegment.units;
          if (prePhaseDeferred.length > 0) {
            deferredCarryPromise = runUnitsWithLimit(
              prePhaseDeferred,
              plan.passthroughOptionArgs,
              availableSlots,
            );
            deferredCarrySurface = prePhaseDeferred.some((unit) => unit.surface === "channels")
              ? "channels"
              : null;
            pendingDeferredSegment = null;
          }
        }
      }
      if (pendingDeferredSegment !== null) {
        const prioritizedDeferred = prioritizeDeferredUnitsForPhase(
          pendingDeferredSegment.units,
          segment.phase,
        );
        if (segment.phase === "extensions") {
          const { matching: channelDeferred, remaining: otherDeferred } = partitionUnitsBySurface(
            prioritizedDeferred,
            "channels",
          );
          deferredPromise =
            otherDeferred.length > 0
              ? runUnitsWithLimit(
                  otherDeferred,
                  plan.passthroughOptionArgs,
                  plan.deferredRunConcurrency ?? 1,
                )
              : null;
          deferredCarryPromise =
            channelDeferred.length > 0
              ? runUnitsWithLimit(
                  channelDeferred,
                  plan.passthroughOptionArgs,
                  plan.deferredRunConcurrency ?? 1,
                )
              : carriedDeferredPromise;
          deferredCarrySurface = channelDeferred.length > 0 ? "channels" : carriedDeferredSurface;
        } else {
          deferredPromise = runUnitsWithLimit(
            prioritizedDeferred,
            plan.passthroughOptionArgs,
            plan.deferredRunConcurrency ?? 1,
          );
        }
      }
      pendingDeferredSegment = null;
      // eslint-disable-next-line no-await-in-loop
      const serialPhaseResults = await runUnits(segment.units, plan.passthroughOptionArgs);
      results.push(...serialPhaseResults);
      if (!shouldCollectAllFailures && serialPhaseResults.some((result) => result.exitCode !== 0)) {
        const report = buildFinalRunReport(results);
        const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
        printFinalRunSummary(plan, report, reportArtifactPath);
        return report;
      }
      if (deferredCarryPromise !== null && deferredCarrySurface === segment.phase) {
        const carriedDeferredResults =
          // eslint-disable-next-line no-await-in-loop
          await deferredCarryPromise;
        results.push(...carriedDeferredResults);
        if (
          !shouldCollectAllFailures &&
          carriedDeferredResults.some((result) => result.exitCode !== 0)
        ) {
          const report = buildFinalRunReport(results);
          const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
          printFinalRunSummary(plan, report, reportArtifactPath);
          return report;
        }
        deferredCarryPromise = null;
        deferredCarrySurface = null;
      }
      if (deferredPromise !== null) {
        const deferredResults =
          // eslint-disable-next-line no-await-in-loop
          await deferredPromise;
        results.push(...deferredResults);
        if (!shouldCollectAllFailures && deferredResults.some((result) => result.exitCode !== 0)) {
          const report = buildFinalRunReport(results);
          const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
          printFinalRunSummary(plan, report, reportArtifactPath);
          return report;
        }
      }
      carriedDeferredPromise = deferredCarryPromise;
      carriedDeferredSurface = deferredCarrySurface;
    }
    if (pendingDeferredSegment !== null) {
      const deferredParallelResults = await runUnitsWithLimit(
        pendingDeferredSegment.units,
        plan.passthroughOptionArgs,
        plan.deferredRunConcurrency ?? 1,
      );
      results.push(...deferredParallelResults);
      if (
        !shouldCollectAllFailures &&
        deferredParallelResults.some((result) => result.exitCode !== 0)
      ) {
        const report = buildFinalRunReport(results);
        const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
        printFinalRunSummary(plan, report, reportArtifactPath);
        return report;
      }
    }
    if (carriedDeferredPromise !== null) {
      const carriedDeferredResults = await carriedDeferredPromise;
      results.push(...carriedDeferredResults);
      if (
        !shouldCollectAllFailures &&
        carriedDeferredResults.some((result) => result.exitCode !== 0)
      ) {
        const report = buildFinalRunReport(results);
        const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
        printFinalRunSummary(plan, report, reportArtifactPath);
        return report;
      }
    }
  } else {
    const parallelResults = await runUnits(plan.parallelUnits, plan.passthroughOptionArgs);
    results.push(...parallelResults);
    if (!shouldCollectAllFailures && parallelResults.some((result) => result.exitCode !== 0)) {
      const report = buildFinalRunReport(results);
      const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
      printFinalRunSummary(plan, report, reportArtifactPath);
      return report;
    }
  }

  for (const unit of plan.serialUnits) {
    results.push(
      // eslint-disable-next-line no-await-in-loop
      ...(await runUnit(unit, plan.passthroughOptionArgs)),
    );
    if (!shouldCollectAllFailures && results.some((result) => result.exitCode !== 0)) {
      const report = buildFinalRunReport(results);
      const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
      printFinalRunSummary(plan, report, reportArtifactPath);
      return report;
    }
  }
  const report = buildFinalRunReport(results);
  const reportArtifactPath = artifacts.writeTempJsonArtifact("summary-report", report);
  printFinalRunSummary(plan, report, reportArtifactPath);
  return report;
}
