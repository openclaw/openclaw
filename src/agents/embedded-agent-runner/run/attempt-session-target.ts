import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { SessionWorkStartChangedError } from "../../../config/sessions/work-start-error.js";
import type { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { log } from "../logger.js";
import type { PreparedEmbeddedAttemptDispatchInput } from "./execution-context.js";

type SessionPromptState = PreparedEmbeddedAttemptDispatchInput["sessionPromptState"];

/** Captures the attempt's target fence and its first refusal independently of terminal cleanup. */
export function createPreparedSessionTargetAssertion(input: {
  runId: string;
  sessionId: string;
  sessionPromptState: SessionPromptState;
  selectedPromptTarget: Partial<NonNullable<SessionPromptState["sessionTarget"]>>;
  isAttemptCurrent: () => boolean;
  assertActiveRun: NonNullable<ReturnType<typeof resolveAdmittedRunActiveAssertion>>;
}) {
  const { runId, sessionId, isAttemptCurrent, assertActiveRun } = input;
  const target: {
    current: Pick<typeof input, "sessionPromptState" | "selectedPromptTarget"> | undefined;
  } = {
    current: {
      sessionPromptState: input.sessionPromptState,
      selectedPromptTarget: input.selectedPromptTarget,
    },
  };
  const targetFields = ["agentId", "sessionId", "sessionKey", "storePath", "threadId"] as const;
  type RefusalReason =
    | "attempt_inactive"
    | "session_identity_changed"
    | "target_changed"
    | "scope_authority_refused";
  let refusalRecorded = false;
  const recordTargetRefusal = (reason: RefusalReason, field?: (typeof targetFields)[number]) => {
    // Retained callbacks can refuse after terminal publication. Keep the first
    // boundary fact here, without serializing target values or source errors.
    if (!refusalRecorded) {
      refusalRecorded = true;
      log.warn("session target preparation refused", {
        runId,
        reason,
        ...(field ? { field } : {}),
      });
    }
  };
  const assertTargetCurrent = () => {
    let reason: RefusalReason | undefined;
    let field: (typeof targetFields)[number] | undefined;
    if (!isAttemptCurrent() || !target.current) {
      reason = "attempt_inactive";
    } else {
      const { sessionPromptState, selectedPromptTarget } = target.current;
      if (sessionPromptState.sessionId !== sessionId) {
        reason = "session_identity_changed";
      } else {
        field = targetFields.find(
          (candidate) =>
            sessionPromptState.sessionTarget?.[candidate] !== selectedPromptTarget[candidate],
        );
        if (field) {
          reason = "target_changed";
        }
      }
    }
    if (reason) {
      recordTargetRefusal(reason, field);
      throw new SessionWorkStartChangedError("Session target preparation outlived its attempt");
    }
  };
  // Admission checked the run's source once; here only Stop, the run lifetime and the
  // selected target are current. Session row predicates still reach the writer.
  const assertCurrent = composeSessionSourceAssertion([assertActiveRun], () => {
    assertTargetCurrent();
    try {
      assertActiveRun.assertScopeCurrent();
    } catch (cause) {
      recordTargetRefusal("scope_authority_refused");
      throw new SessionWorkStartChangedError("Session target preparation outlived its attempt", {
        cause,
      });
    }
  });
  return {
    assertCurrent,
    [Symbol.dispose]() {
      // Retained transcript guards must keep refusing without retaining the
      // completed prompt owner and its snapshot-bearing run parameters.
      target.current = undefined;
    },
  };
}
