import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  CLI_HISTORY_CHANGED_BEFORE_PREPARATION,
  isKnownCliHistoryBoundary,
  runWithCliHistoryWriter,
  type CliHistoryBoundary,
  type CliHistoryWriter,
} from "../../config/sessions/cli-history-boundary.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  readSessionTranscriptWatermark,
  resolveSessionTranscriptDatabasePath,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import {
  captureIncognitoSessionHistoryBinding,
  withIncognitoSessionActor,
} from "../../config/sessions/session-incognito-binding.js";
import {
  sessionEntryCommitGuardOptions,
  composeSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "../../config/sessions/session-transcript-read-source.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { hasLiveAgentRunContext } from "../../infra/agent-run-registry.js";
import { bindAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { buildSessionContext, SessionManager } from "../sessions/session-manager.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";
import type { PreparedCliRunContext } from "./types.js";

/**
 * History belongs to the local transcript, not the latest native handle. Cover only
 * a proven-empty start or the contiguous events of the previously admitted CLI run.
 * An account transition, old-runtime write, import or unknown legacy prefix stays
 * unknown until an explicitly empty context starts a new history boundary.
 */
export async function prepareCliHistoryBoundary(
  params: PreparedCliRunContext["params"],
  identity: { credential?: AuthProfileCredential },
): Promise<CliHistoryWriter | undefined> {
  try {
    return await prepareCliHistoryBoundaryOnce(params, identity);
  } catch (error) {
    if (
      params.abortSignal?.aborted ||
      !(error instanceof Error) ||
      error.message !== CLI_HISTORY_CHANGED_BEFORE_PREPARATION
    ) {
      throw error;
    }
  }
  // Settlement can move the tip after planning. Nothing committed; reread once.
  return prepareCliHistoryBoundaryOnce(params, identity);
}

async function prepareCliHistoryBoundaryOnce(
  params: PreparedCliRunContext["params"],
  identity: { credential?: AuthProfileCredential },
): Promise<CliHistoryWriter | undefined> {
  const source = params.sessionTarget;
  if (
    params.sessionManager ||
    !source ||
    source.sessionId !== params.sessionId ||
    (params.sessionKey !== undefined && params.sessionKey !== source.sessionKey) ||
    !resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
  ) {
    return undefined;
  }
  const requested = { ...source, storePath: resolveSessionTranscriptDatabasePath(source) };
  const admission = resolveSessionTranscriptReadFence(requested);
  const capturedAdmission = admission && structuredClone(admission);
  const assertRunCurrent = createCliRunCurrentAssertion(params);
  const assertOwned = captureOwnedTranscriptWriteAssertion(requested);
  const incognito = captureIncognitoSessionHistoryBinding(requested);
  let assertPhysicalSource = () => {};
  const plan = incognito
    ? await withIncognitoSessionActor(
        incognito.actor,
        () => {
          assertPhysicalSource = incognito.authority.assertCurrent;
          return planCliHistoryBoundary(
            params,
            identity,
            { ...requested, storePath: incognito.actor.path },
            capturedAdmission,
            () => {
              assertRunCurrent();
              incognito.authority.assertCurrent();
            },
          );
        },
        params.abortSignal,
      )
    : await withSessionTranscriptReadSource(
        requested,
        () =>
          planCliHistoryBoundary(params, identity, requested, capturedAdmission, assertRunCurrent),
        ({ scope, expectedIdentity, assertCurrent: assertReaderCurrent }) => {
          const target = { ...requested, storePath: scope.storePath };
          assertPhysicalSource = () => {
            if (expectedIdentity) {
              assertExistingDatabaseIdentity(
                target.storePath,
                expectedIdentity.key,
                expectedIdentity.birthtime,
              );
            }
          };
          return planCliHistoryBoundary(params, identity, target, capturedAdmission, () => {
            assertReaderCurrent();
            assertRunCurrent();
          });
        },
        params.abortSignal,
      );
  if (!plan) {
    return undefined;
  }
  const { target, snapshot, watermark, boundary, allowed, writerRunId } = plan;
  const assertCurrent = composeSessionSourceAssertion([assertRunCurrent], (assertSource) => {
    assertSource();
    assertPhysicalSource();
  });
  assertCurrent();
  const commitGuard = sessionEntryCommitGuardOptions(
    composeSessionSourceAssertion([
      assertCurrent,
      composeSessionSourceAssertion([assertOwned], (assertSource) => {
        // Planning may yield. Recheck foreign liveness at commit, then adopt the
        // CLI claim so a later reuse of the dead run ID remains a visible takeover.
        if (
          snapshot.activeWriterRunId !== undefined &&
          snapshot.activeWriterRunId !== writerRunId &&
          hasLiveAgentRunContext(snapshot.activeWriterRunId)
        ) {
          throw new Error("CLI history owner changed before preparation");
        }
        assertSource();
      }),
    ]),
  );
  const committed = await patchSessionEntryCore(
    target,
    (current: InternalSessionEntry) => {
      if (
        current.sessionId !== target.sessionId ||
        current.lifecycleRevision !== snapshot.lifecycleRevision ||
        current.activeWriterRunId !== snapshot.activeWriterRunId ||
        (params.expectedLifecycleRevision !== undefined &&
          current.lifecycleRevision !== params.expectedLifecycleRevision)
      ) {
        throw new Error("CLI history owner changed before preparation");
      }
      return { activeWriterRunId: writerRunId, cliHistoryBoundary: boundary };
    },
    {
      preserveActivity: true,
      skipMaintenance: true,
      onCommitted: (entry) => {
        // Binding settlement retains this detached row; publish only our committed writer adoption.
        const callerEntry: InternalSessionEntry | undefined = params.sessionEntry;
        if (
          callerEntry?.sessionId === snapshot.sessionId &&
          callerEntry.lifecycleRevision === snapshot.lifecycleRevision &&
          callerEntry.activeWriterRunId === snapshot.activeWriterRunId
        ) {
          callerEntry.activeWriterRunId = entry.activeWriterRunId;
        }
      },
      ...commitGuard,
      workerGuard: {
        ...commitGuard.workerGuard,
        cliHistory: { sessionId: target.sessionId, admission: capturedAdmission, watermark },
      },
    },
  );
  if (!committed || !allowed || boundary.state !== "known") {
    return undefined;
  }
  const assertActive = resolveAdmittedRunActiveAssertion(params.admittedRunContext);
  const assertWriterCurrent = () => {
    params.assertCurrent?.();
    if (!assertActive) {
      throw new Error("CLI history writer is no longer active");
    }
    assertActive();
  };
  const writer: CliHistoryWriter = {
    target: { ...target },
    runId: writerRunId,
    authFingerprint: boundary.authFingerprint,
    lifecycleRevision: snapshot.lifecycleRevision,
    assertCurrent: assertWriterCurrent,
    assertReadable: () => {
      assertWriterCurrent();
      assertPhysicalSource();
      // The actor publishes exact boundary/tip facts at settlement. Unbound native
      // callers retain their existing synchronous final-authority guard until P12.
      const stored: InternalSessionEntry | undefined = incognito
        ? undefined
        : loadSessionEntryReadOnly(target);
      const current = incognito ? incognito.actor.sessions.readSteering(target.sessionKey) : stored;
      const history = incognito?.actor.sessions.readCliHistory(target.sessionKey);
      const proof = incognito ? history?.boundary : stored?.cliHistoryBoundary;
      const tip = incognito ? history?.watermark : readSessionTranscriptWatermark(target);
      if (
        !current ||
        current.sessionId !== target.sessionId ||
        current.lifecycleRevision !== snapshot.lifecycleRevision ||
        current.activeWriterRunId !== writerRunId ||
        !isKnownCliHistoryBoundary(proof) ||
        proof.sessionId !== target.sessionId ||
        proof.writerRunId !== writerRunId ||
        proof.authFingerprint !== boundary.authFingerprint ||
        !tip ||
        proof.generation !== tip.generation ||
        proof.maxSeq !== tip.maxSeq
      ) {
        throw new Error("CLI history authority changed before execution");
      }
    },
  };
  const authority = getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  if (!authority) {
    throw new Error("CLI history writer is no longer active");
  }
  bindAgentRunTerminalWriteContext(authority, {
    run: (write) => runWithCliHistoryWriter(writer, write),
  });
  return writer;
}

async function planCliHistoryBoundary(
  params: PreparedCliRunContext["params"],
  identity: { credential?: AuthProfileCredential },
  target: SessionTranscriptRuntimeTarget,
  admission: UserTurnTranscriptAdmissionReceipt | undefined,
  assertCurrent: () => void,
) {
  await waitForSessionTranscriptProjection(target, params.abortSignal);
  assertCurrent();
  const facts = await readSessionTranscriptAnchorsAsync(
    target,
    {
      entryIds: [],
      contextAuthority: true,
      ...(admission ? { contextValidation: { admission } } : {}),
    },
    params.abortSignal,
  );
  assertCurrent();
  const authority = facts.contextAuthority;
  const snapshot = authority?.entry;
  if (!authority || !snapshot || snapshot.sessionId !== target.sessionId) {
    return undefined;
  }
  const { watermark } = authority;
  const priorMaxSeq = admission ? admission.rawSeq - 1 : watermark.maxSeq;
  const currentUserIsLast = !admission || watermark.maxSeq === admission.rawSeq;
  const stored = snapshot.cliHistoryBoundary;
  const credential = identity.credential;
  // Native reuse epochs intentionally tolerate identity-less OAuth and stable
  // SecretRefs. History cannot: use the resolved static credential or a named
  // OAuth account, never a profile name, reference, or opaque CLI login alone.
  const owner =
    credential?.type === "oauth"
      ? credential.accountId?.trim() || credential.email?.trim()
        ? [
            "oauth",
            credential.provider,
            credential.accountId,
            credential.email,
            credential.clientId,
            credential.enterpriseUrl,
            credential.projectId,
          ]
        : undefined
      : credential?.type === "api_key" && credential.key?.trim()
        ? ["api_key", credential.provider, credential.key]
        : credential?.type === "token" && credential.token?.trim()
          ? ["token", credential.provider, credential.token]
          : undefined;
  const fingerprint = owner
    ? sha256Hex(JSON.stringify(["cli-history-v1", normalizeProviderId(params.provider), owner]))
    : undefined;
  const writerRunId = params.expectedWriterRunId ?? params.runId;
  let allowed = Boolean(
    fingerprint &&
    currentUserIsLast &&
    params.cliSessionBinding?.forceReuse !== true &&
    isKnownCliHistoryBoundary(stored) &&
    stored.sessionId === target.sessionId &&
    stored.authFingerprint === fingerprint &&
    stored.generation === watermark.generation &&
    (stored.maxSeq === priorMaxSeq ||
      (admission && stored.writerRunId === writerRunId && stored.maxSeq === watermark.maxSeq)),
  );
  if (
    !allowed &&
    fingerprint &&
    currentUserIsLast &&
    !params.cliSessionId &&
    !params.cliSessionBinding
  ) {
    let truncated = false;
    const branch = (
      await SessionManager.openBoundedAsync(target, {
        signal: params.abortSignal,
        maxBytes: 1024 * 1024,
        maxEvents: 100,
        onTruncated: () => {
          truncated = true;
        },
      })
    ).getBranch();
    assertCurrent();
    // Bookkeeping is not a conversation. Retained reset rows, summaries, custom
    // context, missing anchors and bounded cuts must never look like a fresh start.
    allowed = !truncated && buildSessionContext(branch).messages.length === 0;
  }
  allowed &&= watermark.maxSeq === null || typeof watermark.generation === "string";
  if (!allowed && !stored) {
    return undefined;
  }
  const boundary: CliHistoryBoundary =
    allowed && fingerprint
      ? {
          version: 1,
          sessionId: target.sessionId,
          state: "known",
          authFingerprint: fingerprint,
          generation: watermark.generation,
          maxSeq: watermark.maxSeq,
          writerRunId,
        }
      : { version: 1, sessionId: target.sessionId, state: "unknown" };
  return { target, snapshot, watermark, boundary, allowed, writerRunId };
}
