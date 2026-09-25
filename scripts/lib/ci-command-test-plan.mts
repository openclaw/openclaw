import { relative } from "node:path";
import { commandsLightTestFiles } from "../../test/vitest/vitest.commands-light-paths.mjs";
import { databaseWorkerCoreTestFiles } from "../../test/vitest/vitest.database-worker-core-paths.mjs";
import { getUnitFastTestFiles } from "../../test/vitest/vitest.unit-fast-paths.mjs";
import {
  readCompactGroupTimings,
  readCompleteSplitGenerationSeconds,
  readRuntimePlacementTimings,
  resolveRuntimePlacementSeconds,
} from "./ci-test-timings.mts";
import { isStripeEligibleTestFile, listTrackedTestFiles } from "./list-test-files.mts";
import type { VitestPretestBuildMode } from "./vitest-build-prerequisites.mts";
import {
  COMPACT_GITHUB_GROUP_SECONDS_SCALE,
  COMPACT_HYBRID_GROUP_SECONDS_SCALE,
  createCompactSplitTimingGeneration,
  estimateVitestTestFileSeconds as stripeFileWeight,
} from "./vitest-shard-metadata.mts";

export const COMMANDS_RUNTIME_GROUP = "agentic-commands-runtime";

type CommandGroup = {
  configs: string[];
  includePatterns?: string[];
  pretestBuildMode?: VitestPretestBuildMode;
};

export const COMMANDS_PARALLEL_TIMING_SUFFIX = "#file-parallel-2";

export function isParallelCommandsGroup(group: CommandGroup): boolean {
  return group.configs.length === 1 && group.configs[0] === "test/vitest/vitest.commands.config.ts";
}

export function commandFileSecondsFloor(
  files: readonly string[],
  runnerBackend: string | undefined,
): number {
  const scale =
    runnerBackend === "github"
      ? COMPACT_GITHUB_GROUP_SECONDS_SCALE
      : runnerBackend === "hybrid"
        ? COMPACT_HYBRID_GROUP_SECONDS_SCALE
        : 1;
  return Math.max(0, ...files.map(stripeFileWeight)) * scale;
}

type CommandTimingSource = { shard_name: string; includePatterns: string[] };

export function estimateSerialCommandSeconds(
  group: CommandGroup,
  runnerBackend: string | undefined,
  parentSeconds: (source: CommandTimingSource) => number,
): number {
  const files = group.includePatterns ?? [];
  const selected = new Set(files);
  const profile = runnerBackend === "github" ? "github" : "blacksmith";
  const scale =
    runnerBackend === "github"
      ? COMPACT_GITHUB_GROUP_SECONDS_SCALE
      : runnerBackend === "hybrid"
        ? COMPACT_HYBRID_GROUP_SECONDS_SCALE
        : 1;
  let seconds = 0;
  for (const [parent, originalFiles] of getCommandFilesByOwner()) {
    const selectedFiles = originalFiles.filter((file) => selected.has(file));
    if (!selectedFiles.length) {
      continue;
    }
    const generation = createCompactSplitTimingGeneration({
      configs: group.configs,
      parentShardName: parent,
      stripes: [originalFiles],
    });
    const fullSeconds = Math.max(
      parentSeconds({ shard_name: parent, includePatterns: originalFiles }),
      (readCompleteSplitGenerationSeconds(
        readCompactGroupTimings(profile),
        generation.selectorKey,
      ) ?? 0) * (runnerBackend === "hybrid" ? scale : 1),
    );
    const fraction =
      selectedFiles.reduce((sum, file) => sum + stripeFileWeight(file), 0) /
      originalFiles.reduce((sum, file) => sum + stripeFileWeight(file), 0);
    const runtimeGroup = { ...group, includePatterns: selectedFiles, env: {} };
    const profileRuntime = resolveRuntimePlacementSeconds(
      runtimeGroup,
      readRuntimePlacementTimings(profile),
    );
    const runtimeSeconds =
      profileRuntime !== undefined
        ? profileRuntime * (runnerBackend === "hybrid" ? scale : 1)
        : (resolveRuntimePlacementSeconds(
            runtimeGroup,
            readRuntimePlacementTimings("blacksmith"),
          ) ?? 0) * scale;
    seconds += Math.max(fullSeconds * fraction, runtimeSeconds);
  }
  // A file occupies one fork even when siblings share the two-worker budget.
  return Math.max(
    seconds / Math.max(1, Math.min(2, files.length)),
    commandFileSecondsFloor(files, runnerBackend),
  );
}

export function estimateLegacyCommandStripeSeconds(
  files: readonly string[],
  timingKey: string | undefined,
  runnerBackend: string | undefined,
): number {
  const profile = runnerBackend === "github" ? "github" : "blacksmith";
  const seconds = timingKey ? (readCompactGroupTimings(profile)[timingKey] ?? 0) : 0;
  return (
    (seconds * (runnerBackend === "hybrid" ? COMPACT_HYBRID_GROUP_SECONDS_SCALE : 1)) /
    Math.max(1, Math.min(2, files.length))
  );
}

// Admission uses the hosted/retry allocation. Reprice only the test portion
// after placement; an indivisible file and a direct parallel sample remain floors.
export function estimateCommandWorkerSeconds(
  group: CommandGroup & { timing_key?: string },
  fallbackSeconds: number,
  maxWorkers: number,
  runnerBackend: string | undefined,
): { seconds: number; timingKey: string | undefined } {
  const files = group.includePatterns ?? [];
  const timingKey = group.timing_key?.replace(
    COMMANDS_PARALLEL_TIMING_SUFFIX,
    `#file-parallel-${maxWorkers}`,
  );
  const profile = runnerBackend === "github" ? "github" : "blacksmith";
  const measured = timingKey ? (readCompactGroupTimings(profile)[timingKey] ?? 0) : 0;
  return {
    timingKey,
    seconds: Math.max(
      (fallbackSeconds * Math.max(1, Math.min(2, files.length))) /
        Math.max(1, Math.min(maxWorkers, files.length)),
      commandFileSecondsFloor(files, runnerBackend),
      measured * (runnerBackend === "hybrid" ? COMPACT_HYBRID_GROUP_SECONDS_SCALE : 1),
    ),
  };
}

// Keep the split corpus with its measured parent; independent SQLite siblings
// retain their existing sessions/cron timing owner.
const doctorSessionSqliteCorpusFiles = new Set([
  "doctor-session-sqlite.test.ts",
  "doctor-session-sqlite.archive-safety.test.ts",
  "doctor-session-sqlite.compaction.test.ts",
  "doctor-session-sqlite.compaction-recovery.test.ts",
  "doctor-session-sqlite.failure-reports.test.ts",
  "doctor-session-sqlite.inspection.test.ts",
  "doctor-session-sqlite.manifests.test.ts",
  "doctor-session-sqlite.publication-recovery.test.ts",
  "doctor-session-sqlite.recovery.test.ts",
  "doctor-session-sqlite.recovery-generations.test.ts",
  "doctor-session-sqlite.recovery-shared-owners.test.ts",
  "doctor-session-sqlite.restore-history.test.ts",
  "doctor-session-sqlite.restore-paths.test.ts",
  "doctor-session-sqlite.restore-publication.test.ts",
  "doctor-session-sqlite.retirement-disposal.test.ts",
  "doctor-session-sqlite.retirement-mutations.test.ts",
  "doctor-session-sqlite.retirement-verification.test.ts",
  "doctor-session-sqlite.targets.test.ts",
]);

function resolveCommandShardName(file: string): string {
  const name = relative("src/commands", file).replaceAll("\\", "/");
  if (name.startsWith("agent") || name.startsWith("channel") || name === "message.test.ts") {
    return "agentic-commands-agent-channel";
  }
  if (name.startsWith("oauth-tls-preflight.doctor")) {
    return "agentic-commands-doctor-auth";
  }
  if (name.startsWith("doctor")) {
    if (name.startsWith("doctor/shared/") || name.startsWith("doctor/")) {
      return "agentic-commands-doctor-shared";
    }
    if (name.startsWith("doctor-auth")) {
      return "agentic-commands-doctor-auth";
    }
    if (
      name.startsWith("doctor-config") ||
      name.startsWith("doctor-legacy-config") ||
      name.startsWith("doctor-state")
    ) {
      return "agentic-commands-doctor-config-state";
    }
    if (name === "doctor-session-sqlite.memory.test.ts") {
      return "agentic-commands-doctor-sessions-cron-memory";
    }
    if (doctorSessionSqliteCorpusFiles.has(name)) {
      return "agentic-commands-doctor-sessions-cron-sqlite";
    }
    if (
      [
        "doctor-session-sqlite-recovery-inventory.test.ts",
        "doctor-session-sqlite.active-settlement.test.ts",
        "doctor-session-sqlite.receipt-recovery.test.ts",
        "doctor-session-transcripts.missing-index.test.ts",
      ].includes(name)
    ) {
      return "agentic-commands-doctor-sessions-cron-sqlite-recovery";
    }
    if (
      name.startsWith("doctor-cron") ||
      name.startsWith("doctor-heartbeat") ||
      name.startsWith("doctor-session")
    ) {
      return "agentic-commands-doctor-sessions-cron";
    }
    if (name.startsWith("doctor-gateway")) {
      return "agentic-commands-doctor-gateway";
    }
    if (name.startsWith("doctor-device")) {
      return "agentic-commands-doctor-device";
    }
    if (name.startsWith("doctor-platform")) {
      return "agentic-commands-doctor-platform";
    }
    if (name.startsWith("doctor-whatsapp")) {
      return "agentic-commands-doctor-whatsapp";
    }
    if (name.startsWith("doctor-workspace")) {
      return "agentic-commands-doctor-workspace";
    }
    if (
      name.startsWith("doctor-browser") ||
      name.startsWith("doctor-plugin") ||
      name.startsWith("doctor-skill") ||
      name.startsWith("doctor-memory") ||
      name.startsWith("doctor-claude")
    ) {
      return "agentic-commands-doctor-plugins-tools";
    }
    return "agentic-commands-doctor";
  }
  if (
    name.startsWith("auth-choice") ||
    name.startsWith("configure") ||
    name.startsWith("onboard") ||
    name === "setup.test.ts"
  ) {
    return "agentic-commands-onboard-config";
  }
  if (
    name.startsWith("models/") ||
    name === "model-picker.test.ts" ||
    name === "openai-model-default.test.ts"
  ) {
    return "agentic-commands-models";
  }
  return "agentic-commands-status-tools";
}

let commandFilesByOwner: Map<string, string[]> | undefined;

function getCommandFilesByOwner(): Map<string, string[]> {
  if (commandFilesByOwner) {
    return commandFilesByOwner;
  }
  const excludedTests = new Set([...commandsLightTestFiles, ...databaseWorkerCoreTestFiles]);
  const unitFastFiles = new Set(getUnitFastTestFiles());
  const groups = new Map<string, string[]>();
  for (const file of listTrackedTestFiles("src/commands")) {
    if (excludedTests.has(file) || !isStripeEligibleTestFile(file, unitFastFiles)) {
      continue;
    }
    const shardName = resolveCommandShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  commandFilesByOwner = groups;
  return groups;
}

export function createAgenticCommandSplitShards(
  resolveBuildMode: (files: readonly string[]) => VitestPretestBuildMode | undefined,
) {
  const groups = new Map<string, string[]>();
  const runtimeFiles: string[] = [];
  for (const [name, files] of getCommandFilesByOwner()) {
    groups.set(
      name,
      files.filter((file) => {
        if (resolveBuildMode([file]) !== "runtime") {
          return true;
        }
        runtimeFiles.push(file);
        return false;
      }),
    );
  }
  groups.set(COMMANDS_RUNTIME_GROUP, runtimeFiles);

  return [
    "agentic-commands-agent-channel",
    "agentic-commands-doctor",
    "agentic-commands-doctor-auth",
    "agentic-commands-doctor-config-state",
    "agentic-commands-doctor-device",
    "agentic-commands-doctor-gateway",
    "agentic-commands-doctor-platform",
    "agentic-commands-doctor-plugins-tools",
    "agentic-commands-doctor-sessions-cron",
    "agentic-commands-doctor-sessions-cron-memory",
    "agentic-commands-doctor-sessions-cron-sqlite",
    "agentic-commands-doctor-sessions-cron-sqlite-recovery",
    "agentic-commands-doctor-shared",
    "agentic-commands-doctor-whatsapp",
    "agentic-commands-doctor-workspace",
    "agentic-commands-models",
    "agentic-commands-onboard-config",
    "agentic-commands-status-tools",
    COMMANDS_RUNTIME_GROUP,
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.commands.config.ts"],
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}
