#!/usr/bin/env node

// Verifies extension packages compile through their package-local TypeScript boundary.
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import pMap from "p-map";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "../packages/normalization-core/src/number-coercion.ts";
import { collectFilesSync } from "./check-file-utils.ts";
import { appendBoundedTail } from "./lib/bounded-output-tail.mjs";
import {
  portableRelativePath,
  readArtifactRecord,
  writeArtifactRecord,
} from "./lib/build-artifact-cache.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import { toErrorObject } from "./lib/error-format.mts";
import { BOUNDARY_CACHE_ROOT, BoundaryInputSnapshot } from "./lib/extension-boundary-inputs.mts";
import { prepareExtensionBoundaryProjects } from "./lib/extension-boundary-projects.mts";
import { classifyBundledExtensionSourcePath } from "./lib/extension-source-classifier.mts";
import {
  runManagedCommand,
  signalExitCode,
  terminateManagedChild,
} from "./lib/managed-child-process.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

type BoundaryMode = "all" | "compile" | "canary";
type CompileShard = { index: number; count: number };
type StepOutputCapture = { text: string; truncatedChars: number };
type CompileTiming = { extensionId: string; elapsedMs: number };
type SkippedCompileParams = { skippedCount?: number; totalCount?: number };
type SlowCompileParams = { compileTimings?: CompileTiming[]; limit?: number };
type BoundarySummaryParams = {
  mode?: BoundaryMode;
  compileCount?: number;
  skippedCompileCount?: number;
  canaryCount?: number;
  prepElapsedMs?: number;
  compileElapsedMs?: number;
  canaryElapsedMs?: number;
  elapsedMs?: number;
};
type StepFailureParams = {
  stdout?: string;
  stderr?: string;
  kind?: string;
  elapsedMs?: number;
  note?: string;
};
type StepResult = { stdout: string; stderr: string; elapsedMs: number };
type RunNodeStepParams = {
  env?: NodeJS.ProcessEnv;
  abortController?: AbortController;
  onFailure?: (error: ReturnType<typeof attachStepFailureMetadata>) => void;
};
type BoundaryStep = {
  label: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onStart?: () => void;
  onSuccess?: (result: StepResult) => void;
};
type BoundaryCheckParams = { rootDir?: string; processObject?: Pick<EventEmitter, "on" | "off"> };
const repoRoot = resolveRepoRoot(import.meta.url);
const compilerWorker = resolve(repoRoot, "scripts/compile-extension-boundary.mts");
const prepareBoundaryArtifactsArgs = distArtifactEntryArgs(
  resolve(repoRoot, "scripts/prepare-extension-package-boundary-artifacts.mts"),
);
const extensionPackageBoundaryBaseConfig = "../tsconfig.package-boundary.base.json";
const FAILURE_OUTPUT_TAIL_LINES = 40;
const STEP_OUTPUT_MAX_CHARS = 256 * 1024;
const SLOW_COMPILE_SUMMARY_LIMIT = 10;
const ROOTDIR_BOUNDARY_CANARY_IMPORT_PATH =
  "../../src/plugins/contracts/rootdir-boundary-canary.ts";
const ROOTDIR_BOUNDARY_CANARY_OUTPUT_HINT = "src/plugins/contracts/rootdir-boundary-canary.ts";

function parseMode(argv: string[]): BoundaryMode {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "all";
  if (mode !== "all" && mode !== "compile" && mode !== "canary") {
    throw new Error(`Unknown mode: ${mode}`);
  }
  return mode;
}

function parseCompileShard(argv: string[], mode: BoundaryMode): CompileShard | undefined {
  const selectors = argv.filter((arg) => arg === "--shard" || arg.startsWith("--shard="));
  if (selectors.length === 0) {
    return undefined;
  }
  const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/u.exec(selectors[0]!);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (
    mode !== "compile" ||
    selectors.length !== 1 ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index > count
  ) {
    throw new Error(
      "Compile sharding requires --mode=compile and --shard=N/TOTAL (1 <= N <= TOTAL)",
    );
  }
  return { index: index - 1, count };
}

/**
 * Reserve at least two CPU slots per compiler, including explicit CI requests.
 */
export function resolveCompileConcurrency(
  env: NodeJS.ProcessEnv = process.env,
  availableParallelism = os.availableParallelism(),
) {
  const raw = env.OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY?.trim();
  const capacity = Math.max(1, Math.floor(availableParallelism / 2));
  return raw
    ? Math.min(capacity, parsePositiveInt(raw, "OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY"))
    : capacity;
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function summarizeOutputSection(name: string, output: string) {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split("\n");
  if (lines.length <= FAILURE_OUTPUT_TAIL_LINES) {
    return `${name}:\n${trimmed}`;
  }

  const omittedLineCount = lines.length - FAILURE_OUTPUT_TAIL_LINES;
  const tail = lines.slice(-FAILURE_OUTPUT_TAIL_LINES).join("\n");
  return `${name}:\n[... ${omittedLineCount} earlier lines omitted ...]\n${tail}`;
}

function formatFailureFooter(params: StepFailureParams = {}) {
  const footerLines: string[] = [];
  if (params.kind) {
    footerLines.push(`kind: ${params.kind}`);
  }
  if (Number.isFinite(params.elapsedMs)) {
    footerLines.push(`elapsed: ${params.elapsedMs}ms`);
  }
  if (params.note) {
    footerLines.push(params.note);
  }
  return footerLines.join("\n");
}

function createStepOutputCapture(): StepOutputCapture {
  return { text: "", truncatedChars: 0 };
}

function formatCapturedStepOutput(buffer: StepOutputCapture) {
  if (buffer.truncatedChars === 0) {
    return buffer.text;
  }
  return `[output truncated ${buffer.truncatedChars} chars; showing tail]\n${buffer.text}`;
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Formats the successful boundary compile summary.
 */
export function formatBoundaryCheckSuccessSummary(params: BoundarySummaryParams = {}) {
  const lines = ["extension package boundary check passed"];
  if (params.mode) {
    lines.push(`mode: ${params.mode}`);
  }
  if (Number.isInteger(params.compileCount)) {
    lines.push(`compiled plugins: ${params.compileCount}`);
  }
  if (isPositiveInteger(params.skippedCompileCount)) {
    lines.push(`skipped plugins: ${params.skippedCompileCount}`);
  }
  if (Number.isInteger(params.canaryCount)) {
    lines.push(`canary plugins: ${params.canaryCount}`);
  }
  if (isPositiveFinite(params.prepElapsedMs)) {
    lines.push(`prep elapsed: ${params.prepElapsedMs}ms`);
  }
  if (isPositiveFinite(params.compileElapsedMs)) {
    lines.push(`compile elapsed: ${params.compileElapsedMs}ms`);
  }
  if (isPositiveFinite(params.canaryElapsedMs)) {
    lines.push(`canary elapsed: ${params.canaryElapsedMs}ms`);
  }
  if (Number.isFinite(params.elapsedMs)) {
    lines.push(`elapsed: ${params.elapsedMs}ms`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Formats skipped compile progress for fresh extension canaries.
 */
export function formatSkippedCompileProgress(params: SkippedCompileParams = {}) {
  const skippedCount = params.skippedCount ?? 0;
  const totalCount = params.totalCount ?? 0;
  if (!Number.isInteger(skippedCount) || skippedCount <= 0) {
    return "";
  }

  const staleCount = Math.max(0, totalCount - skippedCount);
  if (staleCount > 0) {
    return `skipped ${skippedCount} fresh plugin compiles before running ${staleCount} stale plugin checks\n`;
  }
  return `skipped ${skippedCount} fresh plugin compiles\n`;
}

/**
 * Formats slow extension compile diagnostics.
 */
export function formatSlowCompileSummary(params: SlowCompileParams = {}) {
  const compileTimings = Array.isArray(params.compileTimings) ? params.compileTimings : [];
  if (compileTimings.length === 0) {
    return "";
  }

  const limit = isPositiveInteger(params.limit) ? params.limit : SLOW_COMPILE_SUMMARY_LIMIT;
  const lines = ["slowest plugin compiles:"];
  for (const timing of [...compileTimings]
    .toSorted((left, right) => right.elapsedMs - left.elapsedMs)
    .slice(0, limit)) {
    lines.push(`- ${timing.extensionId}: ${timing.elapsedMs}ms`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Formats a failed boundary-check child process step.
 */
export function formatStepFailure(label: string, params: StepFailureParams = {}) {
  const stdoutSection = summarizeOutputSection("stdout", params.stdout ?? "");
  const stderrSection = summarizeOutputSection("stderr", params.stderr ?? "");
  const footer = formatFailureFooter(params);
  return [label, stdoutSection, stderrSection, footer].filter(Boolean).join("\n\n");
}

function attachStepFailureMetadata(error: Error, label: string, params: StepFailureParams = {}) {
  return Object.assign(error, {
    stepLabel: label,
    kind: params.kind ?? "unknown",
    elapsedMs: params.elapsedMs ?? null,
    fullOutput: [label, params.stdout ?? "", params.stderr ?? "", formatFailureFooter(params)]
      .filter(Boolean)
      .join("\n")
      .trim(),
  });
}

function collectBundledExtensionIds() {
  return readdirSync(join(repoRoot, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function resolveExtensionTsconfigPath(extensionId: string) {
  return join(repoRoot, "extensions", extensionId, "tsconfig.json");
}

function readExtensionTsconfig(extensionId: string) {
  const config = readJsonFile(resolveExtensionTsconfigPath(extensionId));
  return config && typeof config === "object" && "extends" in config
    ? { extends: config.extends }
    : {};
}

function collectOptInExtensionIds() {
  return collectBundledExtensionIds().filter((extensionId) => {
    const tsconfigPath = resolveExtensionTsconfigPath(extensionId);
    if (!existsSync(tsconfigPath)) {
      return false;
    }
    return readExtensionTsconfig(extensionId).extends === extensionPackageBoundaryBaseConfig;
  });
}

function collectCanaryExtensionIds(extensionIds: string[]) {
  return [
    ...new Map(
      extensionIds.map((extensionId) => [
        JSON.stringify(readExtensionTsconfig(extensionId)),
        extensionId,
      ]),
    ).values(),
  ];
}

/** One lifecycle adapter for preparation, compilers, and the negative canary. */
function abortSiblingSteps(abortController?: AbortController) {
  if (abortController && !abortController.signal.aborted) {
    abortController.abort();
  }
}

export async function runNodeStepAsync(
  label: string,
  args: string[],
  timeoutMs: number,
  params: RunNodeStepParams = {},
) {
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, MAX_TIMER_TIMEOUT_MS);
  const startedAt = Date.now();
  let stdout = createStepOutputCapture();
  let stderr = createStepOutputCapture();
  let receivedSignal: NodeJS.Signals | undefined;
  let activeChild: ChildProcess | undefined;
  try {
    const code = await runManagedCommand({
      bin: process.execPath,
      args,
      cwd: repoRoot,
      env: params.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeoutMs: resolvedTimeoutMs,
      signal: params.abortController?.signal,
      abortKillGraceMs: 0,
      requireProcessTreeExit: process.platform !== "win32",
      onSignal(signal) {
        receivedSignal = signal;
        // Boundary cancellation historically stops compiler groups immediately.
        if (activeChild) {
          terminateManagedChild(activeChild, "SIGKILL");
        }
      },
      onReady(child) {
        activeChild = child;
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        child.stdout!.on("data", (chunk) => {
          stdout = appendBoundedTail(stdout, chunk, STEP_OUTPUT_MAX_CHARS);
        });
        child.stderr!.on("data", (chunk) => {
          stderr = appendBoundedTail(stderr, chunk, STEP_OUTPUT_MAX_CHARS);
        });
      },
    });
    if (receivedSignal) {
      process.exitCode = signalExitCode(receivedSignal);
      throw new Error(`${label} interrupted by ${receivedSignal}`);
    }
    if (code !== 0) {
      throw Object.assign(new Error(`${label} failed with exit code ${code}`), {
        code: "NONZERO_EXIT",
      });
    }
    return {
      stdout: formatCapturedStepOutput(stdout),
      stderr: formatCapturedStepOutput(stderr),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const original = toErrorObject(error, "Boundary step failed");
    const code = "code" in original ? original.code : undefined;
    const kind =
      code === "ETIMEDOUT"
        ? "timeout"
        : code === "ABORT_ERR"
          ? "canceled"
          : code === "NONZERO_EXIT"
            ? "nonzero-exit"
            : code === "EPROCESSGROUP_CLEANUP_FAILED"
              ? "cleanup-error"
              : receivedSignal
                ? "signal"
                : "spawn-error";
    const detail = {
      stdout: formatCapturedStepOutput(stdout),
      stderr: formatCapturedStepOutput(stderr),
      kind,
      elapsedMs: Date.now() - startedAt,
      note:
        code === "ETIMEDOUT"
          ? `${label} timed out after ${resolvedTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
    };
    // Preserve cleanup identity and cause for the checkout ownership boundary.
    original.message = formatStepFailure(label, detail);
    const failure = attachStepFailureMetadata(original, label, detail);
    params.onFailure?.(failure);
    abortSiblingSteps(params.abortController);
    throw failure;
  }
}

/**
 * Runs boundary check steps with bounded concurrency.
 */
export async function runNodeStepsWithConcurrency(steps: BoundaryStep[], concurrency: number) {
  const abortController = new AbortController();
  let firstFailure: unknown = null;
  const failures: unknown[] = [];
  await pMap(
    steps,
    async (step) => {
      if (abortController.signal.aborted) {
        return;
      }
      try {
        step.onStart?.();
        const result = await runNodeStepAsync(step.label, step.args, step.timeoutMs, {
          env: step.env,
          abortController,
          onFailure(error) {
            firstFailure ??= error;
          },
        });
        step.onSuccess?.(result);
      } catch (error) {
        // Keep the mapper fulfilled so pMap waits for active process-group cleanup.
        firstFailure ??= error;
        failures.push(error);
        abortSiblingSteps(abortController);
      }
    },
    { concurrency, stopOnError: false },
  );
  if (firstFailure) {
    const primary = toErrorObject(firstFailure, "Non-Error thrown");
    // Retain every cleanup failure so the owner cannot release on only the
    // first compiler error while a later sibling still has unjoined work.
    throw failures.length > 1
      ? new AggregateError(failures, primary.message, { cause: primary })
      : primary;
  }
}

/**
 * Resolves canary artifact paths for an extension boundary compile.
 */
export function resolveCanaryArtifactPaths(extensionId: string, rootDir = repoRoot) {
  const extensionRoot = resolve(rootDir, "extensions", extensionId);
  return {
    extensionRoot,
    canaryPath: resolve(extensionRoot, "__rootdir_boundary_canary__.ts"),
    tsconfigPath: resolve(extensionRoot, "tsconfig.rootdir-canary.json"),
  };
}

/**
 * Removes canary artifacts for one extension.
 */
function cleanupCanaryArtifacts(extensionId: string, rootDir = repoRoot) {
  const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(extensionId, rootDir);
  rmSync(canaryPath, { force: true });
  rmSync(tsconfigPath, { force: true });
  rmSync(resolveBoundaryInputReceiptPath(`${extensionId}-canary`, rootDir), { force: true });
}

/**
 * Removes canary artifacts for multiple extensions.
 */
function cleanupCanaryArtifactsForExtensions(extensionIds: string[], rootDir = repoRoot) {
  for (const extensionId of extensionIds) {
    cleanupCanaryArtifacts(extensionId, rootDir);
  }
}

/**
 * Installs signal/exit cleanup for extension canary artifacts.
 */
export function installCanaryArtifactCleanup(
  extensionIds: string[],
  params: BoundaryCheckParams = {},
) {
  const rootDir = params.rootDir ?? repoRoot;
  const processObject = params.processObject ?? process;
  const exitHandler = () => {
    cleanupCanaryArtifactsForExtensions(extensionIds, rootDir);
  };
  processObject.on("exit", exitHandler);
  return () => {
    processObject.off("exit", exitHandler);
  };
}

function resolveBoundaryInputReceiptPath(extensionId: string, rootDir = repoRoot) {
  return resolve(rootDir, BOUNDARY_CACHE_ROOT, "compile", `${extensionId}.inputs.json`);
}
function resolveBoundaryTsStampPath(extensionId: string, rootDir = repoRoot) {
  return resolve(rootDir, BOUNDARY_CACHE_ROOT, "compile", `${extensionId}.json`);
}
async function runCompileCheck(extensionIds: string[], shard?: CompileShard) {
  const prepStartedAt = Date.now();
  process.stdout.write(
    `preparing plugin-sdk boundary artifacts for ${extensionIds.length} plugins\n`,
  );
  await runNodeStepAsync("plugin-sdk boundary prep", prepareBoundaryArtifactsArgs, 420_000);
  const prepElapsedMs = Date.now() - prepStartedAt;
  const compileStartedAt = Date.now();
  const availableParallelism = os.availableParallelism();
  const concurrency = resolveCompileConcurrency(process.env, availableParallelism);
  const cpuShare = Math.max(1, Math.floor(availableParallelism / concurrency));
  const compilerThreads = process.env.GOMAXPROCS?.trim()
    ? Math.min(cpuShare, parsePositiveInt(process.env.GOMAXPROCS.trim(), "GOMAXPROCS"))
    : cpuShare;
  const compilerEnv = { ...process.env, GOMAXPROCS: String(compilerThreads) };
  const verboseFreshLogs = process.env.OPENCLAW_EXTENSION_BOUNDARY_VERBOSE_FRESH === "1";
  const projects = prepareExtensionBoundaryProjects(repoRoot, extensionIds);
  const metadataInputs = projects.flatMap((project) => project.metadataInputs);
  const before = new BoundaryInputSnapshot(repoRoot, metadataInputs);
  process.stdout.write(
    `compile concurrency ${concurrency}; CPUs per compiler ${compilerThreads}\n`,
  );
  let skippedCompileCount = 0;
  const compileTimings: CompileTiming[] = [];
  const completed: {
    recordPath: string;
    config: string;
    args: string[];
    startedAt: number;
    inputReceipt: string;
  }[] = [];
  // Source bytes are a cold-cache scheduling hint, never a coverage selector.
  // Include the package's implementation even when its config starts at public barrels.
  const orderedExtensions = projects
    .map((project) =>
      Object.assign(project, {
        sourceBytes: collectFilesSync(join(repoRoot, "extensions", project.extensionId), {
          includeFile: (file) => classifyBundledExtensionSourcePath(file).isProductionSource,
        }).reduce((total, file) => total + statSync(file).size, 0),
      }),
    )
    .toSorted((left, right) => right.sourceBytes - left.sourceBytes);
  // Keep complete metadata and preparation above so striped and full runs share receipts.
  const selectedExtensions = orderedExtensions.filter(
    (_, index) => !shard || index % shard.count === shard.index,
  );
  if (shard) {
    process.stdout.write(
      `compile shard ${shard.index + 1}/${shard.count}: ${selectedExtensions.length} of ${extensionIds.length} plugins\n`,
    );
  }
  const steps = selectedExtensions
    .map(({ extensionId, config }, index) => {
      const inputReceipt = resolveBoundaryInputReceiptPath(extensionId);
      const args = [
        compilerWorker,
        JSON.stringify({
          configFile: config,
          inputReceipt: portableRelativePath(repoRoot, inputReceipt),
          emit: false,
        }),
      ];
      before.signature(config, args, []);
      const recordPath = resolveBoundaryTsStampPath(extensionId);
      mkdirSync(dirname(inputReceipt), { recursive: true });
      if (
        before.matches(readArtifactRecord(recordPath), config, args, [
          portableRelativePath(repoRoot, inputReceipt),
        ])
      ) {
        skippedCompileCount += 1;
        if (verboseFreshLogs) {
          process.stdout.write(
            `[${index + 1}/${selectedExtensions.length}] ${extensionId} (fresh; skipping)\n`,
          );
        }
        return null;
      }
      rmSync(recordPath, { force: true });
      rmSync(inputReceipt, { force: true });
      let startedAt = 0;
      return {
        label: extensionId,
        onStart() {
          startedAt = Date.now();
          process.stdout.write(`[${index + 1}/${selectedExtensions.length}] ${extensionId}\n`);
        },
        onSuccess(result) {
          process.stdout.write(
            `[${index + 1}/${selectedExtensions.length}] ${extensionId} (${result.elapsedMs}ms)\n`,
          );
          completed.push({ recordPath, config, args, startedAt, inputReceipt });
          compileTimings.push({
            extensionId,
            elapsedMs: result.elapsedMs,
          });
        },
        args,
        env: compilerEnv,
        timeoutMs: 120_000,
      } satisfies BoundaryStep;
    })
    .filter((step) => step !== null);
  if (!verboseFreshLogs && skippedCompileCount > 0) {
    process.stdout.write(
      formatSkippedCompileProgress({
        skippedCount: skippedCompileCount,
        totalCount: selectedExtensions.length,
      }),
    );
  }
  if (steps.length > 0) {
    await runNodeStepsWithConcurrency(steps, concurrency);
    const after = new BoundaryInputSnapshot(repoRoot, metadataInputs);
    const records = completed.map((unit) =>
      Object.assign(unit, {
        record: after.record(
          unit.config,
          unit.args,
          unit.inputReceipt,
          [portableRelativePath(repoRoot, unit.inputReceipt)],
          before,
          unit.startedAt,
        ),
      }),
    );
    for (const unit of records) {
      rmSync(unit.inputReceipt.replace(/\.inputs\.json$/u, ".tsbuildinfo"), { force: true });
      writeArtifactRecord(unit.recordPath, unit.record);
    }
  }
  return {
    prepElapsedMs,
    compileCount: steps.length,
    skippedCompileCount,
    compileElapsedMs: Date.now() - compileStartedAt,
    compileTimings,
  };
}

async function runCanaryCheck(extensionIds: string[]) {
  const startedAt = Date.now();
  const results = await Promise.allSettled(
    extensionIds.map(async (extensionId, index) => {
      const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(extensionId);

      cleanupCanaryArtifacts(extensionId);
      process.stdout.write(`[${index + 1}/${extensionIds.length}] ${extensionId} canary\n`);
      try {
        writeFileSync(
          canaryPath,
          [
            `import { ROOTDIR_BOUNDARY_CANARY } from "${ROOTDIR_BOUNDARY_CANARY_IMPORT_PATH}";`,
            "void ROOTDIR_BOUNDARY_CANARY;",
            "export {};",
            "",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          tsconfigPath,
          `${JSON.stringify(
            {
              extends: "./tsconfig.json",
              include: ["./__rootdir_boundary_canary__.ts"],
              exclude: [],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        const result = await runNodeStepAsync(
          `${extensionId} canary`,
          [
            compilerWorker,
            JSON.stringify({
              configFile: tsconfigPath,
              inputReceipt: resolveBoundaryInputReceiptPath(`${extensionId}-canary`),
              emit: false,
            }),
          ],
          120_000,
        );
        throw new Error(
          `${extensionId} canary unexpectedly passed\n${result.stdout}${result.stderr}`,
        );
      } catch (error) {
        const output =
          error instanceof Error && "fullOutput" in error && typeof error.fullOutput === "string"
            ? error.fullOutput
            : String(error);
        if (
          !(error instanceof Error) ||
          !("kind" in error) ||
          error.kind !== "nonzero-exit" ||
          !output.includes("TS6059") ||
          !output.includes(ROOTDIR_BOUNDARY_CANARY_OUTPUT_HINT)
        ) {
          throw error;
        }
      } finally {
        cleanupCanaryArtifacts(extensionId);
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "extension boundary canary failed");
  }
  return {
    canaryElapsedMs: Date.now() - startedAt,
  };
}

/**
 * Runs the extension package TypeScript boundary check.
 */
async function runBoundaryCheck(argv: string[]) {
  const startedAt = Date.now();
  const mode = parseMode(argv);
  const shard = parseCompileShard(argv, mode);
  const optInExtensionIds = collectOptInExtensionIds();
  const canaryExtensionIds = collectCanaryExtensionIds(optInExtensionIds);
  const cleanupExtensionIds = optInExtensionIds;
  const shouldRunCanary = mode === "all" || mode === "canary";
  const teardownCanaryCleanup = installCanaryArtifactCleanup(cleanupExtensionIds);
  let prepElapsedMs: number | undefined;
  let compileCount = 0;
  let skippedCompileCount = 0;
  let compileElapsedMs: number | undefined;
  let compileTimings: CompileTiming[] = [];
  let canaryElapsedMs: number | undefined;

  try {
    cleanupCanaryArtifactsForExtensions(cleanupExtensionIds);
    if (mode === "all" || mode === "compile") {
      ({ prepElapsedMs, compileCount, skippedCompileCount, compileElapsedMs, compileTimings } =
        await runCompileCheck(optInExtensionIds, shard));
    }
    if (shouldRunCanary) {
      ({ canaryElapsedMs } = await runCanaryCheck(canaryExtensionIds));
    }
    process.stdout.write(
      formatBoundaryCheckSuccessSummary({
        mode,
        compileCount,
        skippedCompileCount,
        canaryCount: shouldRunCanary ? canaryExtensionIds.length : 0,
        prepElapsedMs,
        compileElapsedMs,
        canaryElapsedMs,
        elapsedMs: Date.now() - startedAt,
      }),
    );
    process.stdout.write(
      formatSlowCompileSummary({
        compileTimings,
      }),
    );
  } finally {
    teardownCanaryCleanup?.();
    cleanupCanaryArtifactsForExtensions(cleanupExtensionIds);
  }
}

export async function main(argv: string[] = process.argv.slice(2)) {
  return withDistArtifactOwnership(repoRoot, () => runBoundaryCheck(argv));
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
