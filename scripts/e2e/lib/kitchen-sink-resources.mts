import {
  measureGatewayCpuUsage,
  type GatewayResourceSnapshot,
} from "../../lib/gateway-bench-profile.ts";

const MEMORY_FIELDS = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"] as const;

function memoryDifference(before: NodeJS.MemoryUsage, after: NodeJS.MemoryUsage) {
  return Object.fromEntries(MEMORY_FIELDS.map((field) => [field, after[field] - before[field]]));
}

function resourceDifference(before: Record<string, number>, after: Record<string, number>) {
  for (const sample of [before, after]) {
    if (
      !sample ||
      Object.values(sample).some((count) => !Number.isSafeInteger(count) || count < 0)
    ) {
      throw new Error("Gateway resource sample has invalid active-resource counts");
    }
  }
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .toSorted()
      .map((type) => [type, (after[type] ?? 0) - (before[type] ?? 0)]),
  );
}

export type KitchenSinkResourcePhase = {
  name: string;
  status: "exercised" | "failed";
  operations: { attempted: number; completed: number; failed: number };
  before: GatewayResourceSnapshot;
  after: GatewayResourceSnapshot | null;
  cpu: ReturnType<typeof measureGatewayCpuUsage> | null;
  memoryChangeBytes: ReturnType<typeof memoryDifference> | null;
  activeResourceChanges: Record<string, number> | null;
  processCpuMsPerCompletedOperation: number | null;
  breakdown?: KitchenSinkResourcePhase[];
  error?: string;
};

export function summarizeResourcePhase(
  name: string,
  before: GatewayResourceSnapshot,
  after: GatewayResourceSnapshot,
  operations: KitchenSinkResourcePhase["operations"],
  error?: string,
): KitchenSinkResourcePhase {
  const cpu = measureGatewayCpuUsage(before, after);
  for (const sample of [before, after]) {
    for (const field of MEMORY_FIELDS) {
      if (!Number.isFinite(sample.memory[field]) || sample.memory[field] < 0) {
        throw new Error(`Gateway resource sample has invalid ${field}`);
      }
    }
  }
  return {
    name,
    status: error ? "failed" : "exercised",
    operations,
    before,
    after,
    cpu,
    memoryChangeBytes: memoryDifference(before.memory, after.memory),
    activeResourceChanges: resourceDifference(before.activeResources, after.activeResources),
    processCpuMsPerCompletedOperation:
      operations.failed === 0 && operations.completed > 0
        ? cpu.process.totalMs / operations.completed
        : null,
    ...(error ? { error } : {}),
  };
}

async function sampleResourcePhase(
  name: string,
  before: GatewayResourceSnapshot,
  sample: () => Promise<GatewayResourceSnapshot>,
  operations: KitchenSinkResourcePhase["operations"],
  error?: string,
): Promise<KitchenSinkResourcePhase> {
  try {
    return summarizeResourcePhase(name, before, await sample(), operations, error);
  } catch (cause) {
    // Losing a measurement must not lose the receipt for already completed work.
    return {
      name,
      status: "failed",
      before,
      after: null,
      cpu: null,
      memoryChangeBytes: null,
      activeResourceChanges: null,
      processCpuMsPerCompletedOperation: null,
      operations,
      error: [error, `Resource sample failed: ${String(cause)}`]
        .filter(Boolean)
        .join("; ")
        .slice(0, 2_048),
    };
  }
}

/** Count only responses whose caller-owned result assertions completed. No retries. */
export async function measureResourceOperations(options: {
  name: string;
  count: number;
  sample: () => Promise<GatewayResourceSnapshot>;
  run: (index: number) => Promise<void>;
  splitFirst?: boolean;
}): Promise<KitchenSinkResourcePhase> {
  const before = await options.sample();
  const operations = { attempted: 0, completed: 0, failed: 0 };
  const breakdown: KitchenSinkResourcePhase[] = [];
  let midpoint: GatewayResourceSnapshot | undefined;
  let error: string | undefined;
  for (let index = 0; index < options.count; index++) {
    operations.attempted++;
    try {
      await options.run(index);
      operations.completed++;
    } catch (cause) {
      operations.failed++;
      error = String(cause instanceof Error ? cause.message : cause).slice(0, 2_048);
      break;
    }
    if (options.splitFirst && index === 0 && options.count > 1) {
      // Observe outside the operation catch: a lost sample cannot fail an already asserted call.
      const first = await sampleResourcePhase(`${options.name}-first`, before, options.sample, {
        ...operations,
      });
      breakdown.push(first);
      if (first.status === "failed" || !first.after) {
        return { ...first, name: options.name, breakdown };
      }
      midpoint = first.after;
    }
  }
  const last = await sampleResourcePhase(
    options.splitFirst ? `${options.name}-${midpoint ? "warm" : "first"}` : options.name,
    midpoint ?? before,
    options.sample,
    midpoint
      ? {
          attempted: operations.attempted - 1,
          completed: operations.completed - 1,
          failed: operations.failed,
        }
      : operations,
    error,
  );
  if (!options.splitFirst) {
    return last;
  }
  breakdown.push(last);
  // Children share the midpoint; the aggregate retains its original outer counter boundaries.
  return {
    ...(midpoint && last.after
      ? summarizeResourcePhase(options.name, before, last.after, operations, error)
      : { ...last, name: options.name, before, operations }),
    breakdown,
  };
}

/** Only compare the matched host phases; plugin tools have no empty-host equivalent. */
export function compareResourcePhases(
  baseline: KitchenSinkResourcePhase[],
  plugin: KitchenSinkResourcePhase[],
) {
  return baseline.flatMap((empty) => {
    const enabled = plugin.find((phase) => phase.name === empty.name);
    if (
      !enabled ||
      empty.status !== "exercised" ||
      enabled.status !== "exercised" ||
      empty.operations.completed !== enabled.operations.completed ||
      !empty.cpu ||
      !enabled.cpu ||
      !empty.after ||
      !enabled.after ||
      !empty.memoryChangeBytes ||
      !enabled.memoryChangeBytes
    ) {
      return [];
    }
    const emptyGrowth = empty.memoryChangeBytes;
    const enabledGrowth = enabled.memoryChangeBytes;
    return [
      {
        phase: empty.name,
        completedOperations: empty.operations.completed,
        wallMs: enabled.cpu.wallMs - empty.cpu.wallMs,
        processCpuMs: enabled.cpu.process.totalMs - empty.cpu.process.totalMs,
        mainThreadCpuMs: enabled.cpu.mainThread.totalMs - empty.cpu.mainThread.totalMs,
        memoryEndBytes: memoryDifference(empty.after.memory, enabled.after.memory),
        memoryGrowthBytes: Object.fromEntries(
          MEMORY_FIELDS.map((field) => [field, enabledGrowth[field]! - emptyGrowth[field]!]),
        ),
      },
    ];
  });
}
