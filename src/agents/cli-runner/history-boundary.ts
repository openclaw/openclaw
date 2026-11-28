import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  isKnownCliHistoryBoundary,
  type CliHistoryBoundary,
} from "../../config/sessions/cli-history-boundary.js";
import {
  patchSessionEntryCore,
  resolveSessionTranscriptDatabasePath,
} from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import {
  isNativeCliLoginAttestationEnabled,
  resolveNativeCliLoginOwner,
} from "../cli-credentials.js";
import { resolveCliChildEnv } from "./execution-env.js";
import { resolveCliExecutionTarget } from "./execution-target.js";
import type { PreparedCliRunContext } from "./types.js";

/** What preparation learned about the account a CLI turn runs under. */
export type CliHistoryAdmission = {
  /** False when saved history must stay out of this turn's prompt. */
  replaysHistory: boolean;
  /** The transcript this turn may read saved history from; absent when it may not. */
  target?: SessionTranscriptRuntimeTarget;
  /** Fingerprint of the identified account; absent for an unidentified login. */
  accountFingerprint?: string;
  /** True when the account comes from an attested native CLI login. */
  bindsNativeLogin: boolean;
};

/**
 * Execution layers the run's skill env overrides onto the process environment right before it
 * builds the child environment. Apply the same snapshot here so preparation identifies the
 * login the child will actually run under.
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

/**
 * Saved history never moves from one identified CLI account to another (#140294). The session
 * records the first identified account that runs it; a later turn under a different or
 * unidentified account runs without saved history, and the session stays refused until `/new`
 * starts a new session id. Turns written by other runtimes or by an unidentified login before
 * any account was recorded are ordinary session history, as they are for every other runtime.
 * Authority is checked once, here; a token rotated mid-run applies to the next turn.
 */
export async function admitCliHistoryAccount(
  params: PreparedCliRunContext["params"],
  identity: {
    credential?: AuthProfileCredential;
    /** The prepared backend the CLI child runs from; native logins resolve only from it. */
    preparedBackend?: Parameters<typeof resolveCliChildEnv>[0];
  },
): Promise<CliHistoryAdmission | undefined> {
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
  const provider = normalizeProviderId(params.provider);
  const { credential, preparedBackend } = identity;
  // A forwarded credential decides which account runs. Without one, the CLI runs under the
  // native login its own environment selects; that login has an owner only when the operator
  // opted in to attesting it and the run is not node-placed.
  const nativeLoginOwner =
    credential ||
    !preparedBackend ||
    !isNativeCliLoginAttestationEnabled(provider, params.config) ||
    resolveCliExecutionTarget({ params, backendId: provider }).kind === "node"
      ? undefined
      : (
          await resolveNativeCliLoginOwner(
            provider,
            resolvePreparedChildEnv(params, preparedBackend),
          )
        ).owner;
  // Use the resolved static credential or a named OAuth account, never a profile name,
  // reference, or identity-less OAuth token that rotates.
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
  const accountFingerprint = owner
    ? sha256Hex(JSON.stringify(["cli-history-v1", provider, owner]))
    : undefined;
  let replaysHistory = false;
  const target = { ...source, storePath: resolveSessionTranscriptDatabasePath(source) };
  await patchSessionEntryCore(
    target,
    (current) => {
      if (current.sessionId !== target.sessionId) {
        return {};
      }
      const stored =
        current.cliHistoryBoundary?.sessionId === target.sessionId
          ? current.cliHistoryBoundary
          : undefined;
      const recorded = isKnownCliHistoryBoundary(stored) ? stored.authFingerprint : undefined;
      // Older releases wrote `unknown` for any history they could not prove, including a
      // real account switch, so it keeps refusing like `mixed`.
      const mixed = stored !== undefined && !isKnownCliHistoryBoundary(stored);
      replaysHistory = !mixed && (recorded === undefined || recorded === accountFingerprint);
      const next: CliHistoryBoundary | undefined = mixed
        ? undefined
        : recorded === undefined
          ? accountFingerprint
            ? {
                version: 1,
                sessionId: target.sessionId,
                state: "known",
                authFingerprint: accountFingerprint,
              }
            : undefined
          : recorded === accountFingerprint
            ? undefined
            : { version: 1, sessionId: target.sessionId, state: "mixed" };
      return next ? { cliHistoryBoundary: next } : {};
    },
    { preserveActivity: true, skipMaintenance: true },
  );
  return {
    replaysHistory,
    ...(replaysHistory ? { target: source } : {}),
    ...(accountFingerprint ? { accountFingerprint } : {}),
    bindsNativeLogin: nativeLoginOwner !== undefined,
  };
}
