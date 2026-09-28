#!/usr/bin/env node

// Verifies extension packages compile through their package-local TypeScript boundary.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { isCommandCancellation, runCancelableCommand } from "./lib/cancelable-command.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { toErrorObject } from "./lib/error-format.mts";
import { BOUNDARY_CACHE_ROOT, BoundaryInputSnapshot } from "./lib/extension-boundary-inputs.mts";
import { prepareExtensionBoundaryProjects } from "./lib/extension-boundary-projects.mts";
import { classifyBundledExtensionSourcePath } from "./lib/extension-source-classifier.mts";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { hasUnjoinedWork } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { runSemanticCheck } from "./lib/semantic-check-admission.mts";
import { prepareExtensionPackageBoundaryArtifacts } from "./prepare-extension-package-boundary-artifacts.mts";

type BoundaryMode = "all" | "compile" | "canary";
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
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};
type BoundaryStep = {
  label: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onStart?: () => void;
  onSuccess?: (result: StepResult) => void;
};
const repoRoot = resolveRepoRoot(import.meta.url);
const compilerWorker = resolve(repoRoot, "scripts/compile-extension-boundary.mts");
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
  try {
    const code = await runSemanticCheck({
      bin: process.execPath,
      args,
      cwd: repoRoot,
      env: params.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeoutMs: resolvedTimeoutMs,
      signal: params.signal,
      requireProcessTreeExit: true,
      onSignal(signal) {
        receivedSignal = signal;
      },
      onReady(child) {
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
      throw Object.assign(new Error(`${label} interrupted by ${receivedSignal}`), {
        code: "ABORT_ERR",
      });
    }
    params.signal?.throwIfAborted();
    if (code !== 0) {
      throw Object.assign(new Error(`${label} failed with exit code ${code}`), {
        code: "NONZERO_EXIT",
        exitCode: code,
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
        : isCommandCancellation(original)
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
    // DOMException.message can be an inherited getter after queued cancellation.
    Object.defineProperty(original, "message", {
      value: formatStepFailure(label, detail),
      configurable: true,
      writable: true,
    });
    const failure = attachStepFailureMetadata(original, label, detail);
    throw failure;
  }
}

/** One compiler owns admission until its whole process tree has joined. */
export async function runNodeSteps(steps: BoundaryStep[], signal?: AbortSignal) {
  for (const step of steps) {
    signal?.throwIfAborted();
    step.onStart?.();
    const result = await runNodeStepAsync(step.label, step.args, step.timeoutMs, {
      env: step.env,
      signal,
    });
    signal?.throwIfAborted();
    step.onSuccess?.(result);
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

function resolveBoundaryInputReceiptPath(extensionId: string, rootDir = repoRoot) {
  return resolve(rootDir, BOUNDARY_CACHE_ROOT, "compile", `${extensionId}.inputs.json`);
}
function resolveBoundaryTsStampPath(extensionId: string, rootDir = repoRoot) {
  return resolve(rootDir, BOUNDARY_CACHE_ROOT, "compile", `${extensionId}.json`);
}
async function runCompileCheck(extensionIds: string[], signal: AbortSignal) {
  const prepStartedAt = Date.now();
  process.stdout.write(
    `preparing plugin-sdk boundary artifacts for ${extensionIds.length} plugins\n`,
  );
  // One deadline covers preparation and admission; no outer timer kills its
  // owner before the compiler and asynchronous locks have been joined.
  await prepareExtensionPackageBoundaryArtifacts(
    [],
    process.env,
    AbortSignal.any([signal, AbortSignal.timeout(420_000)]),
  );
  signal.throwIfAborted();
  const prepElapsedMs = Date.now() - prepStartedAt;
  const compileStartedAt = Date.now();
  const verboseFreshLogs = process.env.OPENCLAW_EXTENSION_BOUNDARY_VERBOSE_FRESH === "1";
  const projects = prepareExtensionBoundaryProjects(repoRoot, extensionIds);
  const metadataInputs = projects.flatMap((project) => project.metadataInputs);
  const before = new BoundaryInputSnapshot(repoRoot, metadataInputs);
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
  const steps = orderedExtensions
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
            `[${index + 1}/${extensionIds.length}] ${extensionId} (fresh; skipping)\n`,
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
          process.stdout.write(`[${index + 1}/${extensionIds.length}] ${extensionId}\n`);
        },
        onSuccess(result) {
          process.stdout.write(
            `[${index + 1}/${extensionIds.length}] ${extensionId} (${result.elapsedMs}ms)\n`,
          );
          completed.push({ recordPath, config, args, startedAt, inputReceipt });
          compileTimings.push({
            extensionId,
            elapsedMs: result.elapsedMs,
          });
        },
        args,
        env: process.env,
        timeoutMs: 120_000,
      } satisfies BoundaryStep;
    })
    .filter((step) => step !== null);
  if (!verboseFreshLogs && skippedCompileCount > 0) {
    process.stdout.write(
      formatSkippedCompileProgress({
        skippedCount: skippedCompileCount,
        totalCount: extensionIds.length,
      }),
    );
  }
  if (steps.length > 0) {
    await runNodeSteps(steps, signal);
    signal.throwIfAborted();
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

async function runCanaryCheck(extensionIds: string[], signal: AbortSignal) {
  const startedAt = Date.now();
  for (const [index, extensionId] of extensionIds.entries()) {
    signal.throwIfAborted();
    const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(extensionId);

    cleanupCanaryArtifacts(extensionId);
    process.stdout.write(`[${index + 1}/${extensionIds.length}] ${extensionId} canary\n`);
    let joined = true;
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
        { signal },
      );
      throw new Error(
        `${extensionId} canary unexpectedly passed\n${result.stdout}${result.stderr}`,
      );
    } catch (error) {
      joined = !hasUnjoinedWork(error);
      const output =
        error instanceof Error && "fullOutput" in error && typeof error.fullOutput === "string"
          ? error.fullOutput
          : String(error);
      if (
        !joined ||
        !(error instanceof Error) ||
        !("kind" in error) ||
        error.kind !== "nonzero-exit" ||
        !("exitCode" in error) ||
        error.exitCode !== 1 ||
        !output.includes("TS6059") ||
        !output.includes(ROOTDIR_BOUNDARY_CANARY_OUTPUT_HINT)
      ) {
        throw error;
      }
    } finally {
      // A surviving compiler may still read these inputs; retain them with its owner.
      if (joined) cleanupCanaryArtifacts(extensionId);
    }
  }
  return {
    canaryElapsedMs: Date.now() - startedAt,
  };
}

/**
 * Runs the extension package TypeScript boundary check.
 */
async function runBoundaryCheck(argv: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const startedAt = Date.now();
  const mode = parseMode(argv);
  const optInExtensionIds = collectOptInExtensionIds();
  const canaryExtensionIds = collectCanaryExtensionIds(optInExtensionIds);
  const cleanupExtensionIds = optInExtensionIds;
  const shouldRunCanary = mode === "all" || mode === "canary";
  let prepElapsedMs: number | undefined;
  let compileCount = 0;
  let skippedCompileCount = 0;
  let compileElapsedMs: number | undefined;
  let compileTimings: CompileTiming[] = [];
  let canaryElapsedMs: number | undefined;

  cleanupCanaryArtifactsForExtensions(cleanupExtensionIds);
  if (mode === "all" || mode === "compile") {
    ({ prepElapsedMs, compileCount, skippedCompileCount, compileElapsedMs, compileTimings } =
      await runCompileCheck(optInExtensionIds, signal));
  }
  if (shouldRunCanary) {
    signal.throwIfAborted();
    ({ canaryElapsedMs } = await runCanaryCheck(canaryExtensionIds, signal));
  }
  signal.throwIfAborted();
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
}

export async function main(argv: string[] = process.argv.slice(2)) {
  return runCancelableCommand((signal) =>
    withDistArtifactOwnership(
      repoRoot,
      async () => {
        await runBoundaryCheck(argv, signal);
        return 0;
      },
      signal,
    ),
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runWithFailedTrailer("package-boundary", async () => {
    process.exitCode = await main();
  });
}
