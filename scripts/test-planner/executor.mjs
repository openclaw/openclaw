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

const resolvePnpmCommand = (runtimeProfile) => (runtimeProfile.isWindows ? "pnpm.cmd" : "pnpm");

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

export function formatPlanOutput(plan) {
  return [
    `runtimeProfile=${plan.runtimeProfile.runtimeProfileName} mode=${plan.runtimeProfile.mode} testProfile=${plan.runtimeProfile.testProfile}`,
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
    `runtimeProfile=${explanation.runtimeProfile}`,
    `surface=${explanation.surface}`,
    `isolate=${explanation.isolate ? "yes" : "no"}`,
    `pool=${explanation.pool}`,
    `maxWorkers=${String(explanation.maxWorkers ?? "default")}`,
    `reasons=${explanation.reasons.join(",")}`,
    `command=${explanation.args.join(" ")}`,
  ].join("\n");
}

export async function executePlan(plan, options = {}) {
  const env = options.env ?? process.env;
  const artifacts = options.artifacts ?? createExecutionArtifacts(env);
  const pnpm = resolvePnpmCommand(plan.runtimeProfile);
  const children = new Set();
  const windowsCiArgs = plan.runtimeProfile.isWindowsCi
    ? ["--dangerouslyIgnoreUnhandledErrors"]
    : [];
  const silentArgs = env.OPENCLAW_TEST_SHOW_PASSED_LOGS === "1" ? [] : ["--silent=passed-only"];
  const rawMemoryTrace = env.OPENCLAW_TEST_MEMORY_TRACE?.trim().toLowerCase();
  const memoryTraceEnabled =
    process.platform !== "win32" &&
    (rawMemoryTrace === "1" ||
      rawMemoryTrace === "true" ||
      (rawMemoryTrace !== "0" && rawMemoryTrace !== "false" && plan.runtimeProfile.isCI));
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
    if (plan.runtimeProfile.isCI && !plan.runtimeProfile.isWindows) {
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
      laneLogStream.write(`[test-parallel] command=${[pnpm, ...args].join(" ")}\n\n`);
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
          resolve(1);
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
      const memoryFileRecords = [];
      let initialTreeSample = null;
      let latestTreeSample = null;
      let peakTreeSample = null;
      let heapSnapshotSequence = 0;
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
      try {
        child = spawn(pnpm, args, {
          stdio: ["inherit", "pipe", "pipe"],
          env: {
            ...env,
            ...unit.env,
            VITEST_GROUP: unit.id,
            NODE_OPTIONS: resolvedNodeOptions,
          },
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
        resolve(1);
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
      child.on("close", (code, signal) => {
        if (memoryPollTimer) {
          clearInterval(memoryPollTimer);
        }
        if (heapSnapshotTimer) {
          clearInterval(heapSnapshotTimer);
        }
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
          const failureTail = formatCapturedOutputTail(output);
          const failureArtifactPath = artifacts.writeTempJsonArtifact(`${artifactStem}-failure`, {
            entry: unit.id,
            command: [pnpm, ...args],
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
        laneLogStream.write(
          `\n[test-parallel] done ${unit.id} code=${String(resolvedCode)} signal=${
            signal ?? "none"
          } elapsed=${formatElapsedMs(elapsedMs)}\n`,
        );
        laneLogStream.end();
        console.log(
          `[test-parallel] done ${unit.id} code=${String(resolvedCode)} elapsed=${formatElapsedMs(elapsedMs)}`,
        );
        resolve(resolvedCode);
      });
    });

  const runUnit = async (unit, extraArgs = []) => {
    if (unit.fixedShardIndex !== undefined) {
      if (plan.shardIndexOverride !== null && plan.shardIndexOverride !== unit.fixedShardIndex) {
        return 0;
      }
      return runOnce(unit, extraArgs);
    }
    const explicitFilterCount = countExplicitEntryFilters(unit.args);
    const topLevelAssignedShard = plan.topLevelSingleShardAssignments.get(unit.id);
    if (topLevelAssignedShard !== undefined) {
      if (plan.shardIndexOverride !== null && plan.shardIndexOverride !== topLevelAssignedShard) {
        return 0;
      }
      return runOnce(unit, extraArgs);
    }
    const effectiveShardCount =
      explicitFilterCount === null
        ? plan.shardCount
        : Math.min(plan.shardCount, Math.max(1, explicitFilterCount - 1));
    if (effectiveShardCount <= 1) {
      if (plan.shardIndexOverride !== null && plan.shardIndexOverride > effectiveShardCount) {
        return 0;
      }
      return runOnce(unit, extraArgs);
    }
    if (plan.shardIndexOverride !== null) {
      if (plan.shardIndexOverride > effectiveShardCount) {
        return 0;
      }
      return runOnce(unit, [
        "--shard",
        `${plan.shardIndexOverride}/${effectiveShardCount}`,
        ...extraArgs,
      ]);
    }
    for (let shardIndex = 1; shardIndex <= effectiveShardCount; shardIndex += 1) {
      // eslint-disable-next-line no-await-in-loop
      const code = await runOnce(unit, [
        "--shard",
        `${shardIndex}/${effectiveShardCount}`,
        ...extraArgs,
      ]);
      if (code !== 0) {
        return code;
      }
    }
    return 0;
  };

  const runUnitsWithLimit = async (units, extraArgs = [], concurrency = 1) => {
    if (units.length === 0) {
      return undefined;
    }
    const normalizedConcurrency = Math.max(1, Math.floor(concurrency));
    if (normalizedConcurrency <= 1) {
      for (const unit of units) {
        // eslint-disable-next-line no-await-in-loop
        const code = await runUnit(unit, extraArgs);
        if (code !== 0) {
          return code;
        }
      }
      return undefined;
    }
    let nextIndex = 0;
    let firstFailure;
    const worker = async () => {
      while (firstFailure === undefined) {
        const unitIndex = nextIndex;
        nextIndex += 1;
        if (unitIndex >= units.length) {
          return;
        }
        const code = await runUnit(units[unitIndex], extraArgs);
        if (code !== 0 && firstFailure === undefined) {
          firstFailure = code;
        }
      }
    };
    const workerCount = Math.min(normalizedConcurrency, units.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return firstFailure;
  };

  const runUnits = async (units, extraArgs = []) => {
    if (plan.topLevelParallelEnabled) {
      return runUnitsWithLimit(units, extraArgs, plan.topLevelParallelLimit);
    }
    return runUnitsWithLimit(units, extraArgs);
  };

  if (plan.passthroughMetadataOnly) {
    return runOnce(
      {
        id: "vitest-meta",
        args: ["vitest", "run"],
        maxWorkers: null,
      },
      plan.passthroughOptionArgs,
    );
  }

  if (plan.targetedUnits.length > 0) {
    if (plan.passthroughRequiresSingleRun && plan.targetedUnits.length > 1) {
      console.error(
        "[test-parallel] The provided Vitest args require a single run, but the selected test filters span multiple wrapper configs. Run one target/config at a time.",
      );
      return 2;
    }
    const failedTargetedParallel = await runUnits(plan.parallelUnits, plan.passthroughOptionArgs);
    if (failedTargetedParallel !== undefined) {
      return failedTargetedParallel;
    }
    for (const unit of plan.serialUnits) {
      // eslint-disable-next-line no-await-in-loop
      const code = await runUnit(unit, plan.passthroughOptionArgs);
      if (code !== 0) {
        return code;
      }
    }
    return 0;
  }

  if (plan.passthroughRequiresSingleRun && plan.passthroughOptionArgs.length > 0) {
    console.error(
      "[test-parallel] The provided Vitest args require a single run. Use the dedicated npm script for that workflow (for example `pnpm test:coverage`) or target a single test file/filter.",
    );
    return 2;
  }

  if (plan.serialPrefixUnits.length > 0) {
    const failedSerialPrefix = await runUnitsWithLimit(
      plan.serialPrefixUnits,
      plan.passthroughOptionArgs,
      1,
    );
    if (failedSerialPrefix !== undefined) {
      return failedSerialPrefix;
    }
    const failedDeferredParallel = plan.deferredRunConcurrency
      ? await runUnitsWithLimit(
          plan.deferredParallelUnits,
          plan.passthroughOptionArgs,
          plan.deferredRunConcurrency,
        )
      : await runUnits(plan.deferredParallelUnits, plan.passthroughOptionArgs);
    if (failedDeferredParallel !== undefined) {
      return failedDeferredParallel;
    }
  } else if (plan.runtimeProfile.isMacMiniProfile && plan.targetedUnits.length === 0) {
    const unitFastUnits = plan.parallelUnits.filter((unit) => unit.id.startsWith("unit-fast"));
    for (const unit of unitFastUnits) {
      // eslint-disable-next-line no-await-in-loop
      const code = await runUnit(unit, plan.passthroughOptionArgs);
      if (code !== 0) {
        return code;
      }
    }
    const deferredUnits = plan.parallelUnits.filter((unit) => !unit.id.startsWith("unit-fast"));
    const failedMacMiniParallel = await runUnitsWithLimit(
      deferredUnits,
      plan.passthroughOptionArgs,
      3,
    );
    if (failedMacMiniParallel !== undefined) {
      return failedMacMiniParallel;
    }
  } else {
    const failedParallel = await runUnits(plan.parallelUnits, plan.passthroughOptionArgs);
    if (failedParallel !== undefined) {
      return failedParallel;
    }
  }

  for (const unit of plan.serialUnits) {
    // eslint-disable-next-line no-await-in-loop
    const code = await runUnit(unit, plan.passthroughOptionArgs);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}
