import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { retainGatewayOperatorInvocation } from "../../gateway/operator-run-invocation.js";
import { prepareSessionParticipationRun } from "../../gateway/session-principal-run-authority.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  intersectParticipationCeilings,
  sessionParticipationCeiling,
  type ParticipationCeiling,
} from "../participation-ceiling.js";
import { resolveSubagentCompletionParticipation } from "../subagents/registry/subagent-child-owner-match.js";
import { getSubagentRunsForChildSession } from "../subagents/registry/subagent-registry-memory.js";
import type { AgentCommandOpts } from "./types.js";

/** Only verified private completion sources can cap a new turn in an ordinary parent. */
async function completionParticipation(params: {
  opts: AgentCommandOpts;
  agentId: string;
  sessionKey?: string;
  sessionId: string;
  assertCurrent: () => void;
}): Promise<ParticipationCeiling | undefined> {
  const handoff = params.opts.trustedInternalHandoff;
  if (!handoff) {
    return undefined;
  }
  if (
    handoff.targetSessionKey !== params.sessionKey ||
    handoff.targetSessionId !== params.sessionId ||
    handoff.settleBatch?.isCurrent() === false
  ) {
    throw new Error("Participation completion target changed.");
  }
  const keys = handoff.settleBatch?.sourceSessionKeys ?? [handoff.sourceSessionKey];
  const ceilings: Array<ParticipationCeiling | undefined> = [];
  for (const sessionKey of keys) {
    const entry = await readSessionEntryReadOnlyInWorker(
      {
        agentId: params.agentId,
        sessionKey,
        projection: "full",
      },
      params.assertCurrent,
    );
    params.assertCurrent();
    const ceiling = resolveSubagentCompletionParticipation(
      getSubagentRunsForChildSession(sessionKey, params.agentId),
      entry,
      handoff.participationCeiling,
    );
    if (
      ceiling &&
      (!entry ||
        (!handoff.settleBatch && entry.sessionId !== handoff.sourceSessionId) ||
        (entry.completionOwnerSessionKey ?? entry.spawnedBy) !== params.sessionKey)
    ) {
      throw new Error("Participation completion has no exact child lineage.");
    }
    ceilings.push(ceiling);
  }
  if (ceilings.some(Boolean) && ceilings.some((ceiling) => !ceiling)) {
    throw new Error("Participant and owner completions require separate turns.");
  }
  return ceilings.reduce(intersectParticipationCeilings, undefined);
}

/** One source owner serves direct commands, child restarts and private completion turns. */
export async function prepareCommandParticipation(params: {
  opts: AgentCommandOpts;
  agentId: string;
  sessionKey?: string;
  sessionId: string;
  entry?: SessionEntry;
  assertCurrent: () => void;
}) {
  const completion = await completionParticipation(params);
  const ceiling = intersectParticipationCeilings(
    sessionParticipationCeiling(params.entry),
    intersectParticipationCeilings(params.opts.participationCeiling, completion),
  );
  if (!ceiling?.source) {
    return undefined;
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.resolveGatewayContext?.() ?? scope?.context;
  if (!context) {
    throw new Error("Participant children require the original running Gateway.");
  }
  const prepared = await prepareSessionParticipationRun({
    context,
    agentId: params.agentId,
    entry: params.entry,
    turnCeiling: ceiling,
    assertCurrent: params.assertCurrent,
  });
  if (!prepared) {
    throw new Error("Participant source is unavailable.");
  }
  const original = params.opts.operatorAuthority;
  return original
    ? retainGatewayOperatorInvocation(
        {
          authority: original,
          release: original.retain?.() ?? (() => {}),
        },
        {
          assertCurrent: prepared.authority.assertCurrent,
          signal: prepared.authority.signal,
          participationAuthority: prepared.authority,
          release: prepared.release,
        },
      )
    : prepared;
}
