import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  CLI_HISTORY_CHANGED_BEFORE_PREPARATION,
  isKnownCliHistoryBoundary,
  runWithCliHistoryWriter,
  type CliExecutionHistoryWriter,
  type CliHistoryBoundary,
} from "../../config/sessions/cli-history-boundary.js";
import {
  patchSessionEntryCore,
  resolveSessionTranscriptDatabasePath,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { captureSessionActorStorageOwner } from "../../config/sessions/session-actor-storage-binding.js";
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
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import {
  isNativeCliLoginAttestationEnabled,
  readAttestedNativeCliLoginOwner,
  resolveNativeCliLoginOwner,
} from "../cli-credentials.js";
import { buildSessionContext, SessionManager } from "../sessions/session-manager.js";
import { resolveCliChildEnv } from "./execution-env.js";
import { createCliRunCurrentAssertion, resolveCliExecutionTarget } from "./execution-target.js";
import type { PreparedCliRunContext } from "./types.js";

/**
 * Another writer or lifecycle owns the session history. Local session state, not a provider
 * failure: model fallback must stop instead of replaying the turn on another candidate.
 */
class CliHistoryOwnerChangedError extends Error {
  constructor() {
    super("CLI history owner changed before preparation");
    this.name = "CliHistoryOwnerChangedError";
  }
}

/**
 * Execution layers the run's skill env overrides onto the process environment right before it
 * builds the child environment. Apply the same snapshot here, synchronously, so preparation
 * resolves the login the child will actually run under.
 */
function resolvePreparedChildEnv(
  params: PreparedCliRunContext["params"],
  preparedBackend: Parameters<typeof resolveCliChildEnv>[0],
): Record<string, string> {
  const restoreSkillEnv =
    params.skillsSnapshot && !params.controlOperation
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : undefined;
  try {
    return resolveCliChildEnv(preparedBackend, params).env;
  } finally {
    restoreSkillEnv?.();
  }
}

/** The transcript a turn may read saved inputs from: none when it runs without saved history. */
export function replayableTarget(writer: CliExecutionHistoryWriter | undefined) {
  return writer?.replaysHistory ? writer.target : undefined;
}

/**
 * History belongs to the local transcript, not the latest native handle. Cover only
 * a proven-empty start or the contiguous events of the previously admitted CLI run.
 * An account transition, old-runtime write, import or unknown legacy prefix stays
 * unknown until an explicitly empty context starts a new history boundary.
 */
export async function prepareCliHistoryBoundary(
  params: PreparedCliRunContext["params"],
  identity: {
    credential?: AuthProfileCredential;
    /**
     * The prepared backend the CLI child will run from. A native login owner is resolved only
     * from the environment it yields (resolveCliChildEnv, the same function execution spawns
     * with); without it no owner can be established and history is refused.
     */
    preparedBackend?: Parameters<typeof resolveCliChildEnv>[0];
  },
): Promise<CliExecutionHistoryWriter | undefined> {
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

/** Compaction may rewrite a covered transcript, but cannot establish account provenance. */
export async function prepareCliHistoryCompactionBoundary(
  target: SessionTranscriptRuntimeTarget,
  assertActive: () => void,
): Promise<(() => Promise<void>) | undefined> {
  const assertCurrent = composeSessionSourceAssertion([
    assertActive,
    captureOwnedTranscriptWriteAssertion(target),
  ]);
  await waitForSessionTranscriptProjection(target);
  assertCurrent();
  const before = (
    await readSessionTranscriptAnchorsAsync(target, { entryIds: [], contextAuthority: true })
  ).contextAuthority;
  assertCurrent();
  const entry = before?.entry;
  const boundary = entry?.cliHistoryBoundary;
  if (
    !before ||
    !entry ||
    entry.sessionId !== target.sessionId ||
    !isKnownCliHistoryBoundary(boundary) ||
    boundary.sessionId !== target.sessionId ||
    boundary.generation !== before.watermark.generation ||
    boundary.maxSeq !== before.watermark.maxSeq
  ) {
    return undefined;
  }
  return async () => {
    assertCurrent();
    const after = (
      await readSessionTranscriptAnchorsAsync(target, { entryIds: [], contextAuthority: true })
    ).contextAuthority;
    assertCurrent();
    if (!after) {
      return;
    }
    const guard = sessionEntryCommitGuardOptions(assertCurrent);
    await patchSessionEntryCore(
      target,
      (current) => {
        const currentBoundary = current.cliHistoryBoundary;
        if (
          current.sessionId !== entry.sessionId ||
          current.lifecycleRevision !== entry.lifecycleRevision ||
          current.activeWriterRunId !== entry.activeWriterRunId ||
          !isKnownCliHistoryBoundary(currentBoundary) ||
          currentBoundary.sessionId !== boundary.sessionId ||
          currentBoundary.authFingerprint !== boundary.authFingerprint ||
          currentBoundary.writerRunId !== boundary.writerRunId ||
          currentBoundary.generation !== boundary.generation ||
          currentBoundary.maxSeq !== boundary.maxSeq
        ) {
          return {};
        }
        return { cliHistoryBoundary: { ...boundary, ...after.watermark } };
      },
      {
        preserveActivity: true,
        skipMaintenance: true,
        ...guard,
        workerGuard: {
          ...guard.workerGuard,
          cliHistory: { sessionId: target.sessionId, watermark: after.watermark },
        },
      },
    );
  };
}

async function prepareCliHistoryBoundaryOnce(
  params: PreparedCliRunContext["params"],
  identity: Parameters<typeof prepareCliHistoryBoundary>[1],
): Promise<CliExecutionHistoryWriter | undefined> {
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
  const { credential, preparedBackend } = identity;
  const childEnv =
    !credential && preparedBackend ? resolvePreparedChildEnv(params, preparedBackend) : undefined;
  const provider = normalizeProviderId(params.provider);
  // A forwarded credential decides which account runs. Without one, the CLI runs under the
  // native login its own environment selects, unless it is node-placed and runs under the
  // node's login instead. The Gateway process environment is never the identity source.
  // The owner is the account the provider attests for that login's credential, and only when
  // the operator opted in to sending it there. It is attested before planning so no read
  // source is held across the network request.
  const nativeLogin =
    credential ||
    !childEnv ||
    !isNativeCliLoginAttestationEnabled(provider, params.config) ||
    resolveCliExecutionTarget({ params, backendId: provider }).kind === "node"
      ? undefined
      : await resolveNativeCliLoginOwner(provider, childEnv);
  if (nativeLogin) {
    assertRunCurrent();
  }
  const nativeLoginOwner = nativeLogin?.owner;
  const owner = { credential, nativeLoginOwner };
  const memory = captureSessionActorStorageOwner(requested, {
    assertCurrent: assertRunCurrent,
    authorize() {},
  });
  let assertPhysicalSource = () => {
    memory?.owner?.assertCurrent();
    memory?.binding?.actor.assertReadable();
  };
  const plan = memory
    ? await planCliHistoryBoundary(
        params,
        owner,
        { ...requested, storePath: memory.path },
        capturedAdmission,
        assertRunCurrent,
      )
    : await withSessionTranscriptReadSource(
        requested,
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
          return planCliHistoryBoundary(params, owner, target, capturedAdmission, () => {
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
    memory?.authority.assertCurrent();
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
          throw new CliHistoryOwnerChangedError();
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
        throw new CliHistoryOwnerChangedError();
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
  // The fingerprint proves only the owner attested at preparation. Each private-input
  // boundary (assertReadable), Claude's prompt hook answer and coverage commit rereads the
  // credential from the environment the child runs under
  // (execution rebinds this to the exact environment it spawns with) and accepts it only
  // if this process attested that exact credential to the same owner. These checks are
  // synchronous and never wait on the network. Run and write liveness checks do not
  // reread, so a turn costs a lookup per boundary, not one per write.
  let nativeEnv: NodeJS.ProcessEnv | undefined = childEnv;
  // Set once the run saw a login attested to someone else, or one that could not be
  // attested after the run: the run keeps going but never advances coverage, so its rows
  // stay outside the owner's replayable history.
  let detached = false;
  // A boundary that sees a credential this process has not attested yet (normally the
  // CLI's own token refresh) attests it in the background. Coverage waits until it settles.
  let pendingAttestation: Promise<void> | undefined;
  const readNativeOwner = () => {
    if (nativeEnv === undefined) {
      return undefined;
    }
    // A lookup that throws (an unreadable config root) has no owner, like any failed lookup.
    try {
      return readAttestedNativeCliLoginOwner(provider, nativeEnv);
    } catch {
      return undefined;
    }
  };
  const nativeLoginMatches = () =>
    !nativeLoginOwner ||
    (!detached && !pendingAttestation && readNativeOwner() === nativeLoginOwner);
  // Saved history must never reach an unproven login, so a turn carrying it is refused. A
  // turn without saved history runs on, as it would with no owner at all, but stops coverage.
  const checkNativeLoginBoundary = (carriesSavedHistory: boolean, message?: string) => {
    const current = !nativeLoginOwner || detached ? undefined : readNativeOwner();
    if (!nativeLoginOwner || current === nativeLoginOwner) {
      return;
    }
    if (carriesSavedHistory) {
      throw new Error(message ?? "CLI history authority changed before execution");
    }
    if (detached || current !== undefined || nativeEnv === undefined) {
      detached = true;
      return;
    }
    pendingAttestation ??= resolveNativeCliLoginOwner(provider, nativeEnv)
      .then(
        (attestation) => {
          detached ||= attestation.owner !== nativeLoginOwner;
        },
        () => {
          detached = true;
        },
      )
      .finally(() => {
        pendingAttestation = undefined;
      });
  };
  const refreshDue = () =>
    nativeLoginOwner !== undefined &&
    nativeLogin?.refreshDueAt !== undefined &&
    nativeLogin.refreshDueAt <= Date.now();
  const writer: CliExecutionHistoryWriter = {
    target: { ...target },
    runId: writerRunId,
    authFingerprint: boundary.authFingerprint,
    lifecycleRevision: snapshot.lifecycleRevision,
    bindsNativeLogin: nativeLoginOwner !== undefined,
    // Claude CLI rotates a refresh-due token before it accepts a prompt, after the send
    // check could prove it, so such a turn runs without saved history.
    replaysHistory: !refreshDue(),
    assertCurrent: assertWriterCurrent,
    assertReadable: async () => {
      assertWriterCurrent();
      assertPhysicalSource();
      const authority = memory
        ? undefined
        : (
            await readSessionTranscriptAnchorsAsync(
              target,
              { entryIds: [], contextAuthority: true },
              params.abortSignal,
            )
          ).contextAuthority;
      assertWriterCurrent();
      assertPhysicalSource();
      const facts =
        memory?.binding?.actor.target.sessionKey === target.sessionKey
          ? memory.binding.actor.snapshot(memory.authority)
          : memory?.owner?.readSession(target.sessionKey, memory.authority);
      const current = memory ? facts?.entry : authority?.entry;
      const proof = current?.cliHistoryBoundary;
      const tip = memory ? facts?.transcript.watermark : authority?.watermark;
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
      // Transports call this at their private-input boundary, so the login is rechecked last.
      checkNativeLoginBoundary(writer.replaysHistory);
    },
    // Asked once per coverage commit. A changed or unresolvable login keeps the commit's
    // rows but leaves coverage where it is, so a produced reply is never discarded. Other
    // owners cannot change during the run, so their writers carry no owner check.
    ...(nativeLoginOwner !== undefined ? { confirmsOwner: nativeLoginMatches } : {}),
    checkNativeLoginBoundary,
    bindExecutionEnv: (env, carriesSavedHistory) => {
      nativeEnv = env;
      checkNativeLoginBoundary(
        carriesSavedHistory,
        "CLI history authority changed before execution: the spawn environment selects a different Claude login than the one attested at preparation",
      );
    },
    settleNativeLogin: async () => {
      await pendingAttestation;
      // A token that entered its refresh window may have been rotated after the send check.
      // Attest whatever the child left behind so the commit checks can prove it.
      if (nativeLoginOwner && nativeEnv !== undefined && !detached && refreshDue()) {
        await resolveNativeCliLoginOwner(provider, nativeEnv).catch(() => undefined);
      }
    },
  };
  const authority = getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  if (!authority) {
    throw new Error("CLI history writer is no longer active");
  }
  bindAgentRunTerminalWriteContext(authority, {
    // Terminal bookkeeping keeps the admitted account/row facts after execution
    // is cancelled. The transcript writer still checks those facts at commit.
    run: (write) =>
      runWithCliHistoryWriter({ ...writer, assertCurrent: assertPhysicalSource }, write),
  });
  return writer;
}

async function planCliHistoryBoundary(
  params: PreparedCliRunContext["params"],
  identity: { credential?: AuthProfileCredential; nativeLoginOwner?: string },
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
  const { credential, nativeLoginOwner } = identity;
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
          : nativeLoginOwner
            ? ["native-login", nativeLoginOwner]
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
