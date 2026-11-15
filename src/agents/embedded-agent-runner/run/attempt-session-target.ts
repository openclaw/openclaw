import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
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
  const {
    runId,
    sessionId,
    sessionPromptState,
    selectedPromptTarget,
    isAttemptCurrent,
    assertActiveRun,
  } = input;
  const targetFields = ["agentId", "sessionId", "sessionKey", "storePath", "threadId"] as const;
  type RefusalReason =
    | "attempt_inactive"
    | "session_identity_changed"
    | "target_changed"
    | "source_authority_refused"
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
    if (!isAttemptCurrent()) {
      reason = "attempt_inactive";
    } else if (sessionPromptState.sessionId !== sessionId) {
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
    if (reason) {
      recordTargetRefusal(reason, field);
      throw new Error("Session target preparation outlived its attempt");
    }
  };
  return composeSessionSourceAssertion([assertActiveRun], (assertSource) => {
    assertTargetCurrent();
    try {
      assertSource();
    } catch (cause) {
      recordTargetRefusal("source_authority_refused");
      throw new Error("Session target preparation outlived its attempt", { cause });
    }
    // Source callbacks can retire this attempt or replace its selected target.
    assertTargetCurrent();
    try {
      assertActiveRun.assertScopeCurrent();
    } catch (cause) {
      recordTargetRefusal("scope_authority_refused");
      throw cause;
    }
  });
}
