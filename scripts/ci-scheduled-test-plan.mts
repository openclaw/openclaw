#!/usr/bin/env node
// Cover the tracked tests that have no other unattended scheduled owner.
import { appendFileSync } from "node:fs";
import { encodeNodeTestGroups } from "./lib/ci-node-test-groups-codec.mts";
import type { NodeTestShardGroup } from "./lib/ci-node-test-plan.mts";
import { listUnscheduledTestFiles } from "./lib/ci-scheduled-coverage.mts";
import { readRepoE2eFileTimings, readToolingFileTimings } from "./lib/ci-test-timings.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  mergeVitestPretestBuildModes,
  resolveVitestPretestBuildMode,
} from "./lib/vitest-build-prerequisites.mts";

const TARGET_SECONDS = 300;
const MAX_ROWS = 16;
const UNKNOWN_FILE_SECONDS = 20;

type EveryFileTestRow = {
  check_name: string;
  shard_name: string;
  runner: string;
  groups_gzip_base64: string;
  plan_concurrency: number;
  predicted_seconds: number;
  pretest_build_mode?: NodeTestShardGroup["pretestBuildMode"];
};

export function createEveryFileTestMatrix(): { include: EveryFileTestRow[] } {
  const timings = { ...readRepoE2eFileTimings(), ...readToolingFileTimings("github") };
  const entries = listUnscheduledTestFiles().map((file) => {
    if (!/\.test\.(?:tsx?|mts|mjs|cjs)$/u.test(file)) {
      throw new Error(`Scheduled every-file test is not supported by Vitest: ${file}`);
    }
    const configs = ["test/vitest/vitest.every-file.config.ts"];
    const group: NodeTestShardGroup = {
      shard_name: `every-file:${file}`,
      configs,
      includePatterns: [file],
      requiresDist: false,
      runner: "ubuntu-24.04",
      env: {
        OPENCLAW_VITEST_MAX_WORKERS: "2",
        OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
      },
      pretestBuildMode: /\.e2e\.test\./u.test(file)
        ? "private-qa"
        : resolveVitestPretestBuildMode([{ configs, includePatterns: [file] }]),
    };
    // Keep previously unowned files in independent isolated child processes.
    return { file, group, seconds: timings[file] ?? UNKNOWN_FILE_SECONDS };
  });
  if (entries.length === 0) {
    return { include: [] };
  }

  // The target is advisory: the hard row cap never discards files when estimates grow.
  const rowCount = Math.min(
    MAX_ROWS,
    entries.length,
    Math.max(1, Math.ceil(entries.reduce((sum, entry) => sum + entry.seconds, 0) / TARGET_SECONDS)),
  );
  const bins = Array.from({ length: rowCount }, () => ({
    groups: [] as NodeTestShardGroup[],
    seconds: 0,
  }));
  for (const entry of entries.toSorted(
    (a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file),
  )) {
    const bin = bins.reduce((best, candidate) =>
      candidate.seconds < best.seconds ? candidate : best,
    );
    bin.groups.push(entry.group);
    bin.seconds += entry.seconds;
  }
  return {
    include: bins.map((bin, index) => ({
      check_name: `Scheduled every-file tests (${index + 1}/${bins.length})`,
      shard_name: `scheduled-every-file-${index + 1}`,
      runner: "ubuntu-24.04",
      groups_gzip_base64: encodeNodeTestGroups(bin.groups),
      plan_concurrency: 1,
      predicted_seconds: Math.ceil(bin.seconds),
      pretest_build_mode: mergeVitestPretestBuildModes(
        bin.groups.map((group) => group.pretestBuildMode),
      ),
    })),
  };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const matrix = createEveryFileTestMatrix();
  const outputs = `matrix=${JSON.stringify(matrix)}\nhas_files=${matrix.include.length > 0}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  } else {
    process.stdout.write(outputs);
  }
}
