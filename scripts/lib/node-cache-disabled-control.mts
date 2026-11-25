import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

export async function qualifyNodeCacheDisabledControl(input: Context) {
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
    kind: "node-cache-disabled-control",
    scope: "disabled-only",
    timingAdmission: false,
    controlAttempted: false,
    checks,
  };
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
          const environment = (scope: string) => ({
            ...buildBenchmarkCommandEnv(
              path.join(scratch, scope, "home"),
              path.join(scratch, scope, "state"),
              { executable: pnpm, resolvedExecutable: pnpm, version: definition.pnpmVersion },
              {
                PATH: [path.dirname(pnpm), path.dirname(process.execPath), process.env.PATH]
                  .filter(Boolean)
                  .join(path.delimiter),
              },
              { kind: "disabled", nodeCache: path.join(scratch, scope, "node-cache") },
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
          const log = path.join(output, "disabled.log");
          const report = path.join(output, "disabled.vitest.json");
          const env = environment("disabled");
          const nodeCache = path.join(scratch, "disabled", "node-cache");
          mkdirSync(nodeCache);
          const args = buildNodeCacheVitestArgs(definition.lane, report);
          Object.assign(record, {
            preparedSha256: sha256(JSON.stringify(prepared)),
            args,
            argsSha256: sha256(
              JSON.stringify(buildNodeCacheVitestArgs(definition.lane, "/report/vitest.json")),
            ),
            argumentIdentity:
              "report path normalized to /report/vitest.json; only output path varies",
            diagnosticScope: "scripts/run-vitest.mjs only; no empty or seeded acceptance claim",
          });
          try {
            record.controlAttempted = true;
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
            record.exitCode = result.exitCode;
            if (result.exitCode !== 0) {
              throw new Error(`Disabled control exited with status ${result.exitCode}`);
            }
            checks.oracle = { status: "failed" };
            record.execution = parseVitestExecutionReport(
              report,
              workload,
              definition.lane,
              definition.expected,
            );
            checks.oracle = { status: "passed" };
            checks.diagnostic = { status: "failed" };
            const text = readFileSync(log, "utf8");
            record.diagnostic = parseNodeCacheDiagnostic(
              text,
              pathToFileURL(path.join(workload, "scripts/run-vitest.mjs")).href,
              nodeCache,
            );
            const events = text.split("\n").filter((line) => line.includes("[compile cache]"));
            const disabledEvent = "[compile cache] Disabled by NODE_DISABLE_COMPILE_CACHE.";
            // Node logs explicit flush requests even when its disabled handler has no cache.
            const allowedEvents = new Set([
              disabledEvent,
              "[compile cache] module.flushCompileCache() requested.",
              "[compile cache] module.flushCompileCache() finished.",
            ]);
            if (
              record.diagnostic ||
              readNodeCacheSeed(nodeCache).length ||
              !events.includes(disabledEvent) ||
              events.some((line) => !allowedEvents.has(line))
            ) {
              throw new Error("Disabled control generated cache activity");
            }
            checks.diagnostic = { status: "passed" };
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
              record.inventory = delta;
              checks.inventory = { status: "failed" };
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
              checks.inventory = { status: "passed" };
            } catch (error) {
              record.inventoryError = errorText(error);
              failure ??= error instanceof Error ? error : new Error(String(error));
            }
          } else {
            record.inventoryError = settled
              ? "Aggregate deadline expired; workload not inspected"
              : "Child settlement uncertain; workload not inspected";
            failure ??= new Error(String(record.inventoryError));
          }
          record.logSha256 = existsSync(log) ? sha256(readFileSync(log)) : null;
          record.reportSha256 = existsSync(report) ? sha256(readFileSync(report)) : null;
          if (failure) {
            throw failure;
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
        for (const check of Object.values(checks)) {
          if (check.status !== "passed") {
            check.reason = failure?.message ?? "Not reached";
          }
        }
        Object.assign(record, {
          status: failure ? "failure" : "success",
          processTreeSettled: settled,
          error: failure?.message ?? null,
        });
        checkOutput();
        writeJsonAtomic(path.join(output, "disabled.json"), record);
      }
      if (failure) {
        throw failure;
      }
      return record;
    },
    checkOutput,
  );
}
