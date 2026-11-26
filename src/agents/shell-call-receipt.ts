import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
} from "../../packages/agent-core/src/internal-hooks.js";
import type { ProcessSession } from "./bash-process-registry.js";
import type { ExecToolDetails } from "./bash-tools.exec-result.types.js";

export type ShellCallReceipt = { runId: string; callId: string; key: string };
const receipts = new WeakMap<object, ShellCallReceipt>();
const processReceipts = new WeakMap<ProcessSession, ShellCallReceipt>();

export function bindShellProcess(
  session: ProcessSession,
  receipt: ShellCallReceipt | undefined,
): void {
  if (receipt) {
    processReceipts.set(session, receipt);
  }
}

// The registry retains the exact same object after exit. A reused public process id
// or a poll from a different run cannot attribute an effect to this invocation.
export function markShellPollResult<T extends object>(
  result: T,
  session: ProcessSession,
  pollCallId: string,
): T {
  const receipt = processReceipts.get(session);
  if (
    receipt &&
    hasObservedExit(session) &&
    !session.cleanupUncertain &&
    !session.finalizationFailed
  ) {
    return bindResult(result, { ...receipt, callId: pollCallId });
  }
  return result;
}

function hasObservedExit(
  result: Pick<ProcessSession, "exitCode" | "exitReason" | "exitSignal" | "noOutputTimedOut">,
): boolean {
  // Remote nodes may report only an exit code. When the supervisor has a cause,
  // a kill, cancellation or memory limit cannot establish the command's effect.
  return (
    typeof result.exitCode === "number" &&
    (!result.exitReason || result.exitReason === "exit") &&
    !result.exitSignal &&
    !result.noOutputTimedOut
  );
}

function bindResult<T extends object>(result: T, receipt: ShellCallReceipt): T {
  // Each observation has its own transcript identity, including concurrent or repeated polls.
  // The shared opaque prefix is the only fact the recovery owner needs.
  const observation = { ...receipt, key: `${receipt.key}/${randomUUID()}` };
  const token = {};
  receipts.set(token, observation);
  return attachInternalToolResultProvenance(result, token);
}

export function shellCallReceipt(runId: string, callId: string): ShellCallReceipt {
  return {
    runId,
    callId,
    key: `shell-result:${randomUUID()}`,
  };
}

/** Only the native shell can bind an observed process result to its pre-dispatch identity. */
export function markShellCallResult<T extends { details: ExecToolDetails }>(
  result: T,
  receipt: ShellCallReceipt | undefined,
): T {
  const detail = result.details;
  if (
    receipt &&
    !getInternalToolResultProvenance(result) &&
    (detail.status === "completed" || detail.status === "failed") &&
    (detail.reason === "not-dispatched" ||
      detail.reason === "permission-missing" ||
      detail.reason === "policy-denied" ||
      (detail.reason !== "outcome-unknown" && !detail.timedOut && hasObservedExit(detail)))
  ) {
    return bindResult(result, receipt);
  }
  return result;
}

/** Wrappers can carry a child's private provenance; only its own terminal writer may redeem it. */
export function shellCallResultKey(
  result: unknown,
  runId: string | undefined,
  callId: string | undefined,
): string | undefined {
  const provenance = isRecord(result) ? getInternalToolResultProvenance(result) : undefined;
  const receipt = provenance && receipts.get(provenance);
  return receipt && receipt.runId === runId && receipt.callId === callId ? receipt.key : undefined;
}
