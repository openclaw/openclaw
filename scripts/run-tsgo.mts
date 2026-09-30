// Runs tsgo through local resource policy and sparse-checkout guards.
import type { ChildProcess, StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { readFlagValue } from "./lib/arg-utils.mts";
import { parseStaticDiagnostics } from "./lib/ci-static-check-evidence.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  applyLocalTsgoPolicy,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { readPositiveEnvInt } from "./lib/numeric-options.mjs";
import { findRepoRoot } from "./lib/repo-root.mjs";
import {
  getSparseTsgoGuardError,
  isTsgoInfoCommand,
  shouldSkipSparseTsgoGuardError,
} from "./lib/tsgo-sparse-guard.mts";

// Declared locally, as sibling scripts do, rather than imported from packages/:
// a static import there resolves before the sparse-checkout guard can report a
// missing project, turning a clean skip into ERR_MODULE_NOT_FOUND. Mirrors
// normalization-core's MAX_TIMER_TIMEOUT_MS.
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

export function resolveTsgoTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  if (!env.OPENCLAW_TSGO_TIMEOUT_MS?.trim()) {
    return undefined;
  }
  return Math.min(
    readPositiveEnvInt("OPENCLAW_TSGO_TIMEOUT_MS", env, MAX_TIMER_TIMEOUT_MS),
    MAX_TIMER_TIMEOUT_MS,
  );
}

/** Prepare one compiler invocation; the caller owns its process group and deadline. */
export async function prepareTsgoCommand(
  args: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const localEnv = resolveLocalCheckEnv(baseEnv);
  const sparseGuardError = getSparseTsgoGuardError(args, { cwd });
  if (sparseGuardError) {
    if (shouldSkipSparseTsgoGuardError(localEnv)) {
      console.error(sparseGuardError);
      console.error("[tsgo] skipping sparse-missing project because OPENCLAW_TSGO_SPARSE_SKIP=1");
      return null;
    }
    throw new Error(sparseGuardError);
  }

  // Subdirectories share checkout ownership, but another checkout's install never does.
  const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd: findRepoRoot(cwd) ?? cwd });
  // Sparse refusal and singleton queries must work without package source.
  // Load the canonical capacity reader only after that dependency-free preflight.
  const memoryCapacityBytes = isTsgoInfoCommand(args)
    ? undefined
    : (await import("./lib/process-memory.mts")).readProcessMemoryCapacity({}).capacityBytes;
  const { args: finalArgs, env } = applyLocalTsgoPolicy(args, localEnv, {
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    memoryCapacityBytes,
  });
  let timeoutMs: number | undefined;
  try {
    timeoutMs = resolveTsgoTimeoutMs(env);
  } catch {
    throw new Error(
      `[tsgo] OPENCLAW_TSGO_TIMEOUT_MS must be plain decimal digits with no leading zero, sign, exponent, or decimal point, between 1 and ${Number.MAX_SAFE_INTEGER}; got ${env.OPENCLAW_TSGO_TIMEOUT_MS}. Unset it to disable the watchdog.`,
    );
  }
  return {
    args: finalArgs,
    bin: tsgoPath,
    cwd,
    env,
    shell: process.platform === "win32",
    timeoutMs,
  };
}

/** The caller holds artifact ownership until this compiler and its output are joined. */
export async function runPreparedTsgoCommand(
  command: NonNullable<Awaited<ReturnType<typeof prepareTsgoCommand>>>,
  evidence: { evidenceId?: string; onEvidence?: () => void } = {},
): Promise<number> {
  try {
    const tsBuildInfoFile = readFlagValue(command.args, "--tsBuildInfoFile");
    if (tsBuildInfoFile) {
      fs.mkdirSync(path.dirname(path.resolve(command.cwd, tsBuildInfoFile)), { recursive: true });
    }
    // Managed cleanup forwards SIGTERM before bounded SIGKILL escalation, then
    // joins the compiler group and output before reporting a timeout.
    const config = readFlagValue(command.args, "-p") ?? readFlagValue(command.args, "--project");
    const capture =
      command.env.OPENCLAW_CI_STATIC_EVIDENCE === "1" &&
      process.platform !== "win32" &&
      evidence.evidenceId !== undefined &&
      config !== undefined;
    const outputs: Buffer[][] = [[], []];
    const forwarding: Promise<void>[] = [];
    let capturedBytes = 0;
    let overflow = false;
    let interrupted = false;
    const code = await runManagedCommand({
      ...command,
      args: capture ? [...command.args, "--pretty", "false"] : command.args,
      requireProcessTreeExit: process.platform !== "win32",
      ...(capture
        ? {
            stdio: ["inherit", "pipe", "pipe"] satisfies StdioOptions,
            onSignal: () => {
              interrupted = true;
            },
            onReady: (child: ChildProcess) => {
              for (const [index, source] of [child.stdout, child.stderr].entries()) {
                if (!source) {
                  throw new Error("Missing compiler output pipe");
                }
                const target = index === 0 ? process.stdout : process.stderr;
                const output = new Writable({
                  write(chunk: Buffer, encoding, callback) {
                    capturedBytes += chunk.byteLength;
                    if (capturedBytes <= 1024 * 1024) {
                      outputs[index]!.push(chunk);
                    } else {
                      overflow = true;
                    }
                    target.write(chunk, encoding, callback);
                  },
                });
                const joined = finished(output);
                void joined.catch(() => {});
                forwarding.push(joined);
                source.pipe(output);
              }
            },
          }
        : {}),
    });
    await Promise.all(forwarding);
    const stdout = Buffer.concat(outputs[0]!).toString("utf8");
    const stderr = Buffer.concat(outputs[1]!).toString("utf8");
    const diagnostics = capture && !overflow && parseStaticDiagnostics(stdout, "tsgo");
    if (
      capture &&
      !interrupted &&
      !overflow &&
      stderr === "" &&
      ((code === 0 && stdout.trim() === "") ||
        (code === 2 && diagnostics && diagnostics.length > 0))
    ) {
      console.log(
        `[ci-static:tsgo:leaf] ${JSON.stringify({ version: 1, id: evidence.evidenceId, config, exitCode: code, stdout, stderr })}`,
      );
      evidence.onEvidence?.();
    }
    return code;
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code !== "ETIMEDOUT") {
      throw error;
    }
    console.error(
      `[tsgo] no completion after ${command.timeoutMs}ms; killed the tsgo process tree. Raise OPENCLAW_TSGO_TIMEOUT_MS for intentionally longer builds, or unset it to disable the watchdog.`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  let command: Awaited<ReturnType<typeof prepareTsgoCommand>>;
  try {
    command = await prepareTsgoCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (!command) {
    return;
  }
  // Preflight must refuse or skip before installed bootstrap dependencies load.
  const { withDistArtifactOwnership } = await import("./lib/dist-artifact-ownership.mts");
  const id = randomUUID();
  const evidenceId = `${id}:0`;
  let verified = false;
  process.exitCode = await withDistArtifactOwnership(command.cwd, () =>
    runPreparedTsgoCommand(command, {
      evidenceId,
      onEvidence: () => {
        verified = true;
      },
    }),
  );
  if (verified) {
    console.log(
      `[ci-static:tsgo:completion] ${JSON.stringify({ version: 1, id, planned: 1, completed: 1, leaves: [evidenceId] })}`,
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
