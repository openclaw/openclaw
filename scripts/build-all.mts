#!/usr/bin/env node
// Builds OpenClaw packages and plugin SDK artifacts with cache-aware orchestration.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveNodeRuntimeExecutable } from "../src/infra/node-runtime-executable.ts";
import {
  finalizeBuildStepCache,
  resolveBuildStepCacheState,
  restoreBuildStepCacheOutputs,
  type BuildCacheStep,
} from "./lib/build-artifact-cache.mts";
import { readCurrentGitCommit, resolveBuildIdentityEnvironment } from "./lib/build-identity.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import { formatDurationElapsed } from "./lib/format-duration.mts";
import { resolveLiveManagedGatewayDistFence } from "./lib/live-gateway-dist-fence.mts";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "./lib/local-build-metadata.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import type { MemoryLimitParams } from "./lib/process-memory.mts";
import { resolveRunNodeInputSignature } from "./lib/run-node-input-state.mts";
import { preflightInstalledSourceArtifacts } from "./lib/source-update-artifact-preflight.mts";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
} from "./lib/tsdown-config-groups.mts";
import {
  TSDOWN_PACKAGE_OUTPUT_ROOTS,
  tsdownPackageOutputRoot,
} from "./lib/tsdown-output-roots.mts";
import {
  TSDOWN_MAX_OLD_SPACE_MB_ENV,
  TSDOWN_DECLARATION_EXTENSIONS,
  TSDOWN_DECLARATION_TOOL_INPUTS,
  TSDOWN_PACKAGES_CACHE_INPUT,
  listTsdownOutputRoots,
  resolveTsdownBuildPlan,
} from "./tsdown-build.mts";

const nodeBin = resolveNodeRuntimeExecutable() ?? process.execPath;

export type BuildAllStep = BuildCacheStep & { args: string[] };

type BuildAllTiming = { label: string; durationMs: number; status: string };

export type BuildAllResult = {
  exitCode: number;
  timings: BuildAllTiming[];
  admissionRefused?: true;
};
type BuildAllStepParams = {
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  deferIsolatedAssets?: boolean;
};
const RUN_NODE_SKIP_DTS_BUILD_ENV = "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD";
const TSDOWN_AI_OUTPUT_ROOT = tsdownPackageOutputRoot("ai");
const TSDOWN_MAIN_PACKAGE_OUTPUT_ROOTS = TSDOWN_PACKAGE_OUTPUT_ROOTS.filter(
  (root) => root !== TSDOWN_AI_OUTPUT_ROOT,
);
const tsxScript = (script: string, ...args: string[]) => ["--import", "tsx", script, ...args];
const nodeStep = (label: string, args: string[]): BuildAllStep => ({
  label,
  args,
});
const tsxStep = (label: string, script: string, ...args: string[]) =>
  nodeStep(label, tsxScript(script, ...args));
const declarationStep = (
  label: string,
  config: string,
  roots: string[],
  ...args: string[]
): BuildAllStep => ({
  ...tsxStep(label, "scripts/tsdown-build.mts", "--config", config, ...args),
  cache: {
    inputs: [...TSDOWN_DECLARATION_TOOL_INPUTS, config, TSDOWN_PACKAGES_CACHE_INPUT],
    outputs: roots.map((root) => ({ path: root, extensions: TSDOWN_DECLARATION_EXTENSIONS })),
    restore: "always",
    runOnHit: { env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" } },
  },
});
const pluginAssetStep = (phase: "build" | "copy") =>
  nodeStep(`plugins:assets:${phase}`, [
    "--import",
    "./scripts/tsx.mjs",
    "scripts/bundled-plugin-assets.mts",
    "--phase",
    phase,
  ]);
export const BUILD_ALL_STEPS: BuildAllStep[] = [
  nodeStep("native-protocol", ["scripts/prepare-native-protocol.mjs"]),
  nodeStep("clean:dist", [
    "-e",
    'require("node:fs").rmSync("dist", { recursive: true, force: true })',
  ]),
  pluginAssetStep("build"),
  tsxStep("tsdown", "scripts/tsdown-build.mts"),
  declarationStep("tsdown-ai", "tsdown.ai.config.ts", [TSDOWN_AI_OUTPUT_ROOT]),
  declarationStep(
    "tsdown-packages",
    "tsdown.config.ts",
    TSDOWN_MAIN_PACKAGE_OUTPUT_ROOTS,
    "--filter",
    TSDOWN_PACKAGE_CONFIG_GROUP,
  ),
  {
    ...tsxStep(
      "tsdown-unified",
      "scripts/tsdown-build.mts",
      "--config",
      "tsdown.config.ts",
      "--filter",
      TSDOWN_UNIFIED_CONFIG_GROUP,
      // Limit overlapping Rolldown native allocations, which Node's heap limit
      // does not cap. Individual bundles retain their internal parallelism.
      "--concurrency",
      "1",
    ),
    env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
  },
  {
    ...tsxStep("write-unified-entry-dts", "scripts/write-unified-entry-dts.ts"),
    env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
  },
  tsxStep("external-plugins:local-dist", "scripts/build-external-plugin-local-dist.mts"),
  tsxStep("check-cli-bootstrap-imports", "scripts/check-cli-bootstrap-imports.mts"),
  pluginAssetStep("copy"),
  tsxStep("runtime-postbuild", "scripts/runtime-postbuild.mts"),
  tsxStep("build-stamp", "scripts/build-stamp.mts"),
  tsxStep("runtime-postbuild-stamp", "scripts/runtime-postbuild-stamp.mts"),
  {
    ...tsxStep("write-plugin-sdk-entry-dts", "scripts/write-plugin-sdk-entry-dts.ts"),
    env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
  },
  tsxStep("check-plugin-sdk-exports", "scripts/check-plugin-sdk-exports.mts"),
  {
    ...nodeStep("ui:build", ["scripts/ui.js", "build"]),
    // No build-all cache: ui/vite.config.ts derives the Control UI build ID
    // from package.json, git HEAD, and OPENCLAW_CONTROL_UI_BUILD_ID env, so a
    // file-input signature cannot exactly invalidate generated assets and a
    // warm hit could restore stale service-worker/app cache metadata.
    cache: undefined,
  },
  tsxStep("write-build-info", "scripts/write-build-info.ts"),
  {
    ...tsxStep("write-cli-startup-metadata", "scripts/write-cli-startup-metadata.ts"),
    cache: {
      inputs: [
        "scripts/write-cli-startup-metadata.ts",
        "scripts/lib/cli-startup-root-help-bundle.ts",
      ],
      outputs: ["dist/cli-startup-metadata.json"],
      restore: "always",
      runOnHit: { finalize: "refresh" },
    },
  },
];

const RUNTIME_SETUP_STEP_LABELS = [
  "external-plugins:local-dist",
  "check-cli-bootstrap-imports",
] as const;
const RUNTIME_FINALIZE_STEP_LABELS = [
  "runtime-postbuild",
  "build-stamp",
  "runtime-postbuild-stamp",
] as const;
const RUNTIME_STEP_LABELS = [...RUNTIME_SETUP_STEP_LABELS, ...RUNTIME_FINALIZE_STEP_LABELS];
const ASSET_RUNTIME_STEP_LABELS = [
  "plugins:assets:build",
  "tsdown",
  ...RUNTIME_SETUP_STEP_LABELS,
  // Copy after compiler cleanup, before postbuild records the generated asset inventory.
  "plugins:assets:copy",
  ...RUNTIME_FINALIZE_STEP_LABELS,
];
const BUILD_METADATA_STEP_LABELS = ["write-build-info", "write-cli-startup-metadata"] as const;
const FINAL_BUILD_ARTIFACTS_STEP_LABELS = [
  "check-plugin-sdk-exports",
  "ui:build",
  ...BUILD_METADATA_STEP_LABELS,
] as const;
const CI_ARTIFACT_STEP_LABELS = [
  "native-protocol",
  ...ASSET_RUNTIME_STEP_LABELS,
  "write-plugin-sdk-entry-dts",
  ...FINAL_BUILD_ARTIFACTS_STEP_LABELS,
];
// Isolated plugins finish generating source assets before declarations capture
// their resolution namespace, so the first build seals reusable cache inputs.
const FULL_RUNTIME_STEP_LABELS = ASSET_RUNTIME_STEP_LABELS.flatMap((step) =>
  step === "tsdown"
    ? ["tsdown-ai", "tsdown-packages", "tsdown-unified"]
    : step === "external-plugins:local-dist"
      ? [step, "write-unified-entry-dts"]
      : [step],
);
const FULL_BUILD_STEP_LABELS = [
  "native-protocol",
  ...FULL_RUNTIME_STEP_LABELS,
  ...FINAL_BUILD_ARTIFACTS_STEP_LABELS,
];

const BUILD_ALL_PROFILES: Record<string, string[]> = {
  full: [...FULL_BUILD_STEP_LABELS],
  package: ["clean:dist", ...FULL_BUILD_STEP_LABELS],
  ciArtifacts: [...CI_ARTIFACT_STEP_LABELS],
  // Smoke builds retain typed compilation and publication checks without the UI/metadata tail.
  strictSmoke: [...FULL_RUNTIME_STEP_LABELS, "check-plugin-sdk-exports"],
  pluginSdkStrictSmoke: [
    ...FULL_RUNTIME_STEP_LABELS.filter((step) => !step.startsWith("plugins:assets:")),
    "check-plugin-sdk-exports",
  ],
  gatewayWatch: ["tsdown", ...RUNTIME_STEP_LABELS],
  qaRuntime: [...ASSET_RUNTIME_STEP_LABELS],
  sourcePerformance: [...ASSET_RUNTIME_STEP_LABELS, "write-build-info"],
  cliStartup: ["tsdown", ...RUNTIME_STEP_LABELS, "write-cli-startup-metadata"],
};

const FULL_RUNTIME_ONLY_STEPS = [
  "native-protocol",
  ...ASSET_RUNTIME_STEP_LABELS,
  "ui:build",
  ...BUILD_METADATA_STEP_LABELS,
];

const FULL_BUILD_PROFILE_STEP_ENV = {
  tsdown: {
    OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
  },
  "tsdown-unified": {
    OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
  },
};
const BUILD_ALL_PROFILE_STEP_ENV: Record<string, Record<string, NodeJS.ProcessEnv>> = {
  full: FULL_BUILD_PROFILE_STEP_ENV,
  package: FULL_BUILD_PROFILE_STEP_ENV,
  ciArtifacts: {
    tsdown: {
      // Global declaration emission is ~95% of the tsdown wall clock and PR
      // CI's dist consumers are runtime JS only; the plugin-sdk gate below
      // stages the canonical SDK-only declaration graph instead. Release/package builds
      // (full profile, docker packaging) keep canonical dts.
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
  },
  gatewayWatch: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    },
    "runtime-postbuild": {
      OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
    },
  },
  qaRuntime: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    },
  },
  sourcePerformance: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    },
  },
  cliStartup: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
    "runtime-postbuild": {
      OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
    },
  },
};

function buildAllUsage() {
  return [
    "Usage: node --import tsx scripts/build-all.mts [profile]",
    "",
    "Builds OpenClaw artifacts for the selected profile.",
    "",
    "Profiles:",
    ...Object.keys(BUILD_ALL_PROFILES).map((profile) => `  ${profile}`),
    "",
    "Options:",
    "  -h, --help  Show this help.",
  ].join("\n");
}

export function parseBuildAllArgs(argv: string[]) {
  const args = {
    help: false,
    profile: "full",
  };
  let sawProfile = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown argument: ${arg}\n\n${buildAllUsage()}`);
    } else if (sawProfile) {
      throw new Error(`unexpected argument: ${arg}\n\n${buildAllUsage()}`);
    } else {
      args.profile = arg;
      sawProfile = true;
    }
  }
  if (!args.help && !BUILD_ALL_PROFILES[args.profile]) {
    throw new Error(`Unknown build profile: ${args.profile}\n\n${buildAllUsage()}`);
  }
  return args;
}

export function resolveBuildAllSteps(
  profile = "full",
  buildEnv: NodeJS.ProcessEnv = process.env,
): BuildAllStep[] {
  const profileLabels = BUILD_ALL_PROFILES[profile];
  if (!profileLabels) {
    throw new Error(`Unknown build profile: ${profile}`);
  }
  // A cold runtime-only build has no declarations for the canonical SDK gates.
  // Its uncached graph cannot seed the declaration-only caches used by full builds.
  const runtimeOnly = buildEnv[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1";
  const labels =
    profile === "full" && runtimeOnly
      ? FULL_RUNTIME_ONLY_STEPS
      : profile === "package" && runtimeOnly
        ? ["clean:dist", ...FULL_RUNTIME_ONLY_STEPS]
        : profileLabels;
  const selected = labels.map((label) => BUILD_ALL_STEPS.find((step) => step.label === label));
  if (selected.some((step) => !step)) {
    const missing = labels.filter((label) => !BUILD_ALL_STEPS.some((step) => step.label === label));
    throw new Error(`Build profile ${profile} references unknown steps: ${missing.join(", ")}`);
  }
  const envOverrides = BUILD_ALL_PROFILE_STEP_ENV[profile] ?? {};
  return selected
    .filter((step): step is NonNullable<typeof step> => step !== undefined)
    .map((step) => {
      const env = envOverrides[step.label];
      if (!env) {
        return step;
      }
      const mergedEnv = Object.assign({}, "env" in step ? step.env : undefined, env);
      // Source-run rebuilds share qaRuntime but retain the caller's explicit
      // declaration choice. The other partial profiles remain runtime-only.
      if (profile === "qaRuntime" && step.label === "tsdown") {
        mergedEnv[RUN_NODE_SKIP_DTS_BUILD_ENV] =
          buildEnv[RUN_NODE_SKIP_DTS_BUILD_ENV] ?? mergedEnv[RUN_NODE_SKIP_DTS_BUILD_ENV];
      }
      const merged: BuildAllStep = Object.assign({}, step, { env: mergedEnv });
      return merged;
    });
}

/** Pin one source identity for every child process that contributes to this build. */
export function resolveBuildAllEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  readGitCommit: () => string | null = readCurrentGitCommit,
) {
  const buildEnv = resolveBuildIdentityEnvironment({
    commitLabel: "build commit",
    env,
    now,
    readGitCommit,
  });
  // Older installed updaters already send this marker to candidate builds.
  // Updates need runtime artifacts; explicit declaration/package builds still win.
  if (buildEnv.OPENCLAW_UPDATE_IN_PROGRESS === "1") {
    buildEnv[RUN_NODE_SKIP_DTS_BUILD_ENV] ??= "1";
    // Published updaters can still pass the serving checkout's source root.
    // Rebind before plugin asset hooks resolve SDK aliases in this candidate.
    buildEnv.OPENCLAW_DEV_SOURCE_ROOT = process.cwd();
  }
  return buildEnv;
}

function resolveBuildAllTsdownPlan(
  profile: string,
  env: NodeJS.ProcessEnv,
  params: Omit<MemoryLimitParams, "env"> = {},
): {
  env: NodeJS.ProcessEnv;
  heapShortfall: ReturnType<typeof resolveTsdownBuildPlan>["heapShortfall"];
} {
  if (
    !["full", "package", "ciArtifacts", "strictSmoke", "pluginSdkStrictSmoke"].includes(profile)
  ) {
    return { env, heapShortfall: null };
  }
  const plan = resolveTsdownBuildPlan({ ...params, env });
  return {
    // Direct Node steps need NODE_OPTIONS; tsdown descendants also need the frozen budget.
    env: { ...plan.env, [TSDOWN_MAX_OLD_SPACE_MB_ENV]: String(plan.maxOldSpaceMb) },
    heapShortfall: plan.heapShortfall,
  };
}

export function resolveBuildAllStep(step: BuildAllStep, params: BuildAllStepParams = {}) {
  const env = step.env
    ? Object.assign({}, params.env ?? process.env, step.env)
    : (params.env ?? process.env);
  const assetArgs =
    params.deferIsolatedAssets && step.label === "plugins:assets:build" ? ["--defer-isolated"] : [];
  return {
    command: params.nodeExecPath ?? nodeBin,
    args: [...step.args, ...assetArgs],
    options: {
      stdio: "inherit",
      env,
      // Managed commands default to a Windows shell; Node needs literal argv,
      // including percent-encoded file URLs passed to --import.
      shell: false,
    } satisfies SpawnSyncOptions,
  };
}

function resolveBuildAllStepOnCacheHit(step: BuildAllStep) {
  if (!step.cache?.runOnHit) {
    return null;
  }
  return {
    ...step,
    env: Object.assign({}, step.env, step.cache.runOnHit.env),
  };
}

export function formatBuildAllDuration(durationMs: number) {
  const clampedMs = Math.max(0, durationMs);
  const roundedMs =
    clampedMs < 1000
      ? Math.round(clampedMs)
      : clampedMs < 10_000
        ? Math.round(clampedMs / 10) * 10
        : Math.round(clampedMs / 100) * 100;
  return formatDurationElapsed(roundedMs, {
    secondsDecimalDigits: clampedMs < 10_000 ? 2 : 1,
  });
}

export function formatBuildAllTimingSummary(timings: BuildAllTiming[]) {
  if (timings.length === 0) {
    return "[build-all] phase timings: no phases ran";
  }
  const totalMs = timings.reduce((sum, timing) => sum + timing.durationMs, 0);
  const phases = timings
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .map((timing) => {
      const status = timing.status === "ran" ? "" : ` (${timing.status})`;
      return `${timing.label}${status} ${formatBuildAllDuration(timing.durationMs)}`;
    })
    .join("; ");
  return `[build-all] phase timings: total ${formatBuildAllDuration(totalMs)}; slowest ${phases}`;
}

export async function runBuildAllSteps(
  profile: string,
  params: {
    cacheEnabled?: boolean;
    signal?: AbortSignal;
    requireVerifiedGatewayFence?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    finalizeCache?: typeof finalizeBuildStepCache;
    logger?: Pick<Console, "error" | "warn">;
    memoryLimit?: Omit<MemoryLimitParams, "env">;
    now?: () => number;
    resolveCacheState?: typeof resolveBuildStepCacheState;
    restoreCache?: typeof restoreBuildStepCacheOutputs;
    runStep?: (
      invocation: ReturnType<typeof resolveBuildAllStep>,
    ) => { status: number | null } | Promise<{ status: number | null }>;
    steps?: BuildAllStep[];
  } = {},
): Promise<BuildAllResult> {
  params.signal?.throwIfAborted();
  await preflightInstalledSourceArtifacts(params.env ?? process.env);
  params.signal?.throwIfAborted();
  const { env: buildEnv, heapShortfall } = resolveBuildAllTsdownPlan(
    profile,
    resolveBuildAllEnvironment(params.env),
    params.memoryLimit,
  );
  const steps = params.steps ?? resolveBuildAllSteps(profile, buildEnv);
  const deferIsolatedAssets = steps.some((step) => step.label === "external-plugins:local-dist");
  const cacheEnabled = params.cacheEnabled ?? buildEnv.OPENCLAW_BUILD_CACHE !== "0";
  const logger = params.logger ?? console;
  // One owner for both `pnpm build` and run-node dirty-tree auto-build: both
  // enter here before clean:dist can delete hashed modules a live Gateway still imports.
  const fence = await resolveLiveManagedGatewayDistFence(params.cwd ?? process.cwd(), {
    env: buildEnv,
    requireVerified: params.requireVerifiedGatewayFence,
    outputPaths: listTsdownOutputRoots(),
  });
  params.signal?.throwIfAborted();
  if (fence.refuse) {
    logger.error(fence.message);
    return {
      exitCode: 1,
      timings: [] satisfies BuildAllTiming[],
      admissionRefused: true,
    };
  }
  const now = params.now ?? performance.now.bind(performance);
  const resolveCacheState = params.resolveCacheState ?? resolveBuildStepCacheState;
  const restoreCache = params.restoreCache ?? restoreBuildStepCacheOutputs;
  const finalizeCache = params.finalizeCache ?? finalizeBuildStepCache;
  const cwd = params.cwd ?? process.cwd();
  const inputDeps = { cwd, distRoot: path.join(cwd, "dist"), fs, env: buildEnv, spawnSync };
  const capturesNativeInputs =
    !params.runStep && steps.some((step) => step.label.endsWith("build-stamp"));
  const hasAssetBuild =
    capturesNativeInputs && steps.some((step) => step.label === "plugins:assets:build");
  let buildInputSignature =
    capturesNativeInputs && !hasAssetBuild && steps.some((step) => step.label === "build-stamp")
      ? resolveRunNodeInputSignature(inputDeps, "build")
      : null;
  const runtimeEnv = {
    ...buildEnv,
    ...steps.find((step) => step.label === "runtime-postbuild")?.env,
  };
  let runtimeInputSignature =
    capturesNativeInputs &&
    !hasAssetBuild &&
    steps.some((step) => step.label === "runtime-postbuild-stamp")
      ? resolveRunNodeInputSignature({ ...inputDeps, env: runtimeEnv }, "runtime")
      : null;
  let stampsInvalidated = false;
  const invalidateInputStamps = () => {
    // Injected steps own their fixture writes; native writers share this lifecycle.
    if (
      stampsInvalidated ||
      params.runStep ||
      !steps.some((step) => step.label.endsWith("build-stamp"))
    ) {
      return;
    }
    for (const name of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
      fs.rmSync(path.join(cwd, "dist", name), { force: true });
    }
    stampsInvalidated = true;
  };
  const runStep =
    params.runStep ??
    (async (invocation: ReturnType<typeof resolveBuildAllStep>) => {
      const script = invocation.args[2];
      if (
        script === "scripts/build-stamp.mts" ||
        script === "scripts/runtime-postbuild-stamp.mts"
      ) {
        const buildStamp = script === "scripts/build-stamp.mts";
        (buildStamp ? writeBuildStamp : writeRuntimePostBuildStamp)({
          cwd,
          env: buildStamp ? buildEnv : runtimeEnv,
          inputSignature: buildStamp ? buildInputSignature : runtimeInputSignature,
        });
        return { status: 0 };
      }
      return {
        status: await runManagedCommand({
          bin: invocation.command,
          args:
            script === "scripts/tsdown-build.mts" ||
            script === "scripts/write-unified-entry-dts.ts" ||
            script === "scripts/write-plugin-sdk-entry-dts.ts" ||
            script === "scripts/runtime-postbuild.mts"
              ? distArtifactEntryArgs(script, invocation.args.slice(3))
              : invocation.args,
          ...invocation.options,
          signal: params.signal,
          requireProcessTreeExit: process.platform !== "win32",
        }),
      };
    });
  const timings: BuildAllTiming[] = [];
  let exitCode = 0;
  if (heapShortfall) {
    if (heapShortfall.fatal) {
      logger.error(heapShortfall.message);
      return { exitCode: 1, timings };
    }
    logger.warn(heapShortfall.message);
  }
  for (const step of steps) {
    params.signal?.throwIfAborted();
    const cacheStartedAt = now();
    const cacheState = resolveCacheState(step, { env: buildEnv });
    const cacheDurationMs = now() - cacheStartedAt;
    const startedAt = now();
    let stepToRun = step;
    let reusedCache = false;
    if (cacheEnabled && cacheState.fresh) {
      if (cacheState.restorable) {
        invalidateInputStamps();
        if (!restoreCache(cacheState)) {
          throw new Error(`Build cache changed before restoration: ${step.label}; rerun the build`);
        }
      }
      const cacheHitStep = resolveBuildAllStepOnCacheHit(step);
      if (!cacheHitStep) {
        const durationMs = cacheDurationMs + now() - startedAt;
        timings.push({ label: step.label, status: "cached", durationMs });
        logger.error(`[build-all] ${step.label} (cached) ${formatBuildAllDuration(durationMs)}`);
        continue;
      }
      reusedCache = true;
      stepToRun = cacheHitStep;
    }
    logger.error(`[build-all] ${step.label}${reusedCache ? " (cache restored)" : ""}`);
    const invocation = resolveBuildAllStep(stepToRun, { env: buildEnv, deferIsolatedAssets });
    invalidateInputStamps();
    const result = await runStep(invocation);
    params.signal?.throwIfAborted();
    const durationMs = cacheDurationMs + now() - startedAt;
    if (result.status !== 0) {
      timings.push({ label: step.label, status: "failed", durationMs });
      logger.error(`[build-all] ${step.label} failed after ${formatBuildAllDuration(durationMs)}`);
      exitCode = typeof result.status === "number" ? result.status : 1;
      break;
    }
    if (step.label === "plugins:assets:build" && !params.runStep) {
      buildInputSignature = resolveRunNodeInputSignature(inputDeps, "build");
      runtimeInputSignature = resolveRunNodeInputSignature(
        { ...inputDeps, env: runtimeEnv },
        "runtime",
      );
    }
    // Runtime-only tsdown cleans its output roots. Cache hits restore
    // declarations again after that pass so the full build stays complete.
    if (!finalizeCache(step, cacheState, { env: buildEnv, reusedCache })) {
      throw new Error(`Build cache changed during ${step.label}; rerun the build`);
    }
    timings.push({ label: step.label, status: reusedCache ? "reused" : "ran", durationMs });
    logger.error(`[build-all] ${step.label} done in ${formatBuildAllDuration(durationMs)}`);
  }
  logger.error(formatBuildAllTimingSummary(timings));
  return { exitCode, timings };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  let args;
  try {
    args = parseBuildAllArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (args?.help) {
    console.log(buildAllUsage());
  } else if (args) {
    const { runLegacySourceUpdateBuild } = await import("./lib/source-update-build.mts");
    const legacyExit = await runLegacySourceUpdateBuild(args.profile, (env) =>
      runBuildAllSteps(args.profile, { env }),
    );
    const exitCode =
      legacyExit ??
      (await withDistArtifactOwnership(process.cwd(), () => runBuildAllSteps(args.profile)))
        .exitCode;
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  }
}
