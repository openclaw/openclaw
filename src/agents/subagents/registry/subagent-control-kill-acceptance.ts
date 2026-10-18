import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  waitForSessionWorkAdmissionRelease,
} from "../../../sessions/session-lifecycle-admission.js";
import type { captureSubagentCommands } from "./subagent-control-commands.js";

/** One native Stop retains acceptance, caller failure, and its cleanup observations. */
export function createSubagentKillAcceptance(params: {
  stopAcceptance: { accepted: boolean };
  assertCallerCurrent: () => void;
  assertNativeCurrent: () => void;
  ownsSessionIncarnation: () => boolean;
  isKillOwnerCurrent: () => boolean;
  commands?: ReturnType<typeof captureSubagentCommands>;
}) {
  let acceptedCallerFailure: { error: unknown } | undefined;
  const accept = (accepted: boolean) => {
    params.stopAcceptance.accepted ||= accepted;
    if (
      accepted &&
      params.commands?.owners.length &&
      !acceptedCallerFailure &&
      params.ownsSessionIncarnation() &&
      params.isKillOwnerCurrent()
    ) {
      try {
        params.assertCallerCurrent();
        params.commands.cancel(() => {
          params.assertCallerCurrent();
          params.assertNativeCurrent();
          if (!params.ownsSessionIncarnation() || !params.isKillOwnerCurrent()) {
            throw new Error("Subagent command cancellation lost its native owner.");
          }
        });
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        // Caller revocation fences fresh effects, but the accepted native claim
        // still owns settlement. A lost native owner cannot take that path.
        try {
          params.assertNativeCurrent();
        } catch (nativeError) {
          throw new AggregateError(
            [error, nativeError],
            "Subagent cancellation authority and native ownership changed",
            { cause: nativeError },
          );
        }
        acceptedCallerFailure = { error };
      }
    }
  };
  const drain = async (release: Promise<void>, isInterrupted: () => boolean): Promise<boolean> => {
    let acceptanceFailure: { error: unknown } | undefined;
    try {
      accept(isInterrupted());
    } catch (error) {
      acceptanceFailure = { error };
    }
    let released: boolean;
    try {
      // Signaling can revoke the caller synchronously. Its failed fresh-command
      // guard cannot abandon the admission release already owned by this Stop.
      released = await waitForSessionWorkAdmissionRelease(
        release,
        SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      );
    } catch (error) {
      throw acceptanceFailure
        ? new AggregateError(
            [acceptanceFailure.error, error],
            "Subagent cancellation and admission cleanup failed",
            { cause: error },
          )
        : error;
    }
    if (!acceptanceFailure) {
      try {
        accept(isInterrupted());
      } catch (error) {
        acceptanceFailure = { error };
      }
    }
    if (acceptanceFailure) {
      if (!released) {
        throw new AggregateError(
          [acceptanceFailure.error, new Error("Subagent admission cleanup is still pending.")],
          "Subagent cancellation and admission cleanup failed",
          { cause: acceptanceFailure.error },
        );
      }
      throw acceptanceFailure.error;
    }
    return released;
  };
  const finish = async <T extends { error?: string }>(
    operation: Promise<T>,
    options: { settleCommands: boolean },
  ): Promise<T> => {
    const cancellation = operation.then(
      (result) =>
        acceptedCallerFailure
          ? {
              ...result,
              error: [result.error, formatErrorMessage(acceptedCallerFailure.error)]
                .filter(Boolean)
                .join(" "),
            }
          : result,
      (error: unknown) => {
        throw acceptedCallerFailure
          ? new AggregateError(
              [acceptedCallerFailure.error, error],
              "Subagent cancellation and accepted claim settlement failed",
              { cause: error },
            )
          : error;
      },
    );
    if (!options.settleCommands) {
      // The bulk traversal retains and observes this plan across every exit.
      return await cancellation;
    }
    return await cancellation.then(
      async (result) => {
        try {
          await params.commands?.settle();
        } catch (error) {
          return {
            ...result,
            error: [result.error, `Subagent command cleanup failed: ${formatErrorMessage(error)}`]
              .filter(Boolean)
              .join(" "),
          };
        }
        return result;
      },
      async (error: unknown) => {
        try {
          await params.commands?.settle();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Subagent cancellation and command cleanup failed",
            { cause: cleanupError },
          );
        }
        throw error;
      },
    );
  };
  return {
    accept,
    drain,
    finish,
    get callerFailure() {
      return acceptedCallerFailure;
    },
  };
}
