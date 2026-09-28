#!/usr/bin/env node

// Profiles cold-import process CPU and peak RSS, not plugin activation or workload cost.
import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import pMap, { pMapSkip } from "p-map";
import {
  ensureExtensionMemoryBuild,
  findBuiltExtensionMemoryEntries,
} from "./ensure-extension-memory-build.mts";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mts";
import { appendBoundedTail } from "./lib/bounded-output-tail.mjs";
import { formatErrorMessage } from "./lib/error-format.mts";
import {
  captureImportIdentity,
  importCpuDelta,
  importIdentityGaps,
  parseImportResources,
  RESOURCE_MARKER,
  type ImportResources,
} from "./lib/extension-import-profile.mts";
import { hasUnjoinedWork, inspectManagedProcessGroup } from "./lib/managed-child-process.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_COMBINED_TIMEOUT_MS = 180_000;
const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_TOP = 10;
const OUTPUT_CAPTURE_MAX_CHARS = 128 * 1024;
const STDERR_PREVIEW_MAX_CHARS = 8 * 1024;
type ParentSignal = "SIGHUP" | "SIGINT" | "SIGTERM";
type OutputCapture = { text: string; truncatedChars: number };
type RunCaseResult = {
  code: number | null;
  error: string | null;
  maxRssMb: number | null;
  resources: ImportResources | null;
  completion: "baseline" | "imports" | null;
  cleanup: { childClosed: boolean; processGroup: "verified" | "unavailable" };
  name: string;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};
type CaseChild = ChildProcessByStdio<null, Readable, Readable>;
type ActiveCase = {
  stop: (signal: NodeJS.Signals) => void;
  completion: Promise<RunCaseResult>;
};

const PARENT_SIGNAL_EXIT_CODES = new Map<ParentSignal, number>([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
const activeCases = new Set<ActiveCase>();
const parentSignalHandlers = new Map<ParentSignal, () => void>();
let parentSignalHandlersInstalled = false;
let parentSignalShutdownStarted = false;
let parentSignalShutdown: Promise<void> | undefined;

function defaultJsonReportPath(): string {
  return path.join(
    os.tmpdir(),
    `openclaw-extension-memory-${process.pid}-${Date.now()}-${randomUUID()}.json`,
  );
}

function printHelp(): void {
  console.log(`Usage: node --import tsx scripts/profile-extension-memory.mts [options]

Profiles peak RSS for built bundled plugin entrypoints.
Run pnpm build first if you want stats for the latest source changes.

Options:
  --extension, -e <id>     Limit profiling to one or more extension ids (repeatable)
  --concurrency <n>        Number of per-extension workers (default: ${DEFAULT_CONCURRENCY})
  --timeout-ms <ms>        Per-extension timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --combined-timeout-ms <ms>
                           Combined-import timeout in milliseconds (default: ${DEFAULT_COMBINED_TIMEOUT_MS})
  --top <n>                Show top N entries by delta from baseline (default: ${DEFAULT_TOP})
  --json <path>            Write full JSON report to this path
  --skip-combined          Skip the combined all-imports measurement
  --help                   Show this help

Examples:
  pnpm test:extensions:memory
  pnpm test:extensions:memory -- --extension discord
  pnpm test:extensions:memory -- --extension discord --extension telegram --skip-combined
`);
}

/**
 * Parses extension memory profiler options after pnpm's optional separator.
 */
export function parseArgs(argv: string[]): {
  extensions: string[];
  concurrency: number;
  timeoutMs: number;
  combinedTimeoutMs: number;
  top: number;
  jsonPath: string | null;
  skipCombined: boolean;
} {
  const args = stripLeadingPackageManagerSeparator(argv);
  const options: ReturnType<typeof parseArgs> = {
    extensions: [],
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    combinedTimeoutMs: DEFAULT_COMBINED_TIMEOUT_MS,
    top: DEFAULT_TOP,
    jsonPath: null,
    skipCombined: false,
  };

  parseArgv: for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break parseArgv;
      case "--extension":
      case "-e": {
        const next = args[index + 1];
        if (!next || next.startsWith("-")) {
          throw new Error(`${arg} requires a value`);
        }
        options.extensions.push(next);
        index += 1;
        break;
      }
      case "--concurrency":
        options.concurrency = parsePositiveInt(args[index + 1] ?? "", arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(args[index + 1] ?? "", arg);
        index += 1;
        break;
      case "--combined-timeout-ms":
        options.combinedTimeoutMs = parsePositiveInt(args[index + 1] ?? "", arg);
        index += 1;
        break;
      case "--top":
        options.top = parsePositiveInt(args[index + 1] ?? "", arg);
        index += 1;
        break;
      case "--json": {
        const next = args[index + 1];
        if (!next || next.startsWith("-")) {
          throw new Error(`${arg} requires a value`);
        }
        options.jsonPath = path.resolve(next);
        index += 1;
        break;
      }
      case "--skip-combined":
        options.skipCombined = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function createOutputCapture(): OutputCapture {
  return { text: "", truncatedChars: 0 };
}

function formatCapturedOutput(capture: OutputCapture): string {
  if (capture.truncatedChars === 0) {
    return capture.text;
  }
  return `[output truncated ${capture.truncatedChars} chars; showing tail]\n${capture.text}`;
}

function summarizeStderr(stderr: string, lines = 8, maxChars = STDERR_PREVIEW_MAX_CHARS): string {
  const text = stderr.trim().split("\n").filter(Boolean).slice(0, lines).join("\n");
  if (text.length <= maxChars) {
    return text;
  }
  const firstLine = text.split("\n", 1)[0] ?? "";
  const prefix = firstLine.startsWith("[output truncated") ? `${firstLine}\n` : "";
  return `${prefix}[stderr preview truncated ${text.length - maxChars} chars; showing tail]\n${text.slice(
    -maxChars,
  )}`;
}

function describeCaseFailure(result: RunCaseResult, errors: Error[] = []): string {
  const limit = Math.floor(STDERR_PREVIEW_MAX_CHARS / (errors.length + 2));
  return [
    `${result.name}: code=${result.code}, signal=${result.signal}, timedOut=${result.timedOut}`,
    result.stderr,
    ...errors.map(formatErrorMessage),
  ]
    .map((part) => summarizeStderr(part, 8, limit))
    .filter(Boolean)
    .join("; ");
}

function summarizeCase(result: RunCaseResult) {
  const status = result.timedOut ? "timeout" : result.error || result.code !== 0 ? "fail" : "ok";
  return {
    status,
    code: result.code,
    signal: result.signal,
    error: result.error ?? (status === "ok" ? null : describeCaseFailure(result)),
    maxRssMb: result.maxRssMb,
    resources: result.resources,
    completion: result.completion,
    cleanup: result.cleanup,
    stderrPreview: summarizeStderr(result.stderr),
  };
}

/**
 * Runs one import scenario in a child process and captures bounded output plus RSS.
 */
export function runCase({
  repoRoot,
  env,
  hookPath,
  name,
  body,
  completionKind,
  timeoutMs,
  shutdownGraceMs = DEFAULT_CHILD_SHUTDOWN_GRACE_MS,
  spawnImpl = spawn,
}: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  hookPath: string;
  name: string;
  body: string;
  completionKind: "baseline" | "imports";
  timeoutMs: number;
  shutdownGraceMs?: number | undefined;
  spawnImpl?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">,
  ) => CaseChild;
}): Promise<RunCaseResult> {
  if (parentSignalShutdownStarted) {
    return Promise.reject(new Error("Profiling interrupted by parent signal"));
  }
  let child: CaseChild | undefined;
  let stdout = createOutputCapture();
  let stderr = createOutputCapture();
  let resourceTail = "";
  const observation: { resources: ImportResources | null } = { resources: null };
  const completionMarker = `__OPENCLAW_IMPORT_COMPLETE__=${randomUUID()}`;
  let completed = false;
  let timedOut = false;
  let closed = false;
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let failure: Error | undefined;
  const errors: Error[] = [];
  let parentStopDeadline: number | undefined;
  let killDeadline: number | undefined;
  let registrationError: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake!: () => void;
  const outcome = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const recordFailure = (error: unknown) => {
    const next = error instanceof Error ? error : new Error(formatErrorMessage(error));
    errors.push(next);
    failure = failure
      ? new AggregateError([failure, next], `${failure.message}; ${next.message}`)
      : next;
  };
  const sendSignal = (requested: NodeJS.Signals, deadlineAt = Date.now() + shutdownGraceMs) => {
    if (!child || (requested === "SIGKILL" && killDeadline !== undefined)) {
      return;
    }
    if (requested === "SIGKILL") {
      killDeadline = deadlineAt;
    }
    try {
      signalChildProcessTree(child, requested);
    } catch (error) {
      recordFailure(error);
    }
  };
  const stop = (requested: NodeJS.Signals) => {
    if (parentStopDeadline === undefined) {
      parentStopDeadline = Date.now() + shutdownGraceMs;
      if (killDeadline === undefined) {
        sendSignal(requested);
      }
    } else if (requested === "SIGKILL") {
      sendSignal(requested);
    }
    // A failed signal or missing exit event must still enter bounded case finalization.
    wake();
  };
  const fullyClosed = (deadlineAt: number) =>
    closed && child !== undefined && !childProcessTreeIsAlive(child, deadlineAt);
  const waitForClosure = async (deadline: number, graceful = false) => {
    while (!fullyClosed(deadline)) {
      if (graceful && killDeadline !== undefined) {
        break;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(50, remainingMs));
      });
    }
  };
  // Publish the completion before installing signal handlers or spawning. The parent
  // joins this same promise, including finally, and the case never awaits the parent.
  const completion = Promise.resolve()
    .then(async () => {
      if (registrationError !== undefined) {
        throw registrationError;
      }
      if (parentSignalShutdownStarted) {
        throw new Error("Profiling interrupted by parent signal");
      }
      child = spawnImpl(
        process.execPath,
        [
          "--import",
          pathToFileURL(hookPath).href,
          "--input-type=module",
          "--eval",
          // Only reaching the end of the awaited body grants completion. A plugin can
          // exit with code zero during import, still emitting the exit-hook counters.
          `${body}\nconst { writeSync: completeImport } = await import("node:fs");\ncompleteImport(2, ${JSON.stringify(`\n${completionMarker}\n`)});\nprocess.exit(0);`,
        ],
        {
          cwd: repoRoot,
          detached: process.platform !== "win32",
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let cleanupError: Error | undefined;
      try {
        try {
          child.on("error", (error) => {
            recordFailure(error);
            wake();
          });
          // Exit starts cleanup even when descendants still hold the output pipes.
          child.once("exit", (exitCode, exitSignal) => {
            code = exitCode;
            signal = exitSignal;
            wake();
          });
          child.once("close", (exitCode, exitSignal) => {
            code = exitCode;
            signal = exitSignal;
            closed = true;
            wake();
          });
          child.stdout.setEncoding("utf8").on("data", (chunk) => {
            stdout = appendBoundedTail(stdout, chunk, OUTPUT_CAPTURE_MAX_CHARS);
          });
          child.stderr.setEncoding("utf8").on("data", (chunk) => {
            const resourceLines = `${resourceTail}${String(chunk)}`.split("\n");
            resourceTail = (resourceLines.pop() ?? "").slice(-4096);
            for (const line of resourceLines) {
              if (line === completionMarker) {
                completed = true;
              }
              const sample = parseImportResources(line);
              // Node descendants can inherit the preload and stderr. Only the
              // importing leader owns this case's CPU and peak RSS observation.
              if (sample && sample.pid === child?.pid) {
                observation.resources = sample;
              }
            }
            stderr = appendBoundedTail(stderr, chunk, OUTPUT_CAPTURE_MAX_CHARS);
          });
          timer = setTimeout(() => {
            timedOut = true;
            wake();
          }, timeoutMs);
          timer.unref?.();
        } catch (error) {
          recordFailure(error);
          wake();
        }
        await outcome;
        clearTimeout(timer);
        if (child.pid) {
          // Charge the preliminary snapshot to cleanup too; it cannot earn a
          // fresh drainage allowance after consuming the current phase.
          const cleanupDeadline =
            killDeadline ?? (parentStopDeadline ?? Date.now()) + shutdownGraceMs;
          if (parentStopDeadline !== undefined && killDeadline === undefined) {
            await waitForClosure(parentStopDeadline, true);
          }
          if (timedOut || !fullyClosed(killDeadline ?? parentStopDeadline ?? cleanupDeadline)) {
            sendSignal("SIGKILL", cleanupDeadline);
          }
          const deadlineAt = killDeadline ?? cleanupDeadline;
          await waitForClosure(deadlineAt);
          if (!fullyClosed(deadlineAt)) {
            cleanupError = Object.assign(
              new Error(
                `${name} cleanup could not verify child, process group, and output closure`,
              ),
              { code: "EPROCESSGROUP_CLEANUP_FAILED", processTreeState: "indeterminate" },
            );
          }
        }
      } finally {
        clearTimeout(timer);
        if (!closed) {
          for (const stream of [child.stdout, child.stderr]) {
            try {
              stream.destroy();
            } catch (error) {
              recordFailure(error);
            }
          }
        }
      }
      const stderrText = formatCapturedOutput(stderr);
      const result: RunCaseResult = {
        name,
        code,
        signal,
        timedOut,
        error: null,
        stdout: formatCapturedOutput(stdout),
        stderr: stderrText,
        maxRssMb: observation.resources ? observation.resources.maxRssKb / 1024 : null,
        resources: observation.resources,
        completion: completed ? completionKind : null,
        // Windows currently observes only the leader; do not claim descendant proof.
        cleanup: {
          childClosed: closed,
          processGroup:
            child.pid && !cleanupError && process.platform !== "win32" ? "verified" : "unavailable",
        },
      };
      if (cleanupError) {
        const message = describeCaseFailure(result, [...errors, cleanupError]);
        // Keep the cleanup tag for HOME retention and terminal evidence even without
        // an Error event. Structured primary errors remain intact in the aggregate.
        Object.assign(cleanupError, {
          message,
          exitCode: code,
          exitSignal: signal,
          timedOut,
          stderrPreview: summarizeStderr(stderrText),
        });
        throw failure ? new AggregateError([failure, cleanupError], message) : cleanupError;
      }
      result.error = failure
        ? describeCaseFailure(result, errors)
        : completed
          ? null
          : `${name}: ${completionKind} sequence did not complete`;
      return result;
    })
    .finally(() => untrackActiveCase(owner));
  const owner = { stop, completion };
  try {
    trackActiveCase(owner);
  } catch (error) {
    registrationError = error instanceof Error ? error : new Error(formatErrorMessage(error));
  }
  return completion;
}

function signalChildProcessTree(child: CaseChild, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      // The POSIX spawn owns a detached group; signaling just its leader cannot replace it.
      throw error;
    }
  }
  child.kill(signal);
}

function childProcessTreeIsAlive(child: CaseChild, deadlineAt: number): boolean {
  if (typeof child.pid !== "number") {
    return false;
  }
  return (
    inspectManagedProcessGroup(child, {
      deadlineAt,
      errorPolicy: "indeterminate",
      inspectLeaderWhenNoGroup: true,
    }) !== "dead"
  );
}

function trackActiveCase(owner: ActiveCase): void {
  activeCases.add(owner);
  installParentSignalHandlers();
}

function untrackActiveCase(owner: ActiveCase): void {
  activeCases.delete(owner);
  if (activeCases.size === 0) {
    removeParentSignalHandlers();
  }
}

function installParentSignalHandlers(): void {
  if (parentSignalHandlersInstalled) {
    return;
  }
  parentSignalHandlersInstalled = true;
  for (const signal of PARENT_SIGNAL_EXIT_CODES.keys()) {
    const handler = () => handleParentSignal(signal);
    parentSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeParentSignalHandlers(): void {
  if (!parentSignalHandlersInstalled || parentSignalShutdownStarted) {
    return;
  }
  removeInstalledParentSignalHandlers();
}

function removeInstalledParentSignalHandlers(): void {
  if (!parentSignalHandlersInstalled) {
    return;
  }
  parentSignalHandlersInstalled = false;
  for (const [signal, handler] of parentSignalHandlers) {
    process.off(signal, handler);
  }
  parentSignalHandlers.clear();
}

function handleParentSignal(signal: ParentSignal): void {
  if (parentSignalShutdownStarted) {
    for (const owner of activeCases) {
      owner.stop("SIGKILL");
    }
    return;
  }
  parentSignalShutdownStarted = true;
  parentSignalShutdown = cleanupActiveCaseChildrenForParentSignal(signal);
}

async function cleanupActiveCaseChildrenForParentSignal(signal: ParentSignal): Promise<void> {
  const owners = [...activeCases];
  for (const owner of owners) {
    owner.stop(signal);
  }
  const outcomes = await Promise.allSettled(owners.map((owner) => owner.completion));
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      console.error(`[extension-memory] ${formatErrorMessage(outcome.reason)}`);
    } else if (summarizeCase(outcome.value).status !== "ok") {
      console.error(
        `[extension-memory] ${outcome.value.error ?? describeCaseFailure(outcome.value)}`,
      );
    }
  }
  removeInstalledParentSignalHandlers();
  process.exit(PARENT_SIGNAL_EXIT_CODES.get(signal) ?? 1);
}

function buildImportBody(entryFiles: string[], label: string): string {
  const imports = entryFiles
    .map((filePath) => `await import(${JSON.stringify(pathToFileURL(filePath).href)});`)
    .join("\n");
  return `${imports}\nconsole.log(${JSON.stringify(label)});\n`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  ensureExtensionMemoryBuild({
    rootDir: repoRoot,
    requiredExtensionIds: options.extensions,
  });
  const allEntries = findBuiltExtensionMemoryEntries(repoRoot);
  if (allEntries.length === 0) {
    throw new Error(
      "No built plugin entrypoints found in root or package-local output. Run pnpm build or build the plugin package first.",
    );
  }
  const selectedEntries =
    options.extensions.length === 0
      ? allEntries
      : allEntries.filter((entry) => options.extensions.includes(entry.dir));

  const missing = options.extensions.filter((id) => !allEntries.some((entry) => entry.dir === id));
  if (missing.length > 0) {
    throw new Error(`Unknown built extension ids: ${missing.join(", ")}`);
  }
  if (selectedEntries.length === 0) {
    throw new Error("No extensions selected for profiling");
  }

  const entryFiles = selectedEntries.map((entry) => entry.file);
  const identityBefore = captureImportIdentity(repoRoot, entryFiles);
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-memory-"));
  const hookPath = path.join(tmpHome, "measure-rss.mjs");
  const jsonPath = options.jsonPath ?? defaultJsonReportPath();

  writeFileSync(
    hookPath,
    [
      "import { writeSync } from 'node:fs';",
      "process.on('exit', () => {",
      "  const usage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;",
      "  if (usage) {",
      "    const runtime = { node: process.version, v8: process.versions.v8, abi: process.versions.modules, platform: process.platform, arch: process.arch };",
      "    const sample = { pid: process.pid, maxRssKb: usage.maxRSS, userCpuUs: usage.userCPUTime, systemCpuUs: usage.systemCPUTime, runtime };",
      `    writeSync(2, ${JSON.stringify(RESOURCE_MARKER)} + JSON.stringify(sample) + '\\n');`,
      "  }",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const env = {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, ".config"),
    XDG_DATA_HOME: path.join(tmpHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(tmpHome, ".cache"),
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_NO_RESPAWN: "1",
    TERM: process.env.TERM ?? "dumb",
    LANG: process.env.LANG ?? "C.UTF-8",
  };

  const runErrors: unknown[] = [];
  let publishReport: ((temporaryHomeRemoved: boolean) => void) | undefined;
  try {
    const baseline = await runCase({
      repoRoot,
      env,
      hookPath,
      name: "baseline",
      body: "",
      completionKind: "baseline",
      timeoutMs: options.timeoutMs,
    });

    const combined = options.skipCombined
      ? null
      : await runCase({
          repoRoot,
          env,
          hookPath,
          name: "combined",
          completionKind: "imports",
          body: buildImportBody(
            selectedEntries.map((entry) => entry.file),
            "IMPORTED_ALL",
          ),
          timeoutMs: options.combinedTimeoutMs,
        });

    const mapperErrors: unknown[] = [];
    const results = await pMap(
      selectedEntries,
      async (next) => {
        if (mapperErrors.length > 0 || parentSignalShutdownStarted) {
          return pMapSkip;
        }
        try {
          const result = await runCase({
            repoRoot,
            env,
            hookPath,
            name: next.dir,
            completionKind: "imports",
            body: buildImportBody([next.file], "IMPORTED"),
            timeoutMs: options.timeoutMs,
          });
          const entry = {
            dir: next.dir,
            file: next.file,
            relativeFile: path.relative(repoRoot, next.file).split(path.sep).join("/"),
            cpuDeltaFromBaseline: importCpuDelta(result.resources, baseline.resources),
            ...summarizeCase(result),
            deltaFromBaselineMb:
              result.maxRssMb !== null && baseline.maxRssMb !== null
                ? result.maxRssMb - baseline.maxRssMb
                : null,
          };

          const rss = result.maxRssMb === null ? "n/a" : `${result.maxRssMb.toFixed(1)} MB`;
          console.log(`[extension-memory] ${next.dir}: ${entry.status} ${rss}`);
          return entry;
        } catch (error) {
          // p-map rejects before active mappers join. Fulfill failures, stop new admission,
          // then propagate every error only after all admitted case owners have settled.
          mapperErrors.push(error);
          return pMapSkip;
        }
      },
      { concurrency: options.concurrency, stopOnError: false },
    );
    if (parentSignalShutdownStarted) {
      mapperErrors.push(new Error("Profiling interrupted by parent signal"));
    }
    if (mapperErrors.length > 0) {
      throw new AggregateError(mapperErrors, mapperErrors.map(formatErrorMessage).join("; "));
    }

    results.sort((a, b) => a.dir.localeCompare(b.dir));
    const top = results
      .filter((entry) => entry.status === "ok" && typeof entry.deltaFromBaselineMb === "number")
      .toSorted((a, b) => (b.deltaFromBaselineMb ?? 0) - (a.deltaFromBaselineMb ?? 0))
      .slice(0, options.top);

    const report = {
      schemaVersion: 2,
      scope: "cold-import",
      measurement: {
        cpu: "child-process-through-exit-hook-microseconds",
        rss: "process-peak-MiB",
        termination: "explicit-process-exit",
      },
      generatedAt: new Date().toISOString(),
      repoRoot,
      provenance: {
        before: identityBefore,
        after: captureImportIdentity(repoRoot, entryFiles),
        dependencyClosure: "not-attested",
      },
      selectedExtensions: selectedEntries.map((entry) => entry.dir),
      baseline: summarizeCase(baseline),
      combined:
        combined === null
          ? null
          : {
              ...summarizeCase(combined),
              cpuDeltaFromBaseline: importCpuDelta(combined.resources, baseline.resources),
              stderrPreview: summarizeStderr(combined.stderr, 12),
            },
      counts: {
        totalEntries: selectedEntries.length,
        ok: results.filter((entry) => entry.status === "ok").length,
        fail: results.filter((entry) => entry.status === "fail").length,
        timeout: results.filter((entry) => entry.status === "timeout").length,
      },
      options: {
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        combinedTimeoutMs: options.combinedTimeoutMs,
        skipCombined: options.skipCombined,
      },
      topByDeltaMb: top,
      results,
    };

    // Publish only after the owner has completed its final temporary-home cleanup.
    publishReport = (temporaryHomeRemoved) => {
      const gaps = importIdentityGaps(report.provenance.before, report.provenance.after);
      for (const row of [
        report.baseline,
        ...(report.combined ? [report.combined] : []),
        ...results,
      ]) {
        if (row.completion === null) {
          gaps.push("awaited sequence completion unavailable");
        }
        if (row.status !== "ok") {
          gaps.push("import did not complete successfully");
        }
        if (row.maxRssMb === null || !row.resources) {
          gaps.push("resource counters unavailable");
        }
        if (
          row.resources &&
          baseline.resources &&
          !importCpuDelta(row.resources, baseline.resources)
        ) {
          gaps.push("child runtime identity differs from baseline");
        }
        if (!row.cleanup.childClosed || row.cleanup.processGroup !== "verified") {
          gaps.push("child/process-group closure unavailable");
        }
      }
      if (!temporaryHomeRemoved) {
        gaps.push("temporary-home cleanup incomplete");
      }
      const qualification = {
        qualified: gaps.length === 0,
        gaps: [...new Set(gaps)],
        scope: "cold-import-snapshot",
        temporaryHomeRemoved,
      };
      mkdirSync(path.dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, `${JSON.stringify({ ...report, qualification }, null, 2)}\n`, "utf8");
      console.log(`[extension-memory] report: ${jsonPath}`);
      console.log(
        JSON.stringify(
          {
            baselineMb: report.baseline.maxRssMb,
            combinedMb: report.combined?.maxRssMb ?? null,
            counts: report.counts,
            topByDeltaMb: report.topByDeltaMb,
            qualification,
          },
          null,
          2,
        ),
      );
      if (!qualification.qualified) {
        console.error(`[extension-memory] unqualified screening: ${qualification.gaps.join("; ")}`);
      }
    };

    const failures = [];
    if (report.baseline.status !== "ok") {
      failures.push(`baseline import ${report.baseline.status}: ${report.baseline.error}`);
    }
    if (report.baseline.maxRssMb === null) {
      failures.push("baseline import did not report RSS");
    }
    if (report.combined !== null) {
      if (report.combined.status !== "ok") {
        failures.push(`combined import ${report.combined.status}: ${report.combined.error}`);
      }
      if (report.combined.maxRssMb === null) {
        failures.push("combined import did not report RSS");
      }
    }
    for (const result of report.results) {
      if (result.status !== "ok") {
        failures.push(`${result.dir} import ${result.status}: ${result.error}`);
      }
      if (result.maxRssMb === null) {
        failures.push(`${result.dir} import did not report RSS`);
      }
    }
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`[extension-memory] ${failure}`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    runErrors.push(error);
  }
  // The signal owner retains the exit status and must finish its snapshot's cleanup.
  if (parentSignalShutdown) {
    await parentSignalShutdown;
    return;
  }
  let temporaryHomeRemoved = false;
  if (runErrors.some(hasUnjoinedWork)) {
    console.error(
      `[extension-memory] retained temporary home after unverified cleanup: ${tmpHome}`,
    );
  } else {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
      temporaryHomeRemoved = true;
    } catch (error) {
      runErrors.push(error);
    }
  }
  publishReport?.(temporaryHomeRemoved);
  if (runErrors.length > 0) {
    throw new AggregateError(runErrors, runErrors.map(formatErrorMessage).join("; "));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`[extension-memory] ${formatErrorMessage(error)}`);
    process.exit(1);
  }
}
