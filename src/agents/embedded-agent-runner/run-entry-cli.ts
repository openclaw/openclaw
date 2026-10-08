import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import {
  readSessionEntryInWorker,
  readSessionEntryReadOnlyInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { persistCliSessionBindingResult } from "../cli-session-store.js";
import { getCliSessionBinding } from "../cli-session.js";
import type { ModelFallbackResultClassification } from "../model-fallback-attempt.js";
import { createAgentRunSupersededAbortError } from "../run-termination.js";
import { withLocalSessionPlacementTurnSettlement } from "../session-placement-admission.js";
import type { LocalTurnPlacementClaim } from "../session-placement-admission.types.js";
import type { EmbeddedAgentRunResult } from "./types.js";

type CliCandidateSettlement = Pick<
  Parameters<typeof persistCliSessionBindingResult>[0],
  "result" | "expectedSession" | "sessionStore"
> & { preserveBinding?: boolean };

/** Acquire native continuity after placement admission and settle it before releasing the turn. */
export function withAdmittedCliCandidate(
  params: {
    claim: LocalTurnPlacementClaim & { agentId: string };
    admission: Parameters<typeof withLocalSessionPlacementTurnSettlement>[2];
    provider: string;
    sessionTarget?: SessionTranscriptRuntimeTarget;
    expectedLifecycleRevision?: string;
    readMode: "writable" | "read-only";
    getSessionEntry: () => SessionEntry | undefined;
    classifyResult?: (result: EmbeddedAgentRunResult) => ModelFallbackResultClassification;
  },
  run: (candidate: {
    sessionEntry: SessionEntry | undefined;
    cliSessionBinding: ReturnType<typeof getCliSessionBinding>;
    assertSettlementCurrent: () => void;
    settleResult: (settlement: CliCandidateSettlement) => Promise<EmbeddedAgentRunResult>;
  }) => Promise<EmbeddedAgentRunResult>,
): Promise<EmbeddedAgentRunResult> {
  return withLocalSessionPlacementTurnSettlement(
    params.claim,
    async (assertSettlementCurrent) => {
      const target = params.sessionTarget;
      // Queued placement may outlive a reset; read the row only after acquiring the turn.
      const sessionEntry = target
        ? params.readMode === "writable"
          ? await readSessionEntryInWorker(
              { ...target, readConsistency: "latest" },
              assertSettlementCurrent,
            )
          : await readSessionEntryReadOnlyInWorker(target, assertSettlementCurrent)
        : params.getSessionEntry();
      assertSettlementCurrent();
      if (
        target &&
        (sessionEntry?.sessionId !== target.sessionId ||
          sessionEntry.lifecycleRevision !== params.expectedLifecycleRevision)
      ) {
        throw createAgentRunSupersededAbortError();
      }
      return run({
        sessionEntry,
        cliSessionBinding: getCliSessionBinding(sessionEntry, params.provider),
        assertSettlementCurrent,
        settleResult: async ({ result, expectedSession, sessionStore, preserveBinding }) => {
          const classification = params.classifyResult?.(result);
          if (
            preserveBinding ||
            (classification && result.meta.agentMeta?.clearCliSessionBinding !== true)
          ) {
            return result;
          }
          return persistCliSessionBindingResult({
            agentId: params.claim.agentId,
            provider: params.provider,
            sessionKey: target?.sessionKey,
            storePath: target?.storePath,
            result,
            expectedSession,
            sessionStore,
            assertSettlementCurrent,
            abortSignal: params.admission?.abortSignal,
          });
        },
      });
    },
    params.admission,
  );
}
