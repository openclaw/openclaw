// The installer runs this checkout's admission check before installing its dependencies.
import { isDirectRunUrl } from "./direct-run.mjs";
import { parsePositiveInt } from "./numeric-options.mjs";
import { readProcessMemoryCapacity, type MemoryLimitParams } from "./process-memory.mts";
import {
  DEFAULT_TSDOWN_MAX_OLD_SPACE_MB,
  TSDOWN_MAX_OLD_SPACE_MB_ENV,
} from "./tsdown-heap-budget.mts";

const DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB = 8192;
const DOCKER_TSDOWN_MAX_OLD_SPACE_MB_ENV = "OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB";
const TSDOWN_CGROUP_MEMORY_HEADROOM_MB = 768;

type TsdownMemoryBudget = {
  maxOldSpaceMb: number;
  unresolvedCgroupMemory: boolean;
  capacityBytes: number | null;
};
export type ResolvedMemoryLimitParams = MemoryLimitParams & {
  resolvedMemoryBudget?: TsdownMemoryBudget;
};

function readHeapOverride(env: NodeJS.ProcessEnv) {
  const value = env[TSDOWN_MAX_OLD_SPACE_MB_ENV]?.trim();
  return value ? parsePositiveInt(value, TSDOWN_MAX_OLD_SPACE_MB_ENV) : null;
}

export function resolveTsdownMemoryBudget(
  params: ResolvedMemoryLimitParams = {},
): TsdownMemoryBudget {
  if (params.resolvedMemoryBudget) {
    return params.resolvedMemoryBudget;
  }
  const defaultMaxOldSpaceMb =
    (params.platform ?? process.platform) === "win32"
      ? DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB
      : DEFAULT_TSDOWN_MAX_OLD_SPACE_MB;
  const envOverride = readHeapOverride(params.env ?? process.env);
  const { limitBytes, unresolved, capacityBytes } = readProcessMemoryCapacity(params);
  if (envOverride !== null) {
    return { maxOldSpaceMb: envOverride, unresolvedCgroupMemory: false, capacityBytes };
  }
  if (unresolved) {
    return { maxOldSpaceMb: 1, unresolvedCgroupMemory: true, capacityBytes };
  }
  if (limitBytes === null) {
    return { maxOldSpaceMb: defaultMaxOldSpaceMb, unresolvedCgroupMemory: false, capacityBytes };
  }

  const limitMb = Math.floor(limitBytes / 1024 / 1024);
  // Never exceed the budget just discovered: a floor applied on top of a real limit produces
  // a heap the cgroup cannot honour, which is an OOM kill rather than a smaller build.
  const cgroupCap = Math.max(1, limitMb - TSDOWN_CGROUP_MEMORY_HEADROOM_MB);
  return {
    maxOldSpaceMb: Math.min(defaultMaxOldSpaceMb, cgroupCap),
    unresolvedCgroupMemory: false,
    capacityBytes,
  };
}

/**
 * Measured against this repo's former eleven-invocation build inside real cgroups.
 * The current four-invocation build retains the runtime graph that sets this floor:
 * a 5GiB slice resolves this heap, completes, and peaks at 4730MiB. A 4GiB slice (3328MB heap)
 * and a 2816MiB slice (2048MB heap) are both killed in the third, unified-runtime invocation,
 * which also runs when declarations are disabled. Roughly 380MiB of the peak is rolldown, a
 * native addon which --max-old-space-size does not govern at all.
 */
const MEASURED_MIN_TSDOWN_HEAP_MB = 4352;

/**
 * Describes a host that cannot fit the build, or null when it can. Reported before any
 * output is cleaned: a host that cannot rebuild must not also lose the build it already
 * has. Fatal by default because continuing either aborts partway through the invocation
 * list or, when the heap outruns a container limit, thrashes at the ceiling instead of
 * failing, which starves every other process on the machine.
 */
export function describeInsufficientTsdownHeap(
  params: ResolvedMemoryLimitParams = {},
  budget = resolveTsdownMemoryBudget(params),
) {
  const { maxOldSpaceMb } = budget;
  if (maxOldSpaceMb >= MEASURED_MIN_TSDOWN_HEAP_MB) {
    return null;
  }
  const env = params.env ?? process.env;
  const explicitHeapMb = readHeapOverride(env);
  const heapOverrideEnv = Object.hasOwn(env, "OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS")
    ? DOCKER_TSDOWN_MAX_OLD_SPACE_MB_ENV
    : TSDOWN_MAX_OLD_SPACE_MB_ENV;
  const fatal = explicitHeapMb === null;
  const outcome = fatal
    ? [
        "Stopping before any build output is removed. Pick one:",
        budget.unresolvedCgroupMemory
          ? "  - run the build where the process cgroup limit is visible"
          : "  - give this machine or container more memory",
        `  - set ${heapOverrideEnv}=<MB> to explicitly attempt the build anyway`,
      ]
    : [
        `Continuing because ${heapOverrideEnv} explicitly requests ${explicitHeapMb}MB. Existing build output will now be cleaned; the build may stall or fail.`,
      ];
  return {
    fatal,
    message: [
      budget.unresolvedCgroupMemory
        ? "[tsdown-build] The process memory limit is not visible through this cgroup mount namespace, so OpenClaw cannot choose a safe default heap."
        : `[tsdown-build] The resolved OpenClaw build heap is ${maxOldSpaceMb}MB, ` +
          `and a full build needs ${MEASURED_MIN_TSDOWN_HEAP_MB}MB of Node heap. ` +
          "Runtime bundling alone has peaked near 4.7GB including native allocations. Other build stages can require more memory.",
      ...outcome,
    ].join("\n"),
  };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const shortfall = describeInsufficientTsdownHeap();
  if (shortfall?.fatal) {
    console.error(shortfall.message);
    console.error("  - use the default npm installation to skip building from source");
    process.exitCode = 1;
  }
}
