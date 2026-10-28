#!/usr/bin/env node
// Verifies the built runtime still carries the agent-database contention fix.
//
// The fix for a transient SQLite lock on the Gateway's agent-database startup
// lived only as a patch of the installed `dist/` bundle. A dist patch dies on
// the next `pnpm install` rebuild of the OpenClaw package, so the fix now
// lives in source. A rebuild can still drop it: a partial build, a stale
// chunk, or a bundler change that reshapes the emitted runtime.
//
// This check reads the built runtime and fails when a source module that
// carries the fix is missing from the build, or when its markers are gone.
// It runs as a postbuild phase, so a rebuild that drops the fix never
// produces a shippable package.
import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

type MarkerSpec = {
  /** Source module whose built chunk must carry every marker. */
  sourceModule: string;
  /** Strings that must survive into the built chunk. */
  markers: string[];
};

type VerifyParams = {
  rootDir?: string;
  /** Fail when there is no built runtime to inspect instead of skipping. */
  requireDist?: boolean;
};

export const AGENT_DATABASE_CONTENTION_MARKERS: MarkerSpec[] = [
  {
    sourceModule: "src/state/agent-database-admission.ts",
    markers: ["isTransientAgentDatabaseContention", "lock contention"],
  },
  {
    sourceModule: "src/state/agent-database-startup.ts",
    markers: ["isTransientAgentDatabaseContention"],
  },
  {
    sourceModule: "src/cron/session-registry-maintenance.ts",
    markers: [
      "agent-store-failed",
      "Session registry maintenance skipped for one agent store",
      "failedStores",
    ],
  },
  {
    sourceModule: "src/cron/maintenance.ts",
    markers: ["Session registry maintenance skipped some agent stores", "failedStores"],
  },
];

function listBuiltRuntimeFiles(distDir: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (/\.(?:mjs|cjs|js)$/u.test(entry.name)) {
        files.push(entryPath);
      }
    }
  };
  visit(distDir);
  return files;
}

/** Returns the built chunks that carry the given source module. */
function findBuiltChunksForSourceModule(
  builtFiles: readonly string[],
  sourceModule: string,
): string[] {
  const matches: string[] = [];
  for (const file of builtFiles) {
    if (fs.readFileSync(file, "utf8").includes(sourceModule)) {
      matches.push(file);
    }
  }
  return matches;
}

export function verifyAgentDatabaseContentionMarkers(params: VerifyParams = {}): {
  checked: number;
  failures: string[];
  skipped: boolean;
} {
  const rootDir = path.resolve(params.rootDir ?? resolveRepoRoot(import.meta.url));
  const distDir = path.join(rootDir, "dist");
  if (!fs.existsSync(distDir)) {
    if (params.requireDist) {
      throw new Error(`agent database contention marker check: no built runtime at ${distDir}`);
    }
    console.log(
      "agent database contention marker check: no built runtime; skipping (nothing to verify)",
    );
    return { checked: 0, failures: [], skipped: true };
  }
  const builtFiles = listBuiltRuntimeFiles(distDir);
  const failures: string[] = [];
  for (const spec of AGENT_DATABASE_CONTENTION_MARKERS) {
    const chunks = findBuiltChunksForSourceModule(builtFiles, spec.sourceModule);
    if (chunks.length === 0) {
      failures.push(`${spec.sourceModule} is not present in the built runtime`);
      continue;
    }
    const builtSource = chunks.map((chunk) => fs.readFileSync(chunk, "utf8")).join("\n");
    for (const marker of spec.markers) {
      if (!builtSource.includes(marker)) {
        failures.push(
          `${spec.sourceModule} lost the marker ${JSON.stringify(marker)} in ${chunks
            .map((chunk) => path.relative(rootDir, chunk))
            .join(", ")}`,
        );
      }
    }
  }
  return { checked: AGENT_DATABASE_CONTENTION_MARKERS.length, failures, skipped: false };
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const requireDist = process.argv.includes("--require-dist");
  const rootDirArg = process.argv.find((arg) => arg.startsWith("--root-dir="));
  const rootDir = rootDirArg?.slice("--root-dir=".length);
  const result = verifyAgentDatabaseContentionMarkers({ requireDist, rootDir });
  if (result.skipped) {
    process.exit(0);
  }
  if (result.failures.length > 0) {
    console.error(
      `agent database contention marker check failed (${result.failures.length} issue(s)):`,
    );
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log(
    `agent database contention marker check passed (${result.checked} source modules verified)`,
  );
  process.exit(0);
}
