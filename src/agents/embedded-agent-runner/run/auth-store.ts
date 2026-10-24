import type { AssistantMessage, Model } from "../../../llm/types.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { getApiKeyForModelCore as resolveCoreApiKey } from "../../model-auth.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import type { RuntimeAuthState } from "./helpers.js";
import type { RunEmbeddedAgentParams } from "./params.js";

/** Re-resolves the selected renewable profile's current access for one model request. */
export type ResolveRenewableApiKey = (options?: {
  forceRefresh?: boolean;
}) => Promise<string | undefined>;

export function resolveAttemptDispatchApiKey(params: {
  apiKeyInfo: ResolvedProviderAuth | null;
  runtimeAuthState: RuntimeAuthState | null;
  pluginHarnessOwnsTransport: boolean;
}): string | undefined {
  if (params.runtimeAuthState) {
    // Core streaming consumes the provider-prepared runtime credential from
    // authStorage. A transport-owning harness instead needs the original
    // resolved profile credential promised by its attempt contract.
    return params.pluginHarnessOwnsTransport ? params.runtimeAuthState.sourceApiKey : undefined;
  }
  return params.apiKeyInfo?.apiKey;
}

/**
 * Creates a per-request credential resolver for the selected Sign-in-with-ChatGPT
 * (chatgpt-token-sharing) OAuth profile. Each call re-resolves the profile's
 * current access through the canonical profile owner (refresh queue, rotation
 * fences, pre-expiry margin) so request credentials lead the attempt-captured
 * key and the static runtime-key override. Returns undefined for every other
 * credential contract, and also undefined when the owner cannot produce a key,
 * so callers keep the captured credential and let the failure path classify it.
 */
export function createRenewableRequestApiKeyResolver(params: {
  getAuthState: () => {
    apiKeyInfo: ResolvedProviderAuth | null;
    runtimeAuthState: RuntimeAuthState | null;
  };
  getModel: () => Model;
  cfg?: RunEmbeddedAgentParams["config"];
  agentDir: string;
  workspaceDir: string;
  resolveAuthStore: () => AuthProfileStore;
  publishApiKey?: (provider: string, apiKey: string) => void;
}): ResolveRenewableApiKey {
  return async (options) => {
    const { apiKeyInfo, runtimeAuthState } = params.getAuthState();
    const profileId = apiKeyInfo?.profileId?.trim();
    if (
      runtimeAuthState !== null ||
      apiKeyInfo?.mode !== "oauth" ||
      apiKeyInfo.authFlow !== "chatgpt-token-sharing" ||
      !profileId
    ) {
      return undefined;
    }
    try {
      const model = params.getModel();
      const resolved = await resolveCoreApiKey({
        model,
        cfg: params.cfg,
        profileId,
        store: params.resolveAuthStore(),
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        // The attempt already selected this account; renewal must never rotate it.
        lockedProfile: true,
        allowAuthProfileFallback: false,
        forceRefresh: options?.forceRefresh ?? false,
        secretSentinels: true,
      });
      const apiKey = resolved.apiKey?.trim();
      if (
        !apiKey ||
        resolved.profileId !== profileId ||
        resolved.mode !== "oauth" ||
        resolved.authFlow !== "chatgpt-token-sharing"
      ) {
        return undefined;
      }
      params.publishApiKey?.(model.provider, apiKey);
      return apiKey;
    } catch {
      return undefined;
    }
  };
}

/**
 * A structured unauthorized rejection that identifies an expired access
 * credential, read from the production terminal representation that
 * `failTransportStream` projects onto the assistant message:
 *
 * - unauthorized: the projected `errorCode` carries the HTTP 401 status, or
 *   the deterministic `401: ` status prefix the local projection applies
 *   (never inferred from provider prose);
 * - expired: a structured provider expiry code (`token_expired` /
 *   `expired_token`) in the projected code/type, or an explicit expiry marker
 *   in the already-redacted body/message text.
 *
 * A 403 that merely mentions expiry in prose, or a 401 with any other code
 * (revoked grant, invalid key), does not qualify, so only the SIWC expiry
 * case is admitted for a single request retry.
 */
export function isTokenExpiredUnauthorizedTerminal(
  terminal:
    | Pick<
        AssistantMessage,
        "stopReason" | "errorCode" | "errorType" | "errorMessage" | "errorBody"
      >
    | null
    | undefined,
): boolean {
  if (!terminal || terminal.stopReason !== "error") {
    return false;
  }
  // Unauthorized facts only: the projected error code carrying the HTTP 401
  // status, or the deterministic "401" status prefix the local projection
  // applies ("401: ") or the SDK already embedded in its message ("401 ").
  // Provider prose never qualifies.
  const unauthorized =
    terminal.errorCode === "401" ||
    (typeof terminal.errorMessage === "string" &&
      (terminal.errorMessage.startsWith("401: ") || terminal.errorMessage.startsWith("401 ")));
  if (!unauthorized) {
    return false;
  }
  const structured = new Set(
    [terminal.errorCode, terminal.errorType]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()),
  );
  if (structured.has("token_expired") || structured.has("expired_token")) {
    return true;
  }
  const text = [terminal.errorMessage, terminal.errorBody]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /\btoken[_ ]expired\b|\bexpired[_ ]token\b|authentication token is expired|access token has expired/iu.test(
    text,
  );
}

export function createScopedAuthProfileStore(
  store: AuthProfileStore,
  profileIds: readonly string[],
): AuthProfileStore {
  const profiles = store.profiles ?? {};
  const normalizedProfileIds = profileIds.map((profileId) => profileId.trim()).filter(Boolean);
  const scopedProfiles = Object.fromEntries(
    normalizedProfileIds.flatMap((profileId) => {
      const credential = profiles[profileId];
      return credential ? [[profileId, credential] as const] : [];
    }),
  );
  const filterProfiles = (ids?: readonly string[]) =>
    (ids ?? []).filter((profileId) => scopedProfiles[profileId]);
  const scopedRuntimeExternalProfileIds = filterProfiles(store.runtimeExternalProfileIds);
  const scopedRuntimePersistedProfileIds = filterProfiles(store.runtimePersistedProfileIds);
  return Object.keys(scopedProfiles).length > 0
    ? {
        version: store.version,
        profiles: scopedProfiles,
        ...(scopedRuntimePersistedProfileIds.length > 0
          ? { runtimePersistedProfileIds: scopedRuntimePersistedProfileIds }
          : {}),
        ...(scopedRuntimeExternalProfileIds.length > 0 ||
        store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIds: scopedRuntimeExternalProfileIds }
          : {}),
        ...(store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIdsAuthoritative: true }
          : {}),
      }
    : { version: 1, profiles: {} };
}
