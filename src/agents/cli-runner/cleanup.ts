import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { recordModelFallbackStop } from "../failover-error.js";
import { runOwnedAgentCleanup } from "../run-cleanup-timeout.js";
import { cliBackendLog } from "./log.js";
import type { RunCliAgentParams } from "./types.js";

/** Release in order even after failure, preserving the last cleanup error. */
export function sequenceCliCleanups(
  ...cleanups: Array<(() => void | Promise<void>) | undefined>
): (() => Promise<void>) | undefined {
  return cleanups.reduceRight<(() => Promise<void>) | undefined>((remaining, cleanup) => {
    if (!cleanup) {
      return remaining;
    }
    return async () => {
      try {
        await cleanup();
      } finally {
        await remaining?.();
      }
    };
  }, undefined);
}

/** Join CLI cleanup; replacement requires closure before any provider can proceed. */
export async function runCliCleanup(
  params: Pick<RunCliAgentParams, "runId" | "sessionId" | "oneShotCliRun">,
  step: string,
  cleanup: () => Promise<void>,
  settlement?: "required",
): Promise<void> {
  try {
    await runOwnedAgentCleanup({ ...params, step, cleanup, settlement, log: cliBackendLog });
  } catch (error) {
    if (settlement !== "required") {
      throw error;
    }
    const failure = toErrorObject(error, "CLI resource cleanup failed");
    // A different provider must not replace resources whose previous owner is still unclosed.
    recordModelFallbackStop(failure);
    throw failure;
  }
}

/** Preserve typed and frozen errors while refusing replacement of unclosed resources. */
export function preserveCliRequiredCleanupStop(error: unknown): Error {
  const failure = error instanceof Error ? error : new Error(formatErrorMessage(error));
  recordModelFallbackStop(failure);
  return failure;
}

/** Join all preparation owners before retaining the initiating failure and terminal stop. */
export async function throwCliPreparationFailure(
  params: Pick<RunCliAgentParams, "runId" | "sessionId" | "oneShotCliRun">,
  error: unknown,
  cleanup: (() => void | Promise<void>) | undefined,
): Promise<never> {
  try {
    await runCliCleanup(
      params,
      "cli-prepare-failure",
      async () => {
        await cleanup?.();
      },
      "required",
    );
  } catch (cleanupError) {
    cliBackendLog.warn(`cli backend cleanup after prepare failure failed: ${String(cleanupError)}`);
    throw preserveCliRequiredCleanupStop(error);
  }
  throw error;
}
