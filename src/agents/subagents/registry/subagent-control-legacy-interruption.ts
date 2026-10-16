import { captureSessionWorkRunInterruptions } from "../../../sessions/session-lifecycle-admission.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import type { captureSubagentCommands } from "./subagent-control-commands.js";
import type { createSubagentKillAcceptance } from "./subagent-control-kill-acceptance.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import {
  captureSubagentEmbeddedExecution,
  captureSubagentExecution,
  captureSubagentReplyExecution,
} from "./subagent-registry-execution-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Legacy-unverified runs capture their exact embedded and reply executions before Stop. */
export async function prepareLegacySubagentKill(entry: SubagentRunRecord) {
  const legacy = resolveSubagentChildAuthority(entry).status === "legacy-unverified";
  return {
    legacy,
    embeddedExecution: legacy ? captureSubagentEmbeddedExecution(entry) : undefined,
    replyExecution: legacy ? await captureSubagentReplyExecution(entry) : undefined,
  };
}

export async function interruptLegacySubagentRun(params: {
  entry: SubagentRunRecord;
  session: SubagentKillSession;
  embeddedExecution: ReturnType<typeof captureSubagentEmbeddedExecution>;
  replyExecution: Awaited<ReturnType<typeof captureSubagentReplyExecution>>;
  captureExecution: () => ReturnType<typeof captureSubagentExecution>;
  commands: ReturnType<typeof captureSubagentCommands>;
  acceptance: ReturnType<typeof createSubagentKillAcceptance>;
  stopAcceptance: { accepted: boolean };
  assertCallerCurrent: () => void;
  assertSelectedRun: () => void;
}): Promise<"ready" | "busy" | "superseded"> {
  const { entry, session, embeddedExecution, replyExecution, acceptance, stopAcceptance } = params;
  const reason = createAgentRunDirectAbortError();
  const ownedAdmissions = captureSessionWorkRunInterruptions({
    scope: session.storePath,
    identities: [entry.childSessionKey, embeddedExecution?.sessionId, replyExecution?.sessionId],
    accept: (run) =>
      run.runId === entry.runId &&
      run.sessionKey === entry.childSessionKey &&
      run.agentId === session.agentId &&
      (!entry.childSessionIdentity?.sessionId ||
        run.sessionId === entry.childSessionIdentity.sessionId),
  });
  const captured = params.captureExecution();
  let refusedRuntimeStillCurrent: (() => boolean) | undefined;
  if (captured) {
    if (captureSubagentExecution({ entry, session })?.execution !== captured.execution) {
      return "superseded";
    }
    const alreadyAborted = captured.execution.controller.signal.aborted;
    captured.execution.controller.abort(reason);
    acceptance.accept(!alreadyAborted && captured.execution.controller.signal.aborted);
  } else if (embeddedExecution) {
    const aborted = embeddedExecution.abort();
    acceptance.accept(aborted);
    if (!aborted) {
      refusedRuntimeStillCurrent = () => {
        const current = captureSubagentEmbeddedExecution(entry);
        return current?.sessionId === embeddedExecution.sessionId;
      };
    }
  } else if (replyExecution) {
    const aborted = replyExecution.abort();
    acceptance.accept(aborted);
    if (!aborted) {
      refusedRuntimeStillCurrent = replyExecution.isCurrent;
    }
  }
  if (!stopAcceptance.accepted && params.commands) {
    acceptance.accept(
      params.commands.cancel(() => {
        params.assertCallerCurrent();
        params.assertSelectedRun();
      }),
    );
  }
  const interrupted = ownedAdmissions.map((owned) => owned.released);
  if (replyExecution?.settlement && stopAcceptance.accepted) {
    interrupted.push(replyExecution.settlement);
  }
  for (const owned of ownedAdmissions) {
    if (acceptance.callerFailure) {
      break;
    }
    params.assertCallerCurrent();
    params.assertSelectedRun();
    acceptance.accept(owned.interrupt(reason));
  }
  const drained =
    interrupted.length === 0 ||
    (await acceptance.drain(
      Promise.all(interrupted).then(() => {}),
      () => stopAcceptance.accepted,
    ));
  return !drained || refusedRuntimeStillCurrent?.() ? "busy" : "ready";
}
