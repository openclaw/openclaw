import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { logWarn } from "../logger.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { ProcessExtinctionResult } from "../process/supervisor/types.js";
import { adoptExecSurvivors } from "./bash-process-adopted.js";
import { appendOutput, type ProcessSession } from "./bash-process-registry.js";
import { joinExecFailureOutput, type ExecProcessOutcome } from "./bash-tools.exec-output.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

const UNCONFIRMED_DESCENDANT_CLEANUP_NOTE =
  "OpenClaw could not confirm that every process started by this command stopped; a detached process (such as a daemon or tmux server) may still be running. Use background: true for long-running services.";

function withNote(
  session: ProcessSession,
  outcome: ExecProcessOutcome,
  note: string,
): ExecProcessOutcome {
  appendOutput(session, "stderr", `\n${note}\n`);
  return { ...outcome, aggregated: joinExecFailureOutput(outcome.aggregated, note) };
}

/**
 * Foreground ends when the root exits. A normal exit hands off what the command
 * left running (`&`, nohup, setsid, daemons) and names it in the result. Every
 * other outcome, and strict scopes without hand-off, still stop the whole tree.
 */
export async function settleHostExecDescendants(
  session: ProcessSession,
  managedRun: ManagedRun,
  outcome: ExecProcessOutcome,
): Promise<ExecProcessOutcome> {
  const handsOff =
    managedRun.releasesOnRootExit === true &&
    !session.requestCancelled &&
    (outcome.exitReason === "exit" || outcome.exitReason === "signal");
  if (!handsOff) {
    managedRun.cancel();
  }
  let finalOutcome = outcome;
  let extinction: ProcessExtinctionResult | undefined;
  try {
    extinction = await managedRun.waitForExtinction?.();
  } catch (error) {
    if (outcome.status !== "completed" || session.requestCancelled) {
      throw error;
    }
    // The observed exit stays the result. A descendant that left the owned
    // group (e.g. a daemonized tmux server) only leaves cleanup unconfirmed.
    session.cleanupUncertain = true;
    recordAgentCleanupFailure();
    logWarn(
      `exec: descendant cleanup after completion was not confirmed (${redactToolPayloadText(formatErrorMessage(error))}).`,
    );
    finalOutcome = withNote(session, outcome, UNCONFIRMED_DESCENDANT_CLEANUP_NOTE);
  }
  session.cleanupUncertain ||= extinction?.status === "uncertain";
  if (extinction?.status === "released" && extinction.survivors.length > 0) {
    const lines = await adoptExecSurvivors(session, extinction.survivors);
    if (lines.length > 0) {
      finalOutcome = withNote(session, finalOutcome, lines.join("\n"));
    }
  }
  if (session.requestCancelled && session.cleanupUncertain) {
    throw new Error("Command descendant cleanup could not be confirmed");
  }
  return finalOutcome;
}
