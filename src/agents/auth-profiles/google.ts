/**
 * Google auth replacement credential resolver.
 *
 * This module keeps Google provider credential material typed at the resolver
 * boundary. Provider/runtime code receives credential objects only after it
 * declares support for the selected provider and credential kind.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export type GoogleAuthCredential =
  | {
      kind: "api_key";
      providerId: "google";
      profileId: string;
      apiKey: string;
    }
  | {
      kind: "oauth";
      providerId: "google-gemini-cli";
      profileId: string;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      projectId?: string;
    };

export type GoogleAuthProviderId = GoogleAuthCredential["providerId"];

export type ResolveGoogleAuthCredentialParams = {
  providerId: string;
  profileId: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
};

export class GoogleAuthCredentialResolutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "GoogleAuthCredentialResolutionError";
    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
        writable: true,
      });
    }
  }
}

function isGoogleAuthProviderId(providerId: string): providerId is GoogleAuthProviderId {
  return providerId === "google" || providerId === "google-gemini-cli";
}

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireOAuthCredential(value: unknown): OAuthCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const credential = value as Partial<OAuthCredential>;
  return credential.type === "oauth" ? (credential as OAuthCredential) : null;
}

/**
 * Resolves a selected Google auth profile into typed credential material.
 *
 * API-key profiles remain owned by `google`. OAuth profiles remain owned by
 * `google-gemini-cli`. This intentionally does not format credentials as
 * provider strings or Gemini CLI files.
 */
export async function resolveGoogleAuthCredential(
  params: ResolveGoogleAuthCredentialParams,
): Promise<GoogleAuthCredential | null> {
  const { providerId, profileId, store } = params;
  if (!isGoogleAuthProviderId(providerId)) {
    return null;
  }

  const storedCredential = store.profiles[profileId];
  if (!storedCredential || storedCredential.provider !== providerId) {
    return null;
  }

  if (providerId === "google") {
    if (storedCredential.type !== "api_key") {
      return null;
    }
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store,
      profileId,
      agentDir: params.agentDir,
    });
    if (!resolved || resolved.provider !== "google" || resolved.profileType !== "api_key") {
      return null;
    }
    return {
      kind: "api_key",
      providerId: "google",
      profileId: resolved.profileId,
      apiKey: resolved.apiKey,
    };
  }

  if (storedCredential.type !== "oauth") {
    return null;
  }

  const storedOAuth = requireOAuthCredential(storedCredential);
  const storedAccessToken = normalizeString(storedOAuth?.access);
  const storedRefreshToken = normalizeString(storedOAuth?.refresh);
  const storedProjectId = normalizeString(storedOAuth?.projectId);
  const storedExpiresAt = storedOAuth?.expires;
  const storedExpiryIsUsable =
    typeof storedExpiresAt !== "number" ||
    !Number.isFinite(storedExpiresAt) ||
    storedExpiresAt > Date.now();
  if (storedAccessToken && storedExpiryIsUsable) {
    return {
      kind: "oauth",
      providerId: "google-gemini-cli",
      profileId,
      accessToken: storedAccessToken,
      ...(storedRefreshToken ? { refreshToken: storedRefreshToken } : {}),
      ...(typeof storedExpiresAt === "number" && Number.isFinite(storedExpiresAt)
        ? { expiresAt: storedExpiresAt }
        : {}),
      ...(storedProjectId ? { projectId: storedProjectId } : {}),
    };
  }

  try {
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store,
      profileId,
      agentDir: params.agentDir,
      forceRefresh: true,
    });
    if (
      !resolved ||
      resolved.provider !== "google-gemini-cli" ||
      resolved.profileType !== "oauth"
    ) {
      if (!storedExpiryIsUsable) {
        throw new Error("OAuth refresh returned no usable google-gemini-cli credential");
      }
      return null;
    }
    const oauth =
      requireOAuthCredential(resolved.credential) ??
      requireOAuthCredential(store.profiles[resolved.profileId]);
    const accessToken = normalizeString(oauth?.access ?? resolved.apiKey);
    if (!accessToken) {
      return null;
    }
    const refreshToken = normalizeString(oauth?.refresh);
    const projectId = normalizeString(oauth?.projectId);
    return {
      kind: "oauth",
      providerId: "google-gemini-cli",
      profileId: resolved.profileId,
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof oauth?.expires === "number" && Number.isFinite(oauth.expires)
        ? { expiresAt: oauth.expires }
        : {}),
      ...(projectId ? { projectId } : {}),
    };
  } catch (error) {
    throw new GoogleAuthCredentialResolutionError(
      `Google OAuth credential resolution failed for provider ${providerId}: ${formatErrorMessage(
        error,
      )}`,
      { cause: error },
    );
  }
}
