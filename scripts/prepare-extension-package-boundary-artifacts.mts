// Local declaration ownership is disjoint from packaged tsdown declarations.
import fs from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "../packages/normalization-core/src/number-coercion.ts";
import {
  listCacheFiles,
  portableRelativePath,
  readArtifactRecord,
  writeArtifactRecord,
} from "./lib/build-artifact-cache.mts";
import { runCancelableCommand } from "./lib/cancelable-command.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import {
  BOUNDARY_CACHE_ROOT,
  BOUNDARY_PLUGIN_UNITS,
  LOCAL_PLUGIN_ROOT,
  LOCAL_SDK_ROOT,
  BoundaryInputSnapshot,
} from "./lib/extension-boundary-inputs.mts";
import {
  applyLocalTsgoPolicy,
  ensureRepoNodeModulesLink,
  isLocalCheckEnabled,
  resolveLocalCheckEnv,
} from "./lib/local-check-runtime.mts";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { pluginSdkEntrypoints } from "./lib/plugin-sdk-entries.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { runSemanticCheck } from "./lib/semantic-check-admission.mts";
import { resolveTsgoTimeoutMs } from "./run-tsgo.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const compilerWorker = path.join(repoRoot, "scripts/compile-extension-boundary.mts");
const DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS = 1_000;
type NodeStepParams = {
  signal?: AbortSignal;
  semantic?: boolean;
  bin?: string;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
  abortController?: AbortController;
  abortKillGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => boolean;
};
type NodeStep = Omit<NodeStepParams, "abortController"> & {
  args: string[];
  label: string;
  timeoutMs: number;
};
export function parseMode(argv: string[] = process.argv.slice(2)) {
  const mode = argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ?? "all";
  if (mode !== "all" && mode !== "package-boundary") {
    throw new Error(`Unknown mode: ${mode}`);
  }
  return mode;
}
export function resolveBoundaryRootShimsTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS?.trim();
  return raw
    ? parsePositiveInt(raw, "OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS")
    : 300_000;
}
/**
 * Prefixes streamed child output line-by-line without breaking partial chunks.
 */
export function createPrefixedOutputWriter(
  label: string,
  target: { write(chunk: string): boolean | void },
  onLine?: (line: string) => boolean,
) {
  let buffered = "";
  const prefix = `[${label}] `;

  return {
    write(chunk: string) {
      let ready = true;
      buffered += chunk;
      while (true) {
        const newlineIndex = buffered.indexOf("\n");
        if (newlineIndex === -1) {
          if (Buffer.byteLength(buffered) > 64 * 1024) {
            buffered = "";
            throw new Error(`${label} output line exceeded 64 KiB`);
          }
          return ready;
        }
        const line = buffered.slice(0, newlineIndex + 1);
        if (Buffer.byteLength(line) > 64 * 1024) {
          buffered = "";
          throw new Error(`${label} output line exceeded 64 KiB`);
        }
        buffered = buffered.slice(newlineIndex + 1);
        if (onLine?.(line) !== false) {
          ready = target.write(`${prefix}${line}`) !== false && ready;
        }
      }
    },
    flush() {
      if (!buffered) {
        return;
      }
      target.write(`${prefix}${buffered}`);
      buffered = "";
    },
  };
}

/** Runs a declaration step through the shared managed lifecycle with prefixed output. */
export async function runNodeStep(
  label: string,
  args: string[],
  timeoutMs: number,
  params: NodeStepParams = {},
) {
  params.signal?.throwIfAborted();
  if (params.abortController?.signal.aborted) {
    throw new Error(`${label} canceled before starting`);
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, MAX_TIMER_TIMEOUT_MS);
  let receivedSignal: NodeJS.Signals | undefined;
  const outputAbort = new AbortController();
  const outputListeners = new Set<() => void>();
  const stdoutWriter = createPrefixedOutputWriter(label, process.stdout, params.onStdoutLine);
  const stderrWriter = createPrefixedOutputWriter(label, process.stderr);
  const command = (params.semantic ? runSemanticCheck : runManagedCommand)({
    bin: params.bin ?? process.execPath,
    args,
    cwd: repoRoot,
    env: params.env ? { ...process.env, ...params.env } : process.env,
    shell: params.shell ?? false,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
    stdio: ["ignore", "pipe", "pipe"],
    // Artifact writers must finish before stamps, dependent readers, or lock release.
    requireProcessTreeExit: process.platform !== "win32",
    timeoutMs: resolvedTimeoutMs,
    signal: AbortSignal.any([
      outputAbort.signal,
      ...[params.signal, params.abortController?.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    ]),
    abortKillGraceMs: Math.max(
      0,
      Math.floor(params.abortKillGraceMs ?? DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS),
    ),
    onSignal(signal) {
      receivedSignal ??= signal;
    },
    onReady(child) {
      // This invocation explicitly requests both output pipes above.
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      for (const [stream, writer, target] of [
        [child.stdout!, stdoutWriter, process.stdout],
        [child.stderr!, stderrWriter, process.stderr],
      ] as const) {
        stream.on("data", (chunk: string) => {
          if (!outputAbort.signal.aborted) {
            try {
              if (!writer.write(chunk)) {
                stream.pause();
                const remove = () => {
                  target.off("drain", resume);
                };
                const resume = () => {
                  outputListeners.delete(remove);
                  stream.resume();
                };
                target.once("drain", resume);
                outputListeners.add(remove);
              }
            } catch (error) {
              outputAbort.abort(error);
            }
          }
        });
      }
    },
  });
  const failures: unknown[] = [];
  try {
    const code = await command;
    if (receivedSignal) {
      throw new DOMException(`${label} interrupted by ${receivedSignal}`, "AbortError");
    }
    params.signal?.throwIfAborted();
    outputAbort.signal.throwIfAborted();
    if (code !== 0) {
      throw new Error(`${label} failed with exit code ${code}`);
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const failure =
      code === "ABORT_ERR" && outputAbort.signal.aborted
        ? outputAbort.signal.reason
        : code === "ETIMEDOUT"
          ? new Error(`${label} timed out after ${resolvedTimeoutMs}ms`, { cause: error })
          : code === "ABORT_ERR"
            ? Object.assign(new Error(`${label} canceled`, { cause: error }), { code: "ABORT_ERR" })
            : error;
    if (params.abortController && !params.abortController.signal.aborted) {
      params.abortController.abort(failure);
    }
    failures.push(failure);
  } finally {
    for (const remove of outputListeners) {
      remove();
    }
    // Output failure must not hide an unjoined compiler from artifact ownership.
    for (const writer of [stdoutWriter, stderrWriter]) {
      try {
        writer.flush();
      } catch (error) {
        failures.push(error);
        params.abortController?.abort(error);
      }
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${label} failed while draining output`);
  }
  if (failures.length) {
    throw failures[0];
  }
}

/**
 * Runs independent artifact steps together and aborts siblings on first failure.
 */
export async function runNodeStepsInParallel(steps: NodeStep[]) {
  // Compiler work owns the host admission slot; do not retain sibling compiler
  // state and output while another step is active.
  if (steps.some((step) => step.semantic)) {
    await runNodeSteps(steps);
    return;
  }
  const abortController = new AbortController();
  const results = await Promise.allSettled(
    steps.map((step) =>
      runNodeStep(step.label, step.args, step.timeoutMs, {
        ...step,
        abortController,
      }),
    ),
  );
  const failures: unknown[] = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    const primary = abortController.signal.reason ?? failures[0];
    const cleanupFailures = failures.filter(
      (error: unknown) => hasUnjoinedWork(error) && error !== primary,
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primary, ...cleanupFailures],
        `${primary instanceof Error ? primary.message : String(primary)}; sibling cleanup could not be verified`,
      );
    }
    throw primary;
  }
}

/**
 * Serialize compiler steps everywhere; generic steps retain the local policy.
 */
export async function runNodeSteps(steps: NodeStep[], env: NodeJS.ProcessEnv = process.env) {
  if (!steps.some((step) => step.semantic) && !isLocalCheckEnabled(env)) {
    await runNodeStepsInParallel(steps);
    return;
  }

  for (const step of steps) {
    await runNodeStep(step.label, step.args, step.timeoutMs, step);
  }
}

export async function prepareExtensionPackageBoundaryArtifacts(
  argv: string[] = process.argv.slice(2),
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const mode = parseMode(argv);
  const { env: compilerEnv } = applyLocalTsgoPolicy([], resolveLocalCheckEnv(runtimeEnv), {
    logicalCpuCount: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
  });
  const compilerTimeoutMs = resolveTsgoTimeoutMs(compilerEnv);
  const sdk = {
    id: "plugin-sdk",
    outDir: LOCAL_SDK_ROOT,
    config: "packages/plugin-sdk/tsconfig.json",
    rootDir: ".",
    required: pluginSdkEntrypoints.map((entry) => `${LOCAL_SDK_ROOT}/src/plugin-sdk/${entry}.d.ts`),
  };
  const plugins = BOUNDARY_PLUGIN_UNITS.map(([id, entry]) => ({
    id,
    outDir: `${LOCAL_PLUGIN_ROOT}/${id}`,
    config: `extensions/${id}/tsconfig.json`,
    rootDir: `extensions/${id}`,
    required: [`${LOCAL_PLUGIN_ROOT}/${id}/${entry}.d.ts`],
  }));
  const batches = [[sdk], mode === "all" ? plugins : []].map((batch) =>
    batch.map((unit) => {
      fs.mkdirSync(resolve(repoRoot, unit.outDir), { recursive: true });
      if (unit.id !== "plugin-sdk") {
        // Relocated declarations still resolve third-party types through their package owner.
        ensureRepoNodeModulesLink(resolve(repoRoot, unit.rootDir, "node_modules"), {
          cwd: resolve(repoRoot, unit.outDir),
        });
      }
      return { ...unit, outputRoot: fs.realpathSync.native(resolve(repoRoot, unit.outDir)) };
    }),
  );
  for (const batch of batches) {
    signal?.throwIfAborted();
    if (!batch.length) {
      continue;
    }
    // Upstream pruning changes consumer topology; snapshot after the preceding batch's cleanup.
    const before = new BoundaryInputSnapshot(repoRoot);
    const pending = batch
      .map((unit) => {
        const recordPath = resolve(repoRoot, BOUNDARY_CACHE_ROOT, `${unit.id}.json`);
        const inputReceipt = `${unit.outDir}/.inputs.json`;
        const args = [
          compilerWorker,
          JSON.stringify({
            configFile: unit.config,
            inputReceipt,
            compilerOptions: {
              outDir: unit.outDir,
              rootDir: unit.rootDir,
              declarationMap: false,
            },
            emit: true,
          }),
        ];
        const previous = readArtifactRecord(recordPath);
        // Prime config/toolchain/topology before starting even an uncached owner.
        before.signature(unit.config, args, [], unit.outputRoot);
        if (
          before.matches(
            previous,
            unit.config,
            args,
            [...unit.required, inputReceipt],
            unit.outputRoot,
          )
        ) {
          process.stdout.write(`[${unit.id} boundary dts] fresh; skipping\n`);
          return null;
        }
        fs.rmSync(recordPath, { force: true });
        // Historical Matrix/Slack repair: every stale owner gets a full native emit.
        // Output directories stay intact until a successful complete inventory exists.
        fs.rmSync(resolve(repoRoot, inputReceipt), { force: true });
        const outputs = new Set<string>();
        return Object.assign(unit, { recordPath, inputReceipt, args, outputs, startedAt: 0 });
      })
      .filter((unit) => unit !== null);
    await runNodeSteps(
      pending.map((unit) => {
        unit.startedAt = Date.now();
        return {
          label: `${unit.id} boundary dts`,
          semantic: true,
          signal,
          args: unit.args,
          env: compilerEnv,
          timeoutMs: Math.min(
            unit.id === "plugin-sdk" ? resolveBoundaryRootShimsTimeoutMs(compilerEnv) : 300_000,
            compilerTimeoutMs ?? Number.POSITIVE_INFINITY,
          ),
          onStdoutLine(line: string) {
            if (!line.startsWith("TSFILE: ")) {
              return true;
            }
            unit.outputs.add(portableRelativePath(repoRoot, line.slice(8).trim()));
            return false;
          },
        };
      }),
      compilerEnv,
    );
    signal?.throwIfAborted();
    if (!pending.length) {
      continue;
    }
    const after = new BoundaryInputSnapshot(repoRoot);
    // Join and validate every owner before publishing any success in this batch.
    const completed = pending.map((unit) => {
      const outputs = [...unit.outputs].toSorted();
      if (
        [...unit.required, unit.inputReceipt].some((file) => !unit.outputs.has(file)) ||
        outputs.some((file) => !file.startsWith(`${unit.outDir}/`))
      ) {
        throw new Error(`Incomplete ${unit.id} native declaration inventory`);
      }
      const record = after.record(
        unit.config,
        unit.args,
        unit.inputReceipt,
        outputs,
        before,
        unit.startedAt,
        unit.outputRoot,
      );
      return Object.assign(unit, { record });
    });
    for (const unit of completed) {
      // Surviving files are cleanup candidates, never evidence of successful emit.
      for (const file of listCacheFiles(
        repoRoot,
        [{ path: unit.outDir, extensions: [".d.ts", ".d.mts", ".d.cts"] }],
        fs,
      )) {
        if (!unit.outputs.has(portableRelativePath(repoRoot, file))) {
          fs.rmSync(file);
        }
      }
      fs.rmSync(resolve(repoRoot, unit.outDir, ".tsbuildinfo"), { force: true });
      writeArtifactRecord(unit.recordPath, unit.record);
      process.stdout.write(`[${unit.id} boundary dts] emitted ${unit.outputs.size} files\n`);
    }
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  // Keep the CLI alive through compiler extinction and asynchronous lock release.
  try {
    process.exitCode = await runCancelableCommand((signal) =>
      withDistArtifactOwnership(
        repoRoot,
        async () => {
          await prepareExtensionPackageBoundaryArtifacts(
            process.argv.slice(2),
            process.env,
            signal,
          );
          return 0;
        },
        signal,
      ),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  if (process.exitCode) {
    console.error(`[boundary-prep] FAILED (exit ${process.exitCode})`);
  }
}
