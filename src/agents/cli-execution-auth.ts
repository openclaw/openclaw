/**
 * Auth-profile forwarding shared by normal and narrow CLI-backed agent runs.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAuthProfileOrderWithMetadata } from "./auth-profiles/order.js";
import { loadAuthProfileStoreForRuntime } from "./auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { resolveCliBackendConfig, resolveCliRuntimeCanonicalProvider } from "./cli-backends.js";
import { resolveBundledCliBackendAuthPolicy } from "./cli-runner/cli-backend-auth-policy.js";

const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GOOGLE_PROVIDER_ID = "google";
const CLAUDE_CLI_PROVIDER_ID = "claude-cli";

type CliExecutionAuthProfileSelection = {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

class CliExecutionAuthProfileError extends Error {
  override name = "CliExecutionAuthProfileError";
}

export function cliBackendAcceptsAuthProfileForwarding(params: {
  provider: string;
  config: OpenClawConfig;
  agentId?: string;
}): boolean {
  const backend = resolveCliBackendConfig(params.provider, params.config, {
    agentId: params.agentId,
  });
  return backend?.id === GOOGLE_GEMINI_CLI_PROVIDER_ID || backend?.id === CLAUDE_CLI_PROVIDER_ID;
}

/**
 * Resolve ordered profiles and explicitly selected credentials the CLI can consume.
 * A user-locked profile must fail closed rather than run as another user.
 */
export function resolveCliExecutionAuthProfileId(params: {
  cliExecutionProvider: string;
  authProfileProvider: string;
  config: OpenClawConfig;
  agentDir: string;
  selected?: CliExecutionAuthProfileSelection;
  loadAuthProfileStoreForRuntime?: typeof loadAuthProfileStoreForRuntime;
}): string | undefined {
  const loadStore = params.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
  const selectedAuthProfileId = params.selected?.authProfileId?.trim();
  const store = loadStore(params.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    externalCliProviderIds: [params.cliExecutionProvider],
    profileId: selectedAuthProfileId,
  });
  const nativeAuthProfileIds = resolveBundledCliBackendAuthPolicy(
    params.cliExecutionProvider,
  )?.nativeAuthProfileIds;
  if (selectedAuthProfileId && nativeAuthProfileIds?.includes(selectedAuthProfileId)) {
    return undefined;
  }
  const canonicalProvider = resolveCliRuntimeCanonicalProvider({
    runtime: params.cliExecutionProvider,
    config: params.config,
    includeSetupRegistry: true,
  });
  const acceptsCredential = (credential: AuthProfileCredential, explicitSelection: boolean) =>
    credential.provider === params.cliExecutionProvider ||
    (credential.provider === canonicalProvider &&
      (params.cliExecutionProvider === CLAUDE_CLI_PROVIDER_ID
        ? explicitSelection || credential.type !== "api_key"
        : params.cliExecutionProvider === GOOGLE_GEMINI_CLI_PROVIDER_ID &&
          credential.type === "api_key"));
  if (selectedAuthProfileId && params.selected?.authProfileIdSource !== "auto") {
    const credential = store.profiles[selectedAuthProfileId];
    if (!credential) {
      throw new CliExecutionAuthProfileError(
        `No credentials found for profile "${selectedAuthProfileId}".`,
      );
    }
    if (acceptsCredential(credential, true)) {
      return selectedAuthProfileId;
    }
    throw new CliExecutionAuthProfileError(
      `CLI backend "${params.cliExecutionProvider}" cannot use auth profile "${selectedAuthProfileId}" owned by "${credential.provider}".`,
    );
  }

  const providers = [params.cliExecutionProvider];
  if (
    canonicalProvider &&
    (params.cliExecutionProvider === CLAUDE_CLI_PROVIDER_ID ||
      (params.cliExecutionProvider === GOOGLE_GEMINI_CLI_PROVIDER_ID &&
        params.authProfileProvider === GOOGLE_PROVIDER_ID))
  ) {
    providers.push(canonicalProvider);
  }
  for (const provider of providers) {
    const order = resolveAuthProfileOrderWithMetadata({
      cfg: params.config,
      store,
      provider,
      preferredProfile: selectedAuthProfileId,
    });
    const profileId = order.profileIds.find((id) => {
      const credential = store.profiles[id];
      return (
        credential && acceptsCredential(credential, false) && !nativeAuthProfileIds?.includes(id)
      );
    });
    if (profileId || order.hasExplicitOrder) {
      return profileId;
    }
  }
  return undefined;
}
