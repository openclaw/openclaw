import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  isKnownCliHistoryBoundary,
  runWithCliHistoryWriter,
  type CliExecutionHistoryWriter,
  type CliHistoryBoundary,
} from "../../config/sessions/cli-history-boundary.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  readSessionTranscriptWatermark,
  resolveSessionTranscriptDatabasePath,
  validateSessionTranscriptContextAdmission,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { assertOwnedTranscriptWriteCommit } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { hasLiveAgentRunContext } from "../../infra/agent-run-registry.js";
import { bindAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { readAttestedNativeCliLoginOwner, resolveNativeCliLoginOwner } from "../cli-credentials.js";
import { buildSessionContext, SessionManager } from "../sessions/session-manager.js";
import { resolveCliChildEnv } from "./execution-env.js";
import { createCliRunCurrentAssertion, resolveCliExecutionTarget } from "./execution-target.js";
import type { PreparedCliRunContext } from "./types.js";

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
    return resolveCliChildEnv(preparedBackend).env;
  } finally {
    restoreSkillEnv?.();
  }
}

/**
 * History belongs to the local transcript, not the latest native handle. Cover only
 * a proven-empty start or the contiguous events of the previously admitted CLI run.
 * An account transition, old-runtime write, import or unknown legacy prefix stays
 * unknown until an explicitly empty context starts a new history boundary.
 */
export async function prepareCliHistoryBoundary(
  params: PreparedCliRunContext["params"],
  credential: AuthProfileCredential | undefined,
  /**
   * The prepared backend the CLI child will run from. A native login owner is resolved only
   * from the environment it yields (resolveCliChildEnv, the same function execution spawns
   * with); without it no owner can be established and history is refused.
   */
  preparedBackend?: Parameters<typeof resolveCliChildEnv>[0],
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
  const target = { ...source, storePath: resolveSessionTranscriptDatabasePath(source) };
  const assertCurrent = createCliRunCurrentAssertion(params);
  await waitForSessionTranscriptProjection(target, params.abortSignal);
  assertCurrent();
  const snapshot: InternalSessionEntry | undefined = loadSessionEntryReadOnly(target);
  if (!snapshot || snapshot.sessionId !== target.sessionId) {
    return undefined;
  }
  const watermark = readSessionTranscriptWatermark(target);
  const admission = resolveSessionTranscriptReadFence(target);
  validateSessionTranscriptContextAdmission(target, admission);
  const priorMaxSeq = admission ? admission.rawSeq - 1 : watermark.maxSeq;
  const currentUserIsLast = !admission || watermark.maxSeq === admission.rawSeq;
  const stored = snapshot.cliHistoryBoundary;
  const childEnv =
    !credential && preparedBackend ? resolvePreparedChildEnv(params, preparedBackend) : undefined;
  const provider = normalizeProviderId(params.provider);
  // A forwarded credential decides which account runs. Without one, the CLI runs under the
  // native login its own environment selects, unless it is node-placed and runs under the
  // node's login instead. The Gateway process environment is never the identity source.
  // The owner is the account the provider attests for that login's credential.
  const nativeLogin =
    credential ||
    !childEnv ||
    resolveCliExecutionTarget({ params, backendId: provider }).kind === "node"
      ? undefined
      : await resolveNativeCliLoginOwner(provider, childEnv);
  if (nativeLogin) {
    assertCurrent();
  }
  const nativeLoginOwner = nativeLogin?.owner;
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
    ? sha256Hex(JSON.stringify(["cli-history-v1", provider, owner]))
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
      assertCommitAllowed: () => {
        assertCurrent();
        // Planning may yield. Recheck foreign liveness at commit, then adopt the
        // CLI claim so a later reuse of the dead run ID remains a visible takeover.
        if (
          snapshot.activeWriterRunId !== undefined &&
          snapshot.activeWriterRunId !== writerRunId &&
          hasLiveAgentRunContext(snapshot.activeWriterRunId)
        ) {
          throw new Error("CLI history owner changed before preparation");
        }
        assertOwnedTranscriptWriteCommit(target);
        validateSessionTranscriptContextAdmission(target, admission);
        const fresh = readSessionTranscriptWatermark(target);
        if (fresh.generation !== watermark.generation || fresh.maxSeq !== watermark.maxSeq) {
          throw new Error("CLI history changed before preparation");
        }
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
  // The fingerprint proves only the owner attested at preparation. Each spawn, prompt send
  // and coverage commit rereads the credential from the environment the child runs under
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
  const readNativeOwner = () =>
    nativeEnv === undefined ? undefined : readAttestedNativeCliLoginOwner(provider, nativeEnv);
  const nativeLoginMatches = () =>
    !nativeLoginOwner ||
    (!detached && !pendingAttestation && readNativeOwner() === nativeLoginOwner);
  // Saved history must never reach an unproven login, so a recovery turn is refused. A turn
  // without saved history runs on, as it would with no owner at all, but stops coverage.
  const checkNativeLoginBoundary = (recovering: boolean, message?: string) => {
    const current = !nativeLoginOwner || detached ? undefined : readNativeOwner();
    if (!nativeLoginOwner || current === nativeLoginOwner) {
      return;
    }
    if (recovering) {
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
  const assertProofCurrent = () => {
    const current: InternalSessionEntry | undefined = loadSessionEntryReadOnly(target);
    const proof = current?.cliHistoryBoundary;
    const tip = readSessionTranscriptWatermark(target);
    if (
      !current ||
      current.sessionId !== target.sessionId ||
      current.lifecycleRevision !== snapshot.lifecycleRevision ||
      current.activeWriterRunId !== writerRunId ||
      !isKnownCliHistoryBoundary(proof) ||
      proof.sessionId !== target.sessionId ||
      proof.writerRunId !== writerRunId ||
      proof.authFingerprint !== boundary.authFingerprint ||
      proof.generation !== tip.generation ||
      proof.maxSeq !== tip.maxSeq
    ) {
      throw new Error("CLI history authority changed before execution");
    }
  };
  const writer: CliExecutionHistoryWriter = {
    target: { ...target },
    runId: writerRunId,
    authFingerprint: boundary.authFingerprint,
    lifecycleRevision: snapshot.lifecycleRevision,
    bindsNativeLogin: nativeLoginOwner !== undefined,
    // Claude CLI rotates a refresh-due token before it accepts a prompt, after the send
    // check could prove it, so such a turn runs without saved history.
    replaysHistory: !(
      nativeLoginOwner &&
      nativeLogin?.refreshDueAt !== undefined &&
      nativeLogin.refreshDueAt <= Date.now()
    ),
    assertCurrent: assertWriterCurrent,
    assertReadable: () => {
      assertWriterCurrent();
      assertProofCurrent();
    },
    // Asked once per coverage commit. A changed or unresolvable login keeps the commit's
    // rows but leaves coverage where it is, so a produced reply is never discarded.
    confirmsOwner: nativeLoginMatches,
    checkNativeLoginBoundary: (recovering) => checkNativeLoginBoundary(recovering),
    bindExecutionEnv: (env, recovering) => {
      nativeEnv = env;
      checkNativeLoginBoundary(
        recovering,
        "CLI history authority changed before execution: the spawn environment selects a different Claude login than the one attested at preparation",
      );
    },
    settleNativeLogin: async () => {
      await pendingAttestation;
      // A token that entered its refresh window may have been rotated after the send check.
      // Attest whatever the child left behind so the commit checks can prove it.
      if (
        nativeLoginOwner &&
        nativeEnv !== undefined &&
        !detached &&
        nativeLogin?.refreshDueAt !== undefined &&
        nativeLogin.refreshDueAt <= Date.now()
      ) {
        await resolveNativeCliLoginOwner(provider, nativeEnv).catch(() => undefined);
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
