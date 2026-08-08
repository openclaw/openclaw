import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  persistCompletedBootstrapTurn,
  trackPendingBootstrapCompletionSettlement,
} from "./bootstrap-files.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import type { SessionManager } from "./sessions/session-manager.js";

const log = createSubsystemLogger("agents/cli-bootstrap-completion");
const CLI_BOOTSTRAP_COMPLETION = Symbol("openclaw.cliBootstrapCompletion");

export type PendingCliBootstrapCompletion = {
  maintenanceSettledWithoutRewrite: Promise<boolean>;
  runId: string;
  sessionTarget: SessionTranscriptRuntimeTarget;
  sessionManager?: Pick<SessionManager, "appendCustomEntry">;
  transcriptOwner?: "caller" | "runner";
};

type CliBootstrapCompletionResult = EmbeddedAgentRunResult & {
  [CLI_BOOTSTRAP_COMPLETION]?: PendingCliBootstrapCompletion;
};

/** Carries internal lifecycle ownership through result spreads without entering serialized metadata. */
export function setPendingCliBootstrapCompletion(
  result: EmbeddedAgentRunResult,
  pending: PendingCliBootstrapCompletion,
): void {
  // Enumerable symbols survive internal result spreads, while JSON serialization
  // ignores them so a Promise never leaks into the public run-result contract.
  (result as CliBootstrapCompletionResult)[CLI_BOOTSTRAP_COMPLETION] = pending;
}

/** Finalizes a pending marker only after every transcript-rewrite owner reports stable state. */
export function finalizePendingCliBootstrapCompletion(params: {
  result: EmbeddedAgentRunResult;
  transcriptStable: boolean;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  sessionManager?: Pick<SessionManager, "appendCustomEntry">;
  runId?: string;
  isStillEligible?: () => boolean;
}): Promise<boolean> {
  const result = params.result as CliBootstrapCompletionResult;
  const pending = result[CLI_BOOTSTRAP_COMPLETION];
  delete result[CLI_BOOTSTRAP_COMPLETION];
  const sessionTarget = params.sessionTarget ?? pending?.sessionTarget;
  const runId = params.runId ?? pending?.runId;
  const settlement = (async () => {
    try {
      if (
        result.meta.bootstrapContextCompletionPending !== true ||
        !params.transcriptStable ||
        params.isStillEligible?.() === false
      ) {
        return false;
      }
      if (pending && !(await pending.maintenanceSettledWithoutRewrite)) {
        return false;
      }
      if (params.isStillEligible?.() === false || !sessionTarget || !runId) {
        return false;
      }
      persistCompletedBootstrapTurn({
        sessionTarget,
        sessionManager: params.sessionManager ?? pending?.sessionManager,
        runId,
        runner: "cli",
      });
      return true;
    } catch (error) {
      log.warn(`failed to finalize CLI bootstrap completion entry: ${formatErrorMessage(error)}`);
      return false;
    }
  })();
  if (sessionTarget) {
    // Delivery may finish first, but the next turn must observe the settled marker decision.
    trackPendingBootstrapCompletionSettlement(sessionTarget, settlement);
  }
  return settlement;
}

/** Finalizes only markers whose transcript was committed inside the CLI runner. */
export function finalizeRunnerOwnedPendingCliBootstrapCompletion(params: {
  result: EmbeddedAgentRunResult;
  transcriptStable: boolean;
  isStillEligible?: () => boolean;
}): Promise<boolean> | undefined {
  const pending = (params.result as CliBootstrapCompletionResult)[CLI_BOOTSTRAP_COMPLETION];
  if (pending?.transcriptOwner !== "runner") {
    return undefined;
  }
  return finalizePendingCliBootstrapCompletion(params);
}
