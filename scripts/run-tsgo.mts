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
export function prepareTsgoCommand(
  args: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const infoOnly = isTsgoInfoCommand(args);
  const hostResources = {
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
  const { args: finalArgs, env } = applyLocalTsgoPolicy(
    args,
    resolveLocalCheckEnv(baseEnv),
    hostResources,
  );

  const sparseGuardError = getSparseTsgoGuardError(finalArgs, { cwd });
  if (sparseGuardError) {
    if (shouldSkipSparseTsgoGuardError(env)) {
      console.error(sparseGuardError);
      console.error("[tsgo] skipping sparse-missing project because OPENCLAW_TSGO_SPARSE_SKIP=1");
      return null;
    }
    throw new Error(sparseGuardError);
  }

  // Subdirectories share checkout ownership, but another checkout's install never does.
  const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd: findRepoRoot(cwd) ?? cwd });
  let timeoutMs: number | undefined;
  try {
    timeoutMs = resolveTsgoTimeoutMs(env);
  } catch {
    throw new Error(
      `[tsgo] OPENCLAW_TSGO_TIMEOUT_MS must be plain decimal digits with no leading zero, sign, exponent, or decimal point, between 1 and ${Number.MAX_SAFE_INTEGER}; got ${env.OPENCLAW_TSGO_TIMEOUT_MS}. Unset it to use the 15-minute semantic-check deadline.`,
    );
  }
  return {
    infoOnly,
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
  command: NonNullable<ReturnType<typeof prepareTsgoCommand>>,
  evidence: { evidenceId?: string; onEvidence?: () => void; signal?: AbortSignal } = {},
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
    // Only singleton help/version is nonsemantic. Mixed flags and response files
    // can turn apparent queries into compilation; let the native parser own them.
    const { infoOnly, ...invocation } = command;
    const run = infoOnly
      ? runManagedCommand
      : (await import("./lib/semantic-check-admission.mts")).runSemanticCheck;
    const code = await run({
      ...invocation,
      signal: evidence.signal,
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
      !evidence.signal?.aborted &&
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
      `[tsgo] no completion after ${command.timeoutMs ?? 900_000}ms; killed the tsgo process tree. Raise OPENCLAW_TSGO_TIMEOUT_MS for intentionally longer builds, or unset it to restore the 15-minute default.`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  let command: ReturnType<typeof prepareTsgoCommand>;
  try {
    command = prepareTsgoCommand(process.argv.slice(2));
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
  const { runCancelableCommand } = await import("./lib/cancelable-command.mts");
  process.exitCode = await runCancelableCommand((signal) =>
    withDistArtifactOwnership(
      command.cwd,
      () =>
        runPreparedTsgoCommand(command, {
          signal,
          evidenceId,
          onEvidence: () => {
            verified = true;
          },
        }),
      signal,
    ),
  );
  if (verified && (process.exitCode === 0 || process.exitCode === 2)) {
    console.log(
      `[ci-static:tsgo:completion] ${JSON.stringify({ version: 1, id, planned: 1, completed: 1, leaves: [evidenceId] })}`,
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
