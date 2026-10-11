import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  prepareAuthProfileAuthorizationWrite,
  copyAuthProfileAuthorizationIntent,
  copyAuthProfileAuthorizationInheritance,
} from "./authorization-lifetime.js";
import { isLegacyOAuthRef } from "./legacy-oauth-ref.js";
import { captureOAuthRefreshClaimPublication } from "./oauth-refresh-marker.js";
import { buildPersistedAuthProfileSecretsStore } from "./persisted.js";
import { runtimeAuthMetadataState } from "./runtime-snapshot-owner.js";
import { buildPersistedAuthProfileState, coerceAuthProfileState } from "./state.js";
import type { AuthProfileState, AuthProfileStore } from "./types.js";

const INLINE_OAUTH_TOKEN_FIELDS = ["access", "refresh", "idToken"] as const;

function hasChangedInlineOAuthTokenMaterial(params: {
  credential: object;
  existingCredential: object;
}): boolean {
  return INLINE_OAUTH_TOKEN_FIELDS.some((field) => {
    const credentialValue = Reflect.get(params.credential, field);
    if (credentialValue === undefined) {
      return false;
    }
    return !isDeepStrictEqual(credentialValue, Reflect.get(params.existingCredential, field));
  });
}

function preserveLegacyOAuthRefsOnSave(params: {
  payload: ReturnType<typeof buildPersistedAuthProfileSecretsStore>;
  existingRaw: unknown;
}): ReturnType<typeof buildPersistedAuthProfileSecretsStore> {
  if (!isRecord(params.existingRaw) || !isRecord(params.existingRaw.profiles)) {
    return params.payload;
  }
  let nextProfiles: typeof params.payload.profiles | undefined;
  for (const [profileId, credential] of Object.entries(params.payload.profiles)) {
    if (credential.type !== "oauth" || credential.oauthRef !== undefined) {
      continue;
    }
    const existingCredential = params.existingRaw.profiles[profileId];
    if (
      !isRecord(existingCredential) ||
      !isLegacyOAuthRef(existingCredential.oauthRef) ||
      existingCredential.type !== "oauth"
    ) {
      continue;
    }
    if (hasChangedInlineOAuthTokenMaterial({ credential, existingCredential })) {
      continue;
    }
    // Preserve legacy oauthRef ownership when current save data did not replace
    // inline OAuth material; otherwise older credential references would be lost.
    nextProfiles ??= { ...params.payload.profiles };
    copyAuthProfileAuthorizationInheritance(params.payload.profiles, nextProfiles);
    nextProfiles[profileId] = {
      ...credential,
      oauthRef: existingCredential.oauthRef,
    };
    copyAuthProfileAuthorizationIntent(credential, nextProfiles[profileId]);
  }
  return nextProfiles ? { ...params.payload, profiles: nextProfiles } : params.payload;
}

/** Classify authoritative save inputs before their transaction publishes derived state. */
export function prepareAuthProfileStoreMutation(params: {
  existingRaw: unknown;
  existingState: unknown;
  store: AuthProfileStore;
  selectionProfiles: AuthProfileStore["profiles"];
}) {
  const { existingRaw, existingState, store, selectionProfiles } = params;
  const payload = prepareAuthProfileAuthorizationWrite(
    existingRaw,
    preserveLegacyOAuthRefsOnSave({
      payload: buildPersistedAuthProfileSecretsStore(store),
      existingRaw,
    }),
  );
  const existingProfiles =
    isRecord(existingRaw) && isRecord(existingRaw.profiles) ? existingRaw.profiles : {};
  const changedProfileIds = [
    ...new Set([...Object.keys(existingProfiles), ...Object.keys(payload.profiles)]),
  ].filter(
    (profileId) => !isDeepStrictEqual(existingProfiles[profileId], payload.profiles[profileId]),
  );
  const profileSetChanged = changedProfileIds.some(
    (profileId) =>
      Object.hasOwn(existingProfiles, profileId) !== Object.hasOwn(payload.profiles, profileId),
  );
  const { statePayload, stateChanged, selectionChanged } = prepareAuthProfileStateMutation({
    existingState,
    store,
    selectionProfiles,
  });
  return {
    payload,
    statePayload,
    publication: {
      profileIds: changedProfileIds,
      profileSetChanged,
      credentialsChanged: !isDeepStrictEqual(existingRaw, payload),
      stateChanged,
      selectionChanged,
      oauthRefreshClaimIds: captureOAuthRefreshClaimPublication(
        payload.profiles,
        changedProfileIds,
      ),
    },
  };
}

/** Classify state-only writes without changing credential ownership. */
export function prepareAuthProfileStateMutation(params: {
  existingState: unknown;
  store: AuthProfileStore;
  selectionProfiles: AuthProfileStore["profiles"];
}) {
  const { existingState, store, selectionProfiles } = params;
  const statePayload = buildPersistedAuthProfileState(store);
  const stateChanged = !isDeepStrictEqual(existingState, statePayload);
  const previousState = coerceAuthProfileState(existingState);
  const metadata = (state: AuthProfileState | null) =>
    runtimeAuthMetadataState({
      ...store,
      profiles: selectionProfiles,
      order: state?.order,
      usageStats: state?.usageStats,
    });
  const selectionChanged =
    stateChanged && !isDeepStrictEqual(metadata(previousState), metadata(statePayload));
  return { statePayload, stateChanged, selectionChanged };
}
