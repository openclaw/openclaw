import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { runCrabboxCommand, type CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { nonEmptyString } from "./crabbox-worker-profile.js";
import { WARM_IMAGE_COMMAND_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";
import type { WarmImageRecord } from "./crabbox-worker-warm-image-store.js";

const CHECKPOINT_ID_PATTERN = /^chk_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export class CrabboxCheckpointCreateError extends Error {
  private readonly notSubmitted?: { provider: string; leaseId: string };

  static wasNotSubmitted(error: unknown, context: { provider: string; id: string }): boolean {
    return (
      error instanceof CrabboxCheckpointCreateError &&
      error.notSubmitted?.provider === context.provider &&
      error.notSubmitted.leaseId === context.id
    );
  }

  constructor(result: SpawnResult) {
    super(crabboxCommandError("checkpoint create", result).message);
    if (
      result.termination !== "exit" ||
      result.code === null ||
      result.code === 0 ||
      result.killed ||
      result.signal !== null ||
      (result.cleanup !== undefined && result.cleanup !== "normal") ||
      result.outputLimitExceeded ||
      result.outputErrorStream ||
      result.stdoutTruncatedBytes ||
      result.stderrTruncatedBytes ||
      result.stdout.length > 4096
    ) {
      return;
    }
    try {
      const record = parseCheckpointJson(result.stdout, "create");
      if (
        Object.keys(record).length === 6 &&
        record.schema === "crabbox.checkpoint.create.failure.v1" &&
        record.outcome === "not_submitted" &&
        record.localReservation === "removed" &&
        typeof record.provider === "string" &&
        typeof record.leaseId === "string" &&
        typeof record.checkpointId === "string" &&
        CHECKPOINT_ID_PATTERN.test(record.checkpointId)
      ) {
        this.notSubmitted = { provider: record.provider, leaseId: record.leaseId };
      }
    } catch {
      // Old, malformed, or incomplete failure output retains capture uncertainty.
    }
  }
}

function parseCheckpointJson(stdout: string, action: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Crabbox checkpoint ${action} returned invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Crabbox checkpoint ${action} returned an invalid record`);
  }
  return parsed;
}

export function parseCreatedCheckpoint(
  stdout: string,
  leaseId: string,
): Pick<WarmImageRecord, "checkpointId" | "kind" | "state"> {
  const record = parseCheckpointJson(stdout, "create");
  const checkpointId = nonEmptyString(record.id);
  const kind = nonEmptyString(record.kind);
  const nativeState = isRecord(record.native) ? nonEmptyString(record.native.state) : undefined;
  if (
    !checkpointId ||
    !CHECKPOINT_ID_PATTERN.test(checkpointId) ||
    !kind ||
    record.leaseId !== leaseId ||
    !nativeState
  ) {
    throw new Error("Crabbox checkpoint create returned an invalid native checkpoint");
  }
  // This parser consumes only successful `checkpoint create --wait` results.
  // Crabbox owns readiness; provider-native state names are not a portable readiness signal.
  return { checkpointId, kind, state: "available" };
}

export function parseForkedCheckpoint(
  stdout: string,
  expected: { checkpointId: string; leaseId: string; provider: string; slug: string },
): void {
  const fork = parseCheckpointJson(stdout, "fork");
  if (
    fork.checkpointId !== expected.checkpointId ||
    fork.leaseId !== expected.leaseId ||
    fork.provider !== expected.provider ||
    fork.slug !== expected.slug ||
    !nonEmptyString(fork.workdir)
  ) {
    throw new Error("Crabbox checkpoint fork returned an invalid lease identity");
  }
}

export function parseCheckpointAvailability(stdout: string): "available" | "pending" | "missing" {
  const record = parseCheckpointJson(stdout, "inspect");
  if (!nonEmptyString(record.localState) || !nonEmptyString(record.nextAction)) {
    throw new Error("Crabbox checkpoint inspect returned an invalid verification record");
  }
  if (record.providerState === undefined || record.providerState === "missing") {
    return "missing";
  }
  if (typeof record.providerState !== "string") {
    throw new Error("Crabbox checkpoint inspect returned an invalid provider state");
  }
  // Provider states are native (for example Machine0 ACTIVE); verified fork actions
  // carry readiness. Docker reports available/delete, so retain that positive state.
  return record.providerState === "available" ||
    record.nextAction === "fork_or_delete" ||
    record.nextAction === "fork_restore_or_delete"
    ? "available"
    : "pending";
}

export type CheckpointContext = {
  binary: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
export type MaintenanceContext = Omit<CheckpointContext, "binary"> & {
  binaries: readonly string[];
};

export function createCheckpointCommands(runCommand: CrabboxCommandRunner) {
  const assertCurrent = (context: CheckpointContext | MaintenanceContext) => {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
  };
  const checkpointCommand = async (
    context: CheckpointContext,
    action: "create" | "delete" | "fork" | "inspect" | "scrub",
    args: string[],
    timeoutMs = WARM_IMAGE_COMMAND_TIMEOUT_MS,
    input?: string,
  ): Promise<string> => {
    assertCurrent(context);
    const result = await runCrabboxCommand({
      action: action === "scrub" ? action : `checkpoint ${action}`,
      args,
      binary: context.binary,
      runCommand,
      timeoutMs,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(input === undefined ? {} : { input }),
    });
    if (result.termination !== "exit" || result.code !== 0) {
      if (action === "create") {
        throw new CrabboxCheckpointCreateError(result);
      }
      throw crabboxCommandError(action === "scrub" ? action : `checkpoint ${action}`, result);
    }
    return result.stdout;
  };
  const deleteCheckpoint = async (
    context: CheckpointContext | MaintenanceContext,
    checkpointId: string,
    remainingMs: () => number,
  ): Promise<boolean> => {
    const binaries = "binary" in context ? [context.binary] : context.binaries;
    if (binaries.length === 0) {
      return false;
    }
    for (const [index, binary] of binaries.entries()) {
      assertCurrent(context);
      const timeoutMs = remainingMs();
      if (timeoutMs <= 0) {
        return false;
      }
      const stdout = await checkpointCommand(
        { ...context, binary },
        "delete",
        ["checkpoint", "delete", checkpointId],
        timeoutMs,
      );
      // Crabbox exits 0 with this line for ids outside its catalog; a record clears only
      // after a real deletion or once every configured executable reports it absent.
      if (
        index === binaries.length - 1 ||
        !stdout.split("\n").some((line) => line.trim() === `checkpoint absent id=${checkpointId}`)
      ) {
        return true;
      }
    }
    return false;
  };
  return { checkpointCommand, deleteCheckpoint };
}
