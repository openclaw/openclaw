import { isTestFileTarget } from "./changed-path-facts.mjs";

const DATABASE_ENGINE_TARGET = "src/infra/database-engine";
const postgresConformanceTargets = [
  "extensions/workboard",
  "extensions/logbook/src/postgres-store.test.ts",
  "extensions/logbook/src/store-transport.postgres.test.ts",
  "extensions/clickclack/src/discussions/revoked-channel-store.postgres.test.ts",
  "extensions/imessage/src/monitor/recovery-cursor.postgres.test.ts",
  "extensions/matrix/src/matrix/account-state.postgres.test.ts",
  "extensions/team-reports/src/postgres-store.test.ts",
  "extensions/team-reports/src/store-recovery.postgres.test.ts",
  "src/infra/postgres-sync",
  DATABASE_ENGINE_TARGET,
  "src/agents/agent-deletion-recovery-hold.postgres.test.ts",
  "src/agents/worktrees/capacity.postgres.test.ts",
  "src/commands/database-prepare-state.postgres.test.ts",
  "src/commands/doctor/cron/legacy-repair.postgres.test.ts",
  "src/commands/doctor-database-diagnostics.postgres.test.ts",
  "src/commands/doctor/auth-alias-migration.postgres.test.ts",
  "src/commands/startup-client-credentials.postgres.test.ts",
  "src/config/sessions/session-cold-storage-selection.postgres.test.ts",
  "src/config/sessions/session-accessor.sqlite-lifecycle-artifacts.postgres.test.ts",
  "src/config/sessions/session-accessor.sqlite-maintenance-age.postgres.test.ts",
  "src/config/sessions/session-accessor.sqlite-read-hold.postgres.test.ts",
  "src/config/sessions/session-turn-resident.postgres.test.ts",
  "src/config/sessions/session-turn-commit.postgres.test.ts",
  "src/infra/client-credential-migration.postgres.test.ts",
  "src/infra/client-credential-startup.gateway.postgres.test.ts",
  "src/infra/state-migrations.plugin-doctor-context.postgres.test.ts",
  "src/infra/gateway-lock-recovery.postgres.test.ts",
  "src/infra/exec-approvals-native.test.ts",
  "src/infra/client-credential-update.test.ts",
  "src/infra/update-candidate-state.postgres.test.ts",
  "src/infra/update-managed-service-handoff-engine.test.ts",
  "src/snapshot/postgres-generation.postgres.test.ts",
  "src/state/openclaw-state-db.postgres.test.ts",
  "src/state/openclaw-state-db-open.postgres.test.ts",
  "src/state/openclaw-agent-creation-operations-migration.postgres.test.ts",
  "src/state/openclaw-agent-db.postgres.test.ts",
  "src/state/openclaw-agent-doctor-media.postgres.test.ts",
  "src/state/openclaw-agent-db-engine.postgres.test.ts",
  "src/talk/client-voice-session-entry.postgres.test.ts",
  "extensions/memory-core/src/memory/manager-embedding-cache.postgres.test.ts",
  "extensions/memory-core/src/memory/manager-embedding-cache-rebuild.postgres.test.ts",
  "extensions/memory-core/src/memory/manager-source-index-kernel.postgres.test.ts",
  "extensions/memory-core/src/memory/manager-duplicate-chunks.postgres.test.ts",
  "extensions/memory-core/src/memory/manager-publication.postgres.test.ts",
  "extensions/memory-core/src/memory/manager-search.postgres.test.ts",
  "extensions/memory-core/src/tools.postgres.test.ts",
  "extensions/memory-core/src/standing-intents.postgres.test.ts",
  "extensions/memory-core/src/memory-forget.postgres.test.ts",
  "src/gateway/server-database-engine.postgres.test.ts",
  "src/gateway/server-handoff-sentinel.socket.postgres.test.ts",
  "src/transcripts/meeting-chronology.postgres.test.ts",
] as const;

/** Preserve inventory order while the runner owns filesystem discovery. */
export function resolvePostgresConformanceTargets(
  databaseEngineTests: readonly string[],
): string[] {
  return postgresConformanceTargets.flatMap((target) =>
    target === DATABASE_ENGINE_TARGET ? databaseEngineTests : [target],
  );
}

/** Changed paths include deleted tests, so ownership must not depend on existence. */
export function isPostgresConformanceTestTarget(file: string): boolean {
  return (
    isTestFileTarget(file) &&
    postgresConformanceTargets.some((target) =>
      isTestFileTarget(target)
        ? file === target
        : file.startsWith(`${target}/`) &&
          (target !== DATABASE_ENGINE_TARGET || file.endsWith(".test.ts")),
    )
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
  const shards = Array.from({ length: count }, () => ({ targets: new Array<string>(), weight: 0 }));
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
      const candidate = shards.map((other) => (other === shard ? next : other.weight));
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
