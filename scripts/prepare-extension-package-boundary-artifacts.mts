// Local declaration ownership is disjoint from packaged tsdown declarations.
import fs from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "../packages/normalization-core/src/number-coercion.ts";
import { ensureKyselyTypes } from "./generate-kysely-types.mts";
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
  boundaryPreparationArgs,
  sdkBoundaryUnit,
} from "./lib/extension-boundary-inputs.mts";
import type { resolveExtensionBoundaryPreparation } from "./lib/extension-boundary-projects.mts";
import {
  applyLocalTsgoPolicy,
  ensureRepoNodeModulesLink,
  isConstrainedCiCheckHost,
  isLocalCheckEnabled,
  resolveCheckMemoryCapacityBytes,
  resolveLocalCheckEnv,
} from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { readProcessMemoryCapacity } from "./lib/process-memory.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { resolveTsgoTimeoutMs } from "./run-tsgo.mts";
// Native compiler output uses long Windows paths even when Node entered through an 8.3 alias.
const repoRoot = fs.realpathSync.native(resolveRepoRoot(import.meta.url));
const DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS = 1_000;
type NodeStepParams = {
  bin?: string;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
  abortController?: AbortController;
  signal?: AbortSignal;
  abortKillGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => boolean;
};
type NodeStep = Omit<NodeStepParams, "abortController"> & {
  args: string[];
  label: string;
  timeoutMs: number;
};
let nodeStepParentSignal: NodeJS.Signals | undefined;
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
  target: { write(chunk: string): void },
  onLine?: (line: string) => boolean,
) {
  let buffered = "";
  const prefix = `[${label}] `;

  return {
    write(chunk: string) {
      buffered += chunk;
      while (true) {
        const newlineIndex = buffered.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const line = buffered.slice(0, newlineIndex + 1);
        buffered = buffered.slice(newlineIndex + 1);
        if (onLine?.(line) !== false) {
          target.write(`${prefix}${line}`);
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
  if (params.abortController?.signal.aborted || nodeStepParentSignal) {
    throw new Error(`${label} canceled before starting`);
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, MAX_TIMER_TIMEOUT_MS);
  const stdoutWriter = createPrefixedOutputWriter(label, process.stdout, params.onStdoutLine);
  const stderrWriter = createPrefixedOutputWriter(label, process.stderr);
  const command = runManagedCommand({
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
    signal:
      params.signal && params.abortController
        ? AbortSignal.any([params.signal, params.abortController.signal])
        : (params.signal ?? params.abortController?.signal),
    abortKillGraceMs: Math.max(
      0,
      Math.floor(params.abortKillGraceMs ?? DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS),
    ),
    onSignal(signal) {
      nodeStepParentSignal ??= signal;
    },
    onReady(child) {
      // This invocation explicitly requests both output pipes above.
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => stdoutWriter.write(chunk));
      child.stderr!.on("data", (chunk: string) => stderrWriter.write(chunk));
    },
  });
  try {
    const code = await command;
    params.signal?.throwIfAborted();
    if (nodeStepParentSignal) {
      throw new DOMException(`${label} canceled after parent signal`, "AbortError");
    }
    if (code !== 0) {
      throw new Error(`${label} failed with exit code ${code}`);
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const failure =
      code === "ETIMEDOUT"
        ? new Error(`${label} timed out after ${resolvedTimeoutMs}ms`, { cause: error })
        : code === "ABORT_ERR"
          ? Object.assign(new Error(`${label} canceled after sibling failure`, { cause: error }), {
              code: "ABORT_ERR",
            })
          : error;
    if (params.abortController && !params.abortController.signal.aborted) {
      params.abortController.abort(failure);
    }
    throw failure;
  } finally {
    stdoutWriter.flush();
    stderrWriter.flush();
    // Let the caller join sibling steps and release artifact ownership before exiting.
    // A leaf process.exit() bypasses both that release and the inherited child claim.
  }
}

/**
 * Runs independent artifact steps together and aborts siblings on first failure.
 */
export async function runNodeStepsInParallel(steps: NodeStep[]) {
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
      (error: unknown) =>
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPROCESSGROUP_CLEANUP_FAILED" &&
        error !== primary,
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

type DeclarationHost = Parameters<typeof isConstrainedCiCheckHost>[0];

function readDeclarationHost(): DeclarationHost {
  return {
    logicalCpuCount: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    memoryCapacityBytes: readProcessMemoryCapacity({}).capacityBytes,
  };
}

function ownsCiHost(env: NodeJS.ProcessEnv) {
  return (
    (env.CI === "true" || env.GITHUB_ACTIONS === "true") &&
    !env.OPENCLAW_LOCAL_CHECK?.trim() &&
    !env.OPENCLAW_LOCAL_CHECK_MODE?.trim()
  );
}

function canPairCiDeclarations(env: NodeJS.ProcessEnv, host = readDeclarationHost()) {
  return process.platform === "linux" && ownsCiHost(env) && !isConstrainedCiCheckHost(host);
}

/** Sizes the native compiler's Go runtime for how many declaration owners share the host. */
export function resolveDeclarationCompilerEnv(
  env: NodeJS.ProcessEnv,
  host: DeclarationHost = readDeclarationHost(),
) {
  const paired = canPairCiDeclarations(env, host);
  const memoryCapacityBytes = resolveCheckMemoryCapacityBytes(host);
  let policyEnv = paired ? { ...env, OPENCLAW_LOCAL_CHECK: "0" } : env;
  if (ownsCiHost(env) && isConstrainedCiCheckHost(host) && memoryCapacityBytes > 0) {
    // Owners run one at a time here. Laptop GC limits held the 13k-file SDK to
    // 220s instead of 135s on 4 CPUs/15 GiB (peak RSS 5.5 vs 8.2 GB).
    policyEnv = {
      ...env,
      GOMAXPROCS: env.GOMAXPROCS?.trim() || String(host.logicalCpuCount),
      GOGC: env.GOGC?.trim() || "100",
      GOMEMLIMIT:
        env.GOMEMLIMIT?.trim() || `${Math.floor((memoryCapacityBytes * 0.75) / 1024 ** 2)}MiB`,
    };
  }
  const { env: compilerEnv } = applyLocalTsgoPolicy([], policyEnv, {
    logicalCpuCount: host.logicalCpuCount,
    totalMemoryBytes: host.totalMemoryBytes,
  });
  if (paired) {
    // Two children share at least eight CPUs and 24 GiB; avoid laptop GC limits.
    compilerEnv.GOMAXPROCS = String(
      Math.min(4, parsePositiveInt(env.GOMAXPROCS?.trim() || "4", "GOMAXPROCS")),
    );
    compilerEnv.GOMEMLIMIT ||= "8GiB";
  }
  return compilerEnv;
}

/**
 * Keeps local checks serial and admits bounded declaration pairs on roomy Linux CI.
 */
export async function runNodeSteps(steps: NodeStep[], env: NodeJS.ProcessEnv = process.env) {
  if (!isLocalCheckEnabled(env)) {
    await runNodeStepsInParallel(steps);
    return;
  }

  const concurrency = canPairCiDeclarations(env) ? 2 : 1;
  for (let offset = 0; offset < steps.length; offset += concurrency) {
    await runNodeStepsInParallel(steps.slice(offset, offset + concurrency));
  }
}

async function prepareExtensionPackageBoundaryArtifacts(argv: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const mode = parseMode(argv);
  await ensureKyselyTypes(repoRoot);
  signal.throwIfAborted();
  const selectedArgument = argv.find((arg) => arg.startsWith("--extensions="));
  let selected: string[] | undefined;
  let discoverPreparation: typeof resolveExtensionBoundaryPreparation | undefined;
  let preparation: Awaited<ReturnType<typeof resolveExtensionBoundaryPreparation>> | undefined;
  if (selectedArgument) {
    const requested: unknown = JSON.parse(selectedArgument.slice("--extensions=".length));
    if (
      mode !== "all" ||
      !Array.isArray(requested) ||
      requested.length === 0 ||
      !requested.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(id))
    ) {
      throw new Error("Invalid selected extension preparation request");
    }
    selected = requested;
    ({ resolveExtensionBoundaryPreparation: discoverPreparation } =
      await import("./lib/extension-boundary-projects.mts"));
    signal.throwIfAborted();
    preparation = await discoverPreparation(repoRoot, selected);
    signal.throwIfAborted();
    process.stdout.write(
      `selected preparation: ${preparation.sdkRoots.length} SDK roots; plugin producers: ${preparation.pluginIds.join(", ") || "none"}\n`,
    );
  }
  const compilerEnv = resolveDeclarationCompilerEnv(resolveLocalCheckEnv(process.env));
  const compilerTimeoutMs = resolveTsgoTimeoutMs(compilerEnv);
  const sharedSdk = process.env.OPENCLAW_CI_SHARED_SDK === "1";
  const sdk = sdkBoundaryUnit(sharedSdk ? undefined : preparation?.sdkRoots);
  const plugins = BOUNDARY_PLUGIN_UNITS.map(([id, entry]) => ({
    id,
    outDir: `${LOCAL_PLUGIN_ROOT}/${id}`,
    config: `extensions/${id}/tsconfig.json`,
    rootDir: `extensions/${id}`,
    roots: undefined,
    required: [`${LOCAL_PLUGIN_ROOT}/${id}/${entry}.d.ts`],
  }));
  const batches = [[sdk], mode === "all" ? plugins : []].map((batch) =>
    batch.map((unit) => {
      const outputDir = resolve(repoRoot, unit.outDir);
      fs.mkdirSync(outputDir, { recursive: true });
      if (unit.id !== "plugin-sdk") {
        const modulesDir = resolve(repoRoot, unit.rootDir, "node_modules");
        const dependencyLink = resolve(outputDir, "node_modules");
        // Copied generated trees must not retain another checkout's dependency scope.
        if (
          fs.lstatSync(dependencyLink, { throwIfNoEntry: false })?.isSymbolicLink() &&
          resolve(outputDir, fs.readlinkSync(dependencyLink)) !== modulesDir
        ) {
          fs.unlinkSync(dependencyLink);
        }
        // Relocated declarations still resolve third-party types through their package owner.
        ensureRepoNodeModulesLink(modulesDir, { cwd: outputDir });
      }
      return { ...unit, outputRoot: fs.realpathSync.native(outputDir) };
    }),
  );
  const prepareBatch = async (batch: (typeof batches)[number]) => {
    signal.throwIfAborted();
    if (!batch.length) {
      return;
    }
    // Upstream pruning changes consumer topology; snapshot after the preceding batch's cleanup.
    const before = new BoundaryInputSnapshot(repoRoot);
    const pending = batch
      .map((unit) => {
        const recordPath = resolve(repoRoot, BOUNDARY_CACHE_ROOT, `${unit.id}.json`);
        const inputReceipt = `${unit.outDir}/.inputs.json`;
        const args = boundaryPreparationArgs(repoRoot, unit);
        const previous = readArtifactRecord(recordPath);
        // Prime config/toolchain/topology before starting even an uncached owner.
        before.signature(unit.config, args, [], unit.outputRoot);
        if (
          // A valid full receipt can cover a narrower request; the reverse never applies.
          [
            args,
            ...(unit.roots
              ? [boundaryPreparationArgs(repoRoot, { ...unit, roots: undefined })]
              : []),
          ].some((receiptArgs) =>
            before.matchesReceipt(
              previous,
              unit.config,
              receiptArgs,
              [...unit.required, inputReceipt],
              inputReceipt,
              unit.outputRoot,
            ),
          )
        ) {
          process.stdout.write(`[${unit.id} boundary dts] fresh; skipping\n`);
          return null;
        }
        fs.rmSync(recordPath, { force: true });
        // Every stale owner emits its complete requested graph, never surviving cache files.
        // Output directories stay intact until a successful complete inventory exists.
        fs.rmSync(resolve(repoRoot, inputReceipt), { force: true });
        const outputs = new Set<string>();
        return Object.assign(unit, { recordPath, inputReceipt, args, outputs });
      })
      .filter((unit) => unit !== null);
    await runNodeSteps(
      pending.map((unit) => {
        return {
          label: `${unit.id} boundary dts`,
          args: unit.args,
          env: compilerEnv,
          signal,
          timeoutMs: Math.min(
            unit.id === "plugin-sdk" ? resolveBoundaryRootShimsTimeoutMs() : 300_000,
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
    );
    // Cancellation in an async gap must not admit compilers or publish receipts.
    signal.throwIfAborted();
    if (!pending.length) {
      return;
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
  };
  if (!preparation) {
    for (const batch of batches) {
      await prepareBatch(batch);
    }
    return;
  }
  const sdkUnit = batches[0]![0]!;
  while (true) {
    await prepareBatch([sdkUnit]);
    // Only admitted SDK output may reveal declaration-only producer edges. Expand
    // their SDK inputs before compiling any producer or selected package.
    const discovered = await discoverPreparation!(repoRoot, selected!, {
      preparedSdk: true,
    });
    signal.throwIfAborted();
    if (sharedSdk) {
      if (discovered.sdkRoots.length) {
        throw new Error(
          `Full SDK preparation is missing inputs: ${discovered.sdkRoots.join(", ")}`,
        );
      }
      for (const id of discovered.pluginIds) {
        await prepareBatch(batches[1]!.filter((unit) => unit.id === id));
      }
      break;
    }
    const roots = [...new Set([...sdkUnit.roots!, ...discovered.sdkRoots])].toSorted();
    if (roots.length !== sdkUnit.roots!.length) {
      sdkUnit.roots = roots;
      sdkUnit.required = roots.map(
        (source) => `${LOCAL_SDK_ROOT}/${source.replace(/\.([cm]?)tsx?$/u, ".d.$1ts")}`,
      );
      continue;
    }
    for (const id of discovered.pluginIds) {
      await prepareBatch(batches[1]!.filter((unit) => unit.id === id));
    }
    break;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  // The private entry must observe cleanup metadata before releasing its claim.
  process.exitCode = await runCancelableCommand(async (signal) => {
    await withDistArtifactOwnership(
      repoRoot,
      () => prepareExtensionPackageBoundaryArtifacts(process.argv.slice(2), signal),
      signal,
    );
    return 0;
  });
}
