import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureAdaptiveGraphDecision } from "./ci-adaptive-decision.mts";
import { readCiTestLaunchInputs } from "./ci-test-launch-inputs.mts";
import { collectTestObservations, compactTestObservations } from "./ci-test-observations.mjs";

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

type GraphConfiguration = { files: string[]; settings: unknown };

function graphInputs(root: string, configuration: GraphConfiguration, env: NodeJS.ProcessEnv) {
  try {
    const files = [...new Set(configuration.files)]
      .toSorted()
      .map((file) => [path.relative(root, file).split(path.sep).join("/"), readBounded(file)]);
    const settings = JSON.stringify(configuration.settings, (_key, value: unknown) => {
      if (
        typeof value === "function" ||
        typeof value === "symbol" ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new Error("Graph inputs contain an unsupported value");
      }
      if (value instanceof RegExp) {
        return { source: value.source, flags: value.flags };
      }
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      ) {
        throw new Error("Graph inputs contain an unsupported object");
      }
      return typeof value === "string" ? value.replaceAll(root, "<repository>") : value;
    });
    if (settings === undefined) {
      return null;
    }
    const serialized = JSON.stringify([files, settings]);
    if (Buffer.byteLength(serialized) > MAX_BYTES) {
      throw new Error("Graph inputs exceed the byte limit");
    }
    return {
      version: 1,
      profile: "unit-fast",
      configDigest: createHash("sha256").update(serialized).digest("hex"),
      environmentDigest: digest([
        [
          ...semanticEnv,
          "CI",
          "GITHUB_ACTIONS",
          "OPENCLAW_TEST_WORKERS",
          "NODE_ENV",
          "TZ",
          "LANG",
          "LC_ALL",
        ].map((key) => [key, env[key] ?? null]),
        process.version,
        process.versions.bun ?? null,
        process.platform,
        process.arch,
      ]),
    };
  } catch {
    // Unknown graph inputs must not discard otherwise usable exact-run observations.
    return null;
  }
}

// The reporter supplies native callbacks, not lines that tests can print to stdout.
// This is an optional exchange artifact; failure must not change the test outcome.
export function createCiTestObservationCapture(options: {
  repositoryRoot: string;
  cacheDirectory: string;
  configFiles: string[];
  configuration: unknown;
  graphConfiguration?: GraphConfiguration;
  env?: NodeJS.ProcessEnv;
}) {
  // Test code may change process.env; retain the invocation's original identity.
  const env = { ...(options.env ?? process.env) };
  const directory = env.OPENCLAW_VITEST_OBSERVATION_DIR;
  if (!directory) {
    return undefined;
  }
  const startedAt = new Date().toISOString();
  const launchInputs = readCiTestLaunchInputs(directory);
  const records: string[] = [];
  let bytes = 0;
  let disabled = false;
  let captureMs = 0;
  let preExecution:
    | {
        recordedAt: string;
        observations: ReturnType<typeof collectTestObservations>;
        graphInputs: ReturnType<typeof graphInputs>;
        launchInputs: ReturnType<typeof readCiTestLaunchInputs>;
        decision: ReturnType<typeof captureAdaptiveGraphDecision>;
      }
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
          const recordedAt = new Date().toISOString();
          preExecution = {
            recordedAt,
            observations,
            launchInputs,
            graphInputs: options.graphConfiguration
              ? graphInputs(root, options.graphConfiguration, env)
              : null,
            decision: captureAdaptiveGraphDecision({
              repositoryRoot: root,
              observations,
              env,
              recordedAt,
            }),
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
        const exported = {
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
        };
        let output = JSON.stringify(exported);
        let omittedDependencies = false;
        if (kind === "run" && Buffer.byteLength(output) > MAX_BYTES) {
          output = JSON.stringify({
            ...exported,
            observations: compactTestObservations(observations),
          });
        }
        if (kind === "run" && Buffer.byteLength(output) > MAX_BYTES) {
          // Native indexes can expand far beyond their on-disk size. Keep outcomes usable.
          for (const invocation of observations.invocations) {
            for (const file of invocation.files) {
              file.dependencies = null;
            }
          }
          output = JSON.stringify(exported);
          omittedDependencies = true;
        }
        if (Buffer.byteLength(output) > MAX_BYTES) {
          throw new Error("Observation export exceeds the byte limit");
        }
        const target = path.join(directory, "observations.json");
        writeFileSync(`${target}.tmp`, `${output}\n`);
        renameSync(`${target}.tmp`, target);
        if (omittedDependencies) {
          console.warn(
            "[adaptive-ci] dependency export exceeds byte limit; terminal outcomes retained without dependencies",
          );
        }
      } catch {
        disabled = true;
        warn();
      } finally {
        captureMs += (preparedAt ?? performance.now()) - started;
      }
    },
  };
}
