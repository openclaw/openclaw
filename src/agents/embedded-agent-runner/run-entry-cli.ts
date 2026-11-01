import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import {
  readSessionEntryInWorker,
  readSessionEntryReadOnlyInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type {
  CliSessionBinding,
  InternalSessionEntry as SessionEntry,
} from "../../config/sessions/types.js";
import {
  persistCliSessionBindingResult,
  persistStoppedFirstCliSessionInStore,
} from "../cli-session-store.js";
import { getCliSessionBinding } from "../cli-session.js";
import type { ModelFallbackResultClassification } from "../model-fallback-attempt.js";
import { createAgentRunSupersededAbortError } from "../run-termination.js";
import { withLocalSessionPlacementTurnSettlement } from "../session-placement-admission.js";
import type { LocalTurnPlacementClaim } from "../session-placement-admission.types.js";
import { deriveSessionTotalTokens } from "../usage.js";
import type { CompactionAccountingFact } from "./run/internal-params.js";
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
    onCompactionAccounting?: (fact: CompactionAccountingFact) => void;
  },
  run: (candidate: {
    sessionEntry: SessionEntry | undefined;
    cliSessionBinding: ReturnType<typeof getCliSessionBinding>;
    assertSettlementCurrent: SessionSourceAssertion;
    settleResult: (settlement: CliCandidateSettlement) => Promise<EmbeddedAgentRunResult>;
    persistStoppedFirstSession: (
      settlement: Omit<CliCandidateSettlement, "result" | "preserveBinding"> & {
        binding: CliSessionBinding;
      },
    ) => Promise<void>;
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
      // History preparation publishes its writer into this candidate's working row.
      let contextEntry = sessionEntry ? { ...sessionEntry } : undefined;
      const runResult = await run({
        sessionEntry: contextEntry,
        cliSessionBinding: getCliSessionBinding(sessionEntry, params.provider),
        assertSettlementCurrent,
        settleResult: async ({ result, expectedSession, sessionStore, preserveBinding }) => {
          contextEntry = expectedSession;
          const classification = params.classifyResult?.(result);
          if (classification && result.meta.agentMeta?.clearCliSessionBinding !== true) {
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
            preserveBinding,
            assertSettlementCurrent,
            abortSignal: params.admission?.abortSignal,
          });
        },
        persistStoppedFirstSession: ({ binding, expectedSession, sessionStore }) =>
          persistStoppedFirstCliSessionInStore({
            agentId: params.claim.agentId,
            provider: params.provider,
            sessionKey: target?.sessionKey,
            storePath: target?.storePath,
            binding,
            expectedSession,
            sessionStore,
            assertSettlementCurrent,
          }),
      });
      if (target && contextEntry) {
        params.onCompactionAccounting?.({
          kind: "durable",
          count: 0,
          target: {
            ...target,
            sessionId: contextEntry.sessionId,
            lifecycleRevision: contextEntry.lifecycleRevision,
            activeWriterRunId: contextEntry.activeWriterRunId,
          },
          currentContextSnapshot:
            runResult.meta.providerStarted === false
              ? undefined
              : {
                  tokens: deriveSessionTotalTokens({
                    lastCallUsage: runResult.meta.agentMeta?.lastCallUsage,
                    promptTokens: runResult.meta.agentMeta?.promptTokens,
                  }),
                },
        });
      }
      return runResult;
    },
    { ...params.admission, sessionTarget: params.sessionTarget },
  );
}
