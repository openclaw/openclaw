import { isTestFileTarget } from "./changed-path-facts.mjs";

export const PG16_GATEWAY_SMOKE_RESERVATION_SECONDS = 150;

const DATABASE_ENGINE_TARGET = "src/infra/database-engine";
// These directory and non-suffix suites also require the PostgreSQL runner.
const additionalPostgresConformanceTargets = [
  "extensions/workboard",
  "extensions/logbook/src/postgres-store.test.ts",
  "extensions/team-reports/src/postgres-store.test.ts",
  "src/infra/postgres-sync",
  DATABASE_ENGINE_TARGET,
  "src/infra/exec-approvals-native.test.ts",
  "src/infra/client-credential-update.test.ts",
  "src/infra/update-managed-service-handoff-engine.test.ts",
] as const;

/** Filesystem discovery owns suffix suites; explicit targets cover the remaining contracts. */
export function resolvePostgresConformanceTargets(testFiles: readonly string[]): string[] {
  const targets = additionalPostgresConformanceTargets.flatMap((target) =>
    target === DATABASE_ENGINE_TARGET
      ? testFiles.filter(
          (file) => file.startsWith(`${DATABASE_ENGINE_TARGET}/`) && file.endsWith(".test.ts"),
        )
      : [target],
  );
  return [
    ...targets,
    ...testFiles.filter(
      (file) =>
        file.endsWith(".postgres.test.ts") &&
        !targets.some((target) => file === target || file.startsWith(`${target}/`)),
    ),
  ];
}

/** Changed paths include deleted tests, so ownership must not depend on existence. */
export function isPostgresConformanceTestTarget(file: string): boolean {
  return (
    isTestFileTarget(file) &&
    (((file.startsWith("src/") || file.startsWith("extensions/")) &&
      file.endsWith(".postgres.test.ts")) ||
      additionalPostgresConformanceTargets.some((target) =>
        isTestFileTarget(target)
          ? file === target
          : file.startsWith(`${target}/`) &&
            (target !== DATABASE_ENGINE_TARGET || file.endsWith(".test.ts")),
      ))
  );
}

type PostgresConformanceTimings = {
  workers: number;
  preparationSeconds: { base: number; runtime: number };
  groupSeconds: Record<string, number>;
  runtimeTargets: string[];
  files: Record<string, { group: string; seconds: number }>;
};

/** Measured metadata prices work; the runner's target inventory still selects it. */
export function createPostgresConformanceEstimator(
  timings: PostgresConformanceTimings,
  sizeOf: (file: string) => number,
) {
  const files = Object.entries(timings.files)
    .map(([file, timing]) => ({
      file,
      group: timing.group,
      seconds: timing.seconds,
      size: sizeOf(file),
    }))
    // Cold Vitest orders files by size, not by measured duration.
    .toSorted((a, b) => b.size - a.size || a.file.localeCompare(b.file));
  return (targets: readonly string[]) => {
    if (targets.length === 0) {
      return 0;
    }
    const groups = new Map<string, { seconds: number }[]>();
    const known = new Set<string>();
    for (const { file, group, seconds } of files) {
      const owners = targets.filter((target) => file === target || file.startsWith(`${target}/`));
      if (owners.length === 0) {
        continue;
      }
      owners.forEach((target) => known.add(target));
      const workers =
        groups.get(group) ?? Array.from({ length: timings.workers }, () => ({ seconds: 0 }));
      const lightest = workers.reduce((a, b) => (a.seconds <= b.seconds ? a : b));
      lightest.seconds += seconds;
      groups.set(group, workers);
    }
    const preparation = targets.some((target) => timings.runtimeTargets.includes(target))
      ? timings.preparationSeconds.runtime
      : timings.preparationSeconds.base;
    // Configuration processes run sequentially; only files inside each share workers.
    return (
      preparation +
      [...groups].reduce(
        (total, [group, workers]) =>
          total +
          Math.max(...workers.map((worker) => worker.seconds)) +
          (timings.groupSeconds[group.split(":")[0] ?? group] ?? 0),
        0,
      ) +
      targets.filter((target) => !known.has(target)).length * 30
    );
  };
}

/** Minimize the tail, breaking ties by total work so shared setup stays shared. */
export function assignPostgresConformanceShards(
  targets: readonly string[],
  count: number,
  estimate: (targets: readonly string[]) => number,
): string[][] {
  // PR row 1 also pays ~140s for the PG16 smoke, including worker preparation.
  // Keep one deterministic plan for every caller, reserving service lifecycle headroom too.
  const shards = Array.from({ length: count }, (_, index) => ({
    targets: new Array<string>(),
    overhead: index === 0 ? PG16_GATEWAY_SMOKE_RESERVATION_SECONDS : 0,
    weight: 0,
  }));
  const ordered = targets
    .map((target) => ({ target, weight: estimate([target]) }))
    .toSorted((a, b) => b.weight - a.weight || a.target.localeCompare(b.target));
  for (const { target } of ordered) {
    let best = shards[0];
    if (!best) {
      throw new Error("PostgreSQL conformance shards must not be empty");
    }
    let bestTail = Infinity;
    let bestTotal = Infinity;
    for (const shard of shards) {
      const next = estimate([...shard.targets, target]);
      const candidate = shards.map(
        (other) => other.overhead + (other === shard ? next : other.weight),
      );
      const tail = Math.max(...candidate);
      const total = candidate.reduce((sum, weight) => sum + weight, 0);
      if (tail < bestTail || (tail === bestTail && total < bestTotal)) {
        best = shard;
        bestTail = tail;
        bestTotal = total;
      }
    }
    best.targets.push(target);
    best.weight = estimate(best.targets);
  }
  return shards.map((shard) => shard.targets);
}
