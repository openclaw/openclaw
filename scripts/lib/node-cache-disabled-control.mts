import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertDefinitionSources,
  hashPreparedPnpmExecutable,
  validateWorkloadDefinition,
} from "./node-cache-workload-inputs.mts";
import { parseNodeCacheDiagnostic } from "./node-compile-cache-diagnostics.mts";
import {
  inventoryPreparedWorkload,
  preparedInventoryDelta,
} from "./prepared-workload-inventory.mts";
import {
  parseVitestExecutionReport,
  sha256,
  withTerminalManifest,
  writeJsonAtomic,
} from "./vitest-pair-benchmark-contract.mts";
import {
  buildBenchmarkCommandEnv,
  buildNodeCacheVitestArgs,
  ownedDirectory,
  readNodeCacheSeed,
  restoreNodeCacheSeed,
  runOwnedCommand,
  withVitestPairDeadline,
  type VitestPairDeadline,
} from "./vitest-pair-benchmark.mts";

// Bind the loaded Linux owner and its conditional process helpers to committed H.
export const NODE_CACHE_DISABLED_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "packages/normalization-core/package.json",
  "packages/normalization-core/src/mountinfo-path.ts",
  "packages/normalization-core/src/record-coerce.ts",
  "scripts/vitest-pair-benchmark.mts",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/managed-cleanup-handoff.mts",
  "scripts/lib/managed-memory-entrypoint.mts",
  "scripts/lib/managed-memory-launcher.mts",
  "scripts/lib/managed-memory.mts",
  "scripts/lib/managed-windows-job-entrypoint.mts",
  "scripts/lib/managed-windows-job-launcher.mts",
  "scripts/lib/managed-windows-job.mts",
  "scripts/lib/process-memory.mts",
  "scripts/lib/vitest-resource-ownership.mts",
  "scripts/lib/windows-taskkill.mjs",
  "scripts/lib/vitest-pair-benchmark-contract.mts",
  "scripts/lib/vitest-pair-benchmark.mts",
  "scripts/lib/node-compile-cache-diagnostics.mts",
  "scripts/lib/prepared-workload-inventory.mts",
  "scripts/lib/node-cache-workload-inputs.mts",
  "scripts/lib/node-cache-disabled-control.mts",
  "src/shared/deferred.ts",
] as const;

type Context = {
  workloadDir: string;
  definitionPath: string;
  outputDir: string;
  scratchDir: string;
  pnpmBin: string;
  harnessSha: string;
  timeoutMs: number;
};
type Check = { status: "unavailable" | "passed" | "failed"; reason?: string };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function git(root: string, args: string[], deadline: VitestPairDeadline) {
  deadline.throwIfExpired();
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: Math.max(1, Math.min(10_000, deadline.deadlineAt - Date.now())),
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Qualification Git read failed: ${args[0]}`);
  }
  deadline.throwIfExpired();
  return result.stdout.trim();
}

function sealSeed(root: string) {
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    if (lstatSync(file).isDirectory()) {
      sealSeed(file);
    } else {
      chmodSync(file, 0o400);
    }
  }
  chmodSync(root, 0o500);
}

function assertSealedSeed(root: string, expected: ReturnType<typeof readNodeCacheSeed>) {
  if (JSON.stringify(readNodeCacheSeed(root)) !== JSON.stringify(expected)) {
    throw new Error("Sealed seed bytes changed");
  }
  const visit = (directory: string) => {
    if ((lstatSync(directory).mode & 0o777) !== 0o500) {
      throw new Error("Sealed seed directory mode changed");
    }
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      if (lstatSync(file).isDirectory()) {
        visit(file);
      } else if ((lstatSync(file).mode & 0o777) !== 0o400) {
        throw new Error("Sealed seed file mode changed");
      }
    }
  };
  visit(root);
}

export function qualifyNodeCacheDisabledControl(input: Context) {
  return qualifyControls(input, false);
}

export function qualifyNodeCacheWorkload(input: Context) {
  return qualifyControls(input, true);
}

async function qualifyControls(input: Context, full: boolean) {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > 30 * 60_000
  ) {
    throw new Error("Disabled control requires an explicit deadline of at most 30 minutes");
  }
  const workload = realpathSync(input.workloadDir);
  const harness = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const output = path.resolve(input.outputDir);
  const scratch = path.resolve(input.scratchDir);
  const roots = [workload, output, scratch];
  if (
    roots.some((root, i) =>
      roots.some((other, j) => i !== j && (root === other || root.startsWith(other + path.sep))),
    ) ||
    [output, scratch].some((root) => root === harness || root.startsWith(harness + path.sep))
  ) {
    throw new Error("Control output and scratch must be outside both checkouts and disjoint");
  }
  for (const root of [output, scratch]) {
    if (realpathSync(path.dirname(root)) !== path.dirname(root) || existsSync(root)) {
      throw new Error("Control paths require absent directories with physical parents");
    }
  }
  const checkOutput = ownedDirectory(output);
  const checkScratch = ownedDirectory(scratch);
  const checks: Record<"oracle" | "diagnostic" | "inventory", Check> = {
    oracle: { status: "unavailable" },
    diagnostic: { status: "unavailable" },
    inventory: { status: "unavailable" },
  };
  const record: Record<string, unknown> = {
    version: 1,
    kind: full ? "node-cache-workload-qualification" : "node-cache-disabled-control",
    scope: full ? "disabled-empty-seeded" : "disabled-only",
    timingAdmission: false,
    ...(!full ? { controlAttempted: false, checks } : {}),
  };
  const controls: Array<{ kind: string; status: string }> = [];
  let settled = true;
  let failure: Error | undefined;
  return withTerminalManifest(
    output,
    async () => {
      try {
        await withVitestPairDeadline(async (deadline) => {
          const definition = validateWorkloadDefinition(
            JSON.parse(readFileSync(input.definitionPath, "utf8")),
          );
          const assertSources = () => {
            const runtime = definition.runtime;
            if (
              process.version !== runtime.node ||
              process.versions.v8 !== runtime.v8 ||
              process.platform !== runtime.platform ||
              process.arch !== runtime.architecture ||
              process.versions.bun ||
              sha256(readFileSync(process.execPath)) !== runtime.executableSha256
            ) {
              throw new Error("Pinned workload runtime differs");
            }
            if (
              git(workload, ["rev-parse", "HEAD"], deadline) !== definition.workloadSha ||
              git(workload, ["rev-parse", "HEAD^{tree}"], deadline) !== definition.workloadTree ||
              git(workload, ["status", "--porcelain=v1", "--untracked-files=all"], deadline)
            ) {
              throw new Error("Pinned workload SHA/tree or clean state differs");
            }
            assertDefinitionSources(workload, definition);
          };
          assertSources();
          const assertHarness = () => {
            if (
              !/^[0-9a-f]{40}$/u.test(input.harnessSha) ||
              git(harness, ["rev-parse", "HEAD"], deadline) !== input.harnessSha ||
              git(harness, ["status", "--porcelain=v1", "--untracked-files=all"], deadline)
            ) {
              throw new Error("Control requires a clean committed harness at the explicit SHA");
            }
          };
          assertHarness();
          const harnessInputs = NODE_CACHE_DISABLED_INPUTS.map((relative) => {
            const file = path.join(harness, relative);
            if (realpathSync(file) !== file || !lstatSync(file).isFile()) {
              throw new Error("Harness input is not a physical file");
            }
            const bytes = readFileSync(file);
            const committed = git(
              harness,
              ["rev-parse", `${input.harnessSha}:${relative}`],
              deadline,
            );
            if (
              createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !==
              committed
            ) {
              throw new Error(`Harness input differs: ${relative}`);
            }
            return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
          });
          const pnpm = input.pnpmBin;
          const pnpmSha256 = hashPreparedPnpmExecutable(pnpm);
          const environment = (scope: string, enabled = false) => ({
            ...buildBenchmarkCommandEnv(
              path.join(scratch, scope, "home"),
              path.join(scratch, scope, "state"),
              { executable: pnpm, resolvedExecutable: pnpm, version: definition.pnpmVersion },
              {
                PATH: [path.dirname(pnpm), path.dirname(process.execPath), process.env.PATH]
                  .filter(Boolean)
                  .join(path.delimiter),
              },
              {
                kind: enabled ? "seeded" : "disabled",
                nodeCache: path.join(scratch, scope, "node-cache"),
              },
            ),
            COREPACK_ENABLE_NETWORK: "0",
            npm_config_offline: "true",
            pnpm_config_manage_package_manager_versions: "false",
          });
          Object.assign(record, {
            definition,
            definitionSha256: sha256(JSON.stringify(definition)),
            harnessSha: input.harnessSha,
            harnessInputs,
            pnpmExecutable: pnpm,
            pnpmSha256,
          });
          const versionLog = path.join(output, "pnpm-version.log");
          settled = false;
          const version = await runOwnedCommand({
            bin: pnpm,
            args: ["--version"],
            cwd: scratch,
            env: environment("version"),
            logPath: versionLog,
            deadline,
            timeoutMs: 10_000,
          });
          settled = true;
          if (
            version.exitCode !== 0 ||
            readFileSync(versionLog, "utf8").trim() !== definition.pnpmVersion
          ) {
            throw new Error("Prepared pnpm version differs");
          }
          const prepared = await inventoryPreparedWorkload(workload, deadline);
          writeJsonAtomic(path.join(output, "prepared-inventory.json"), prepared);
          const seed = path.join(output, "seed");
          let seedFiles: ReturnType<typeof readNodeCacheSeed> | undefined;
          for (const kind of full
            ? (["disabled", "empty", "seeded"] as const)
            : (["disabled"] as const)) {
            const controlChecks: Record<"oracle" | "diagnostic" | "inventory", Check> = full
              ? {
                  oracle: { status: "unavailable" },
                  diagnostic: { status: "unavailable" },
                  inventory: { status: "unavailable" },
                }
              : checks;
            const control: Record<string, unknown> = full
              ? {
                  ...record,
                  kind: `node-cache-${kind}-control`,
                  controlKind: kind,
                  controlAttempted: false,
                  checks: controlChecks,
                }
              : record;
            const log = path.join(output, `${kind}.log`);
            const report = path.join(output, `${kind}.vitest.json`);
            const nodeCache = path.join(scratch, kind, "node-cache");
            const args = buildNodeCacheVitestArgs(definition.lane, report);
            Object.assign(control, {
              preparedSha256: sha256(JSON.stringify(prepared)),
              args,
              argsSha256: sha256(
                JSON.stringify(buildNodeCacheVitestArgs(definition.lane, "/report/vitest.json")),
              ),
              argumentIdentity:
                "report path normalized to /report/vitest.json; only output path varies",
              diagnosticScope: full
                ? "scripts/run-vitest.mjs only; no descendant cache acceptance or timing admission"
                : "scripts/run-vitest.mjs only; no empty or seeded acceptance claim",
            });
            try {
              deadline.throwIfExpired();
              checkOutput();
              checkScratch();
              if (seedFiles) {
                assertSealedSeed(seed, seedFiles);
              }
              const env = environment(kind, kind !== "disabled");
              if (kind === "seeded") {
                restoreNodeCacheSeed(seed, nodeCache);
              } else {
                mkdirSync(nodeCache);
              }
              control.controlAttempted = true;
              settled = false;
              const result = await runOwnedCommand({
                bin: process.execPath,
                args,
                cwd: workload,
                env: { ...env, NODE_DEBUG_NATIVE: "COMPILE_CACHE" },
                logPath: log,
                deadline,
                timeoutMs: input.timeoutMs,
              });
              settled = true;
              control.exitCode = result.exitCode;
              if (result.exitCode !== 0) {
                throw new Error(
                  `${kind === "disabled" ? "Disabled" : kind} control exited with status ${result.exitCode}`,
                );
              }
              controlChecks.oracle = { status: "failed" };
              control.execution = parseVitestExecutionReport(
                report,
                workload,
                definition.lane,
                definition.expected,
              );
              controlChecks.oracle = { status: "passed" };
              controlChecks.diagnostic = { status: "failed" };
              const text = readFileSync(log, "utf8");
              const diagnostic = parseNodeCacheDiagnostic(
                text,
                pathToFileURL(path.join(workload, "scripts/run-vitest.mjs")).href,
                nodeCache,
              );
              control.diagnostic = diagnostic;
              const files = readNodeCacheSeed(nodeCache);
              if (kind === "disabled") {
                const events = text.split("\n").filter((line) => line.includes("[compile cache]"));
                const disabledEvent = "[compile cache] Disabled by NODE_DISABLE_COMPILE_CACHE.";
                // Node logs explicit flush requests even when its disabled handler has no cache.
                const allowedEvents = new Set([
                  disabledEvent,
                  "[compile cache] module.flushCompileCache() requested.",
                  "[compile cache] module.flushCompileCache() finished.",
                ]);
                if (
                  diagnostic ||
                  files.length ||
                  !events.includes(disabledEvent) ||
                  events.some((line) => !allowedEvents.has(line))
                ) {
                  throw new Error("Disabled control generated cache activity");
                }
              } else if (
                diagnostic?.state !== (kind === "seeded" ? "accepted" : "not initialized") ||
                diagnostic.read !== (kind === "seeded" ? "hit" : "missing") ||
                !files.some((file) => file.path === diagnostic.cacheFile && file.bytes > 0) ||
                (kind === "seeded" &&
                  !seedFiles?.some((file) => file.path === diagnostic.cacheFile && file.bytes > 0))
              ) {
                throw new Error(`${kind} control lacks required launcher cache evidence`);
              }
              controlChecks.diagnostic = { status: "passed" };
            } catch (error) {
              failure = error instanceof Error ? error : new Error(String(error));
            }
            if (settled && !deadline.signal.aborted && Date.now() < deadline.deadlineAt) {
              try {
                if (hashPreparedPnpmExecutable(pnpm) !== pnpmSha256) {
                  throw new Error("Prepared pnpm bytes changed");
                }
                const delta = preparedInventoryDelta(
                  prepared,
                  await inventoryPreparedWorkload(workload, deadline),
                );
                control.inventory = delta;
                controlChecks.inventory = { status: "failed" };
                if (delta.beforeSha256 !== delta.afterSha256) {
                  throw new Error("Prepared workload changed during control");
                }
                assertSources();
                assertHarness();
                for (const entry of harnessInputs) {
                  const file = path.join(harness, entry.path);
                  if (realpathSync(file) !== file || sha256(readFileSync(file)) !== entry.sha256) {
                    throw new Error(`Harness input changed: ${entry.path}`);
                  }
                }
                if (seedFiles) {
                  assertSealedSeed(seed, seedFiles);
                }
                deadline.throwIfExpired();
                controlChecks.inventory = { status: "passed" };
              } catch (error) {
                control.inventoryError = errorText(error);
                failure ??= error instanceof Error ? error : new Error(String(error));
              }
            } else {
              control.inventoryError = settled
                ? "Aggregate deadline expired; workload not inspected"
                : "Child settlement uncertain; workload not inspected";
              failure ??= new Error(String(control.inventoryError));
            }
            if (!failure && kind === "empty") {
              try {
                deadline.throwIfExpired();
                restoreNodeCacheSeed(nodeCache, seed);
                seedFiles = readNodeCacheSeed(seed);
                sealSeed(seed);
                assertSealedSeed(seed, seedFiles);
                deadline.throwIfExpired();
                record.seed = {
                  files: seedFiles,
                  sha256: sha256(JSON.stringify(seedFiles)),
                  fileMode: "0400",
                  directoryMode: "0500",
                };
              } catch (error) {
                failure = error instanceof Error ? error : new Error(String(error));
              }
            }
            for (const [artifact, file] of [
              ["log", log],
              ["report", report],
            ] as const) {
              const field = `${artifact}Sha256`;
              control[field] = null;
              try {
                const stat = lstatSync(file, { throwIfNoEntry: false });
                if (stat) {
                  if (!stat.isFile()) {
                    throw new Error(`${artifact} artifact is not a regular file`);
                  }
                  control[field] = sha256(readFileSync(file));
                }
              } catch (error) {
                control[`${artifact}HashError`] = errorText(error);
                failure ??= error instanceof Error ? error : new Error(String(error));
              }
            }
            if (full) {
              for (const check of Object.values(controlChecks)) {
                if (check.status !== "passed") {
                  check.reason = failure?.message ?? "Not reached";
                }
              }
              Object.assign(control, {
                status: failure ? "failure" : "success",
                processTreeSettled: settled,
                error: failure?.message ?? null,
                seedSha256: seedFiles ? sha256(JSON.stringify(seedFiles)) : null,
              });
              checkOutput();
              writeJsonAtomic(path.join(output, `${kind}.json`), control);
              controls.push({ kind, status: String(control.status) });
            }
            if (failure) {
              throw failure;
            }
          }
        }, input.timeoutMs);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        if (settled) {
          try {
            checkScratch();
            rmSync(scratch, { recursive: true });
            record.cleanup = "removed-owned-scratch";
          } catch (error) {
            failure ??= error instanceof Error ? error : new Error(String(error));
          }
        } else {
          record.cleanup = "retained-uncertain-child";
        }
        if (!full) {
          for (const check of Object.values(checks)) {
            if (check.status !== "passed") {
              check.reason = failure?.message ?? "Not reached";
            }
          }
        }
        Object.assign(record, {
          status: failure ? "failure" : "success",
          processTreeSettled: settled,
          error: failure?.message ?? null,
        });
        checkOutput();
        if (full) {
          record.controls = controls;
        }
        writeJsonAtomic(path.join(output, full ? "qualification.json" : "disabled.json"), record);
      }
      if (failure) {
        throw failure;
      }
      return record;
    },
    checkOutput,
  );
}
