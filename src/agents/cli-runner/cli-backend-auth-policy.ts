/**
 * Core-internal auth policy for bundled auth-owning CLI backends. Membership controls
 * selected-profile resolution and raw credential forwarding during prepareExecution;
 * third-party plugins cannot declare this trust decision through Plugin SDK metadata.
 */
import type {
  CliBackendAuthEpochMode,
  CliBackendPreparedExecution,
} from "../../plugins/cli-backend.types.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";

export type BundledCliBackendAuthPolicy = {
  /** Disable profile fallback and fail closed when the selected profile cannot materialize. */
  strictSelectedProfile: boolean;
  /** Owner responsible for refreshing selected OAuth credentials before execution. */
  oauthRefreshOwner: "core" | "cli";
  /** Retired OAuth profile identities that the native runtime owns instead. */
  nativeAuthProfileIds?: readonly string[];
};

const BUNDLED_CLI_BACKEND_AUTH_POLICIES = {
  "claude-cli": {
    strictSelectedProfile: true,
    oauthRefreshOwner: "core",
    nativeAuthProfileIds: ["anthropic:claude-cli"],
  },
  "google-gemini-cli": {
    strictSelectedProfile: false,
    oauthRefreshOwner: "cli",
  },
} satisfies Record<string, BundledCliBackendAuthPolicy>;

export function resolveBundledCliBackendAuthPolicy(
  backendId: string,
): BundledCliBackendAuthPolicy | undefined {
  return BUNDLED_CLI_BACKEND_AUTH_POLICIES[
    backendId as keyof typeof BUNDLED_CLI_BACKEND_AUTH_POLICIES
  ];
}

/** Returns whether profile-owned prepared execution should skip local CLI epoch hashing. */
export function shouldSkipLocalCliCredentialEpoch(params: {
  authEpochMode?: CliBackendAuthEpochMode;
  authProfileId?: string;
  authCredential?: AuthProfileCredential;
  preparedExecution?: CliBackendPreparedExecution | null;
}): boolean {
  return Boolean(
    params.authEpochMode === "profile-only" &&
    params.authProfileId &&
    params.authCredential &&
    params.preparedExecution,
  );
}

/** Returns whether the selected profile needs core-side credential resolution before execution. */
export function shouldResolveAuthProfileForExecution(params: {
  policy?: BundledCliBackendAuthPolicy;
  authCredential?: AuthProfileCredential;
}): boolean {
  if (!params.policy) {
    return false;
  }
  if (!params.authCredential) {
    return params.policy.strictSelectedProfile;
  }
  if (params.authCredential.type === "oauth") {
    return params.policy.oauthRefreshOwner === "core";
  }
  return params.authCredential.type === "api_key" || params.authCredential.type === "token";
}
