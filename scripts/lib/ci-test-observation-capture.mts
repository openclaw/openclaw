import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectTestObservations } from "./ci-test-observations.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const semanticEnv = [
  "NODE_OPTIONS",
  "OPENCLAW_CI_TEST_RUNTIME_POLICY",
  "OPENCLAW_VITEST_RUNTIME",
  "OPENCLAW_VITEST_MAX_WORKERS",
  "OPENCLAW_TEST_PROJECTS_PARALLEL",
  "OPENCLAW_E2E_USE_PREBUILT_DIST",
  "OPENCLAW_TEST_USE_BUILD",
];

function readBounded(file: string) {
  if (statSync(file).size > MAX_BYTES) {
    throw new Error("Observation input exceeds the byte limit");
  }
  return readFileSync(file, "utf8");
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// The reporter supplies native callbacks, not lines that tests can print to stdout.
// This is an optional exchange artifact; failure must not change the test outcome.
export function createCiTestObservationCapture(options: {
  repositoryRoot: string;
  cacheDirectory: string;
  configFiles: string[];
  configuration: unknown;
  env?: NodeJS.ProcessEnv;
}) {
  // Test code may change process.env; retain the invocation's original identity.
  const env = { ...(options.env ?? process.env) };
  const directory = env.OPENCLAW_VITEST_OBSERVATION_DIR;
  if (!directory) {
    return undefined;
  }
  const startedAt = new Date().toISOString();
  const records: string[] = [];
  let bytes = 0;
  let disabled = false;
  let captureMs = 0;
  let preExecution:
    | { recordedAt: string; observations: ReturnType<typeof collectTestObservations> }
    | undefined;
  const warn = () => console.warn("[adaptive-ci] observation export unavailable; tests unchanged");

  return {
    record(kind: string, value: unknown) {
      if (disabled || !["inventory", "module", "run"].includes(kind)) {
        return;
      }
      const started = performance.now();
      let preparedAt: number | undefined;
      try {
        const line = `[vitest:${kind}] ${JSON.stringify(value)}`;
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > MAX_BYTES) {
          throw new Error("Observation receipts exceed the byte limit");
        }
        records.push(line);
        if (kind !== "inventory" && kind !== "run") {
          return;
        }
        if (kind === "inventory") {
          if (preExecution) {
            throw new Error("Duplicate observation inventory");
          }
          const root = options.repositoryRoot;
          const git = (revision: string) =>
            execFileSync("git", ["rev-parse", "--verify", revision], {
              cwd: root,
              encoding: "utf8",
              timeout: 5_000,
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
          const configFiles = [...new Set(options.configFiles)]
            .toSorted()
            .map((file) => [path.relative(root, file), readBounded(file)]);
          const includes = [
            "OPENCLAW_VITEST_INCLUDE_FILE",
            "OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE",
          ].map((key) => [key, env[key] ? readBounded(env[key]) : null]);
          const context = {
            repository: env.GITHUB_REPOSITORY ?? "openclaw/openclaw",
            revision: git("HEAD"),
            tree: git("HEAD^{tree}"),
            configDigest: digest([configFiles, options.configuration]),
            lockDigest: digest(
              ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", ".npmrc"].map((file) => [
                file,
                readBounded(path.join(root, file)),
              ]),
            ),
            environmentDigest: digest([
              semanticEnv.map((key) => [key, env[key] ?? null]),
              includes,
              process.version,
              process.versions.bun ?? null,
              process.platform,
              process.arch,
            ]),
          };
          const observations = collectTestObservations(records.join("\n"), context);
          preExecution = {
            recordedAt: new Date().toISOString(),
            observations,
          };
        }
        if (!preExecution) {
          throw new Error("Observation completion without inventory");
        }
        let dependencies: unknown = null;
        if (kind === "run") {
          try {
            dependencies = JSON.parse(
              readBounded(path.join(options.cacheDirectory, "dependencies.json")),
            );
          } catch {
            // Missing native records are a data gap, never an empty impact set.
          }
        }
        const observations =
          kind === "inventory"
            ? preExecution.observations
            : collectTestObservations(
                records.join("\n"),
                preExecution.observations.context,
                dependencies,
              );
        preparedAt = performance.now();
        const output = JSON.stringify({
          version: 1,
          source: {
            runId: env.GITHUB_RUN_ID ?? null,
            runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
            job: env.GITHUB_JOB ?? null,
            shard: env.OPENCLAW_VITEST_SHARD_NAME ?? null,
            event: env.GITHUB_EVENT_NAME ?? null,
            startedAt,
            exportedAt: new Date().toISOString(),
          },
          preExecution,
          // Excludes serialization/write, native recording, and cache misses.
          capturePreparationMs: captureMs + preparedAt - started,
          observations,
        });
        if (Buffer.byteLength(output) > MAX_BYTES) {
          throw new Error("Observation export exceeds the byte limit");
        }
        const target = path.join(directory, "observations.json");
        writeFileSync(`${target}.tmp`, `${output}\n`);
        renameSync(`${target}.tmp`, target);
      } catch {
        disabled = true;
        warn();
      } finally {
        captureMs += (preparedAt ?? performance.now()) - started;
      }
    },
  };
}
