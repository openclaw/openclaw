import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { m as SecretRefSource } from "./types.secrets-n2DWfQVx.js";
//#region src/agents/models-config.providers.secret-helpers.d.ts
declare function normalizeApiKeyConfig(value: string): string;
//#endregion
//#region src/plugins/provider-auth-token.d.ts
/** @deprecated Provider-owned setup helper; do not use from third-party plugins. */
declare function buildTokenProfileId(params: {
  provider: string;
  name: string;
}): string;
/** @deprecated Anthropic provider-owned setup helper; do not use from third-party plugins. */
declare function validateAnthropicSetupToken(raw: string): string | undefined;
//#endregion
//#region src/secrets/ref-contract.d.ts
type SecretRefDefaultsCarrier = {
  secrets?: {
    defaults?: {
      env?: string;
      file?: string;
      exec?: string;
    };
    providers?: Record<string, {
      source?: string;
    }>;
  };
};
declare function resolveDefaultSecretProviderAlias(config: SecretRefDefaultsCarrier, source: SecretRefSource, options?: {
  preferFirstProviderForSource?: boolean;
}): string;
//#endregion
//#region src/plugin-sdk/oauth-utils.d.ts
/**
 * Encode a flat object as application/x-www-form-urlencoded form data.
 *
 * @deprecated OAuth provider-owned helper; keep this local to provider plugins instead.
 */
declare function toFormUrlEncoded(data: Record<string, string>): string;
/**
 * Generate a PKCE verifier/challenge pair suitable for OAuth authorization flows.
 *
 * @deprecated OAuth provider-owned helper; keep this local to provider plugins instead.
 */
declare function generatePkceVerifierChallenge(): {
  verifier: string;
  challenge: string;
};
/** Generate a PKCE verifier/challenge pair with a 64-character hex verifier. */
declare function generateHexPkceVerifierChallenge(): {
  verifier: string;
  challenge: string;
};
//#endregion
//#region src/plugin-sdk/provider-auth.d.ts
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
declare const COPILOT_EDITOR_VERSION = "vscode/1.96.2";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
declare const COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
declare const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
declare const COPILOT_GITHUB_API_VERSION = "2025-04-01";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
declare const COPILOT_INTEGRATION_ID = "vscode-chat";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
declare const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
type CachedCopilotToken = {
  token: string;
  expiresAt: number;
  updatedAt: number;
  integrationId?: string;
};
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
declare function buildCopilotIdeHeaders(params?: {
  includeApiVersion?: boolean;
}): Record<string, string>;
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
declare function deriveCopilotApiBaseUrlFromToken(token: string): string | null;
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
declare function resolveCopilotApiToken(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  loadJsonFileImpl?: (path: string) => unknown;
  saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
}): Promise<{
  token: string;
  expiresAt: number;
  source: string;
  baseUrl: string;
}>;
declare function isProviderApiKeyConfigured(params: {
  provider: string;
  agentDir?: string;
}): boolean;
declare function listUsableProviderAuthProfileIds(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): {
  agentDir: string;
  profileIds: string[];
};
declare function isProviderAuthProfileConfigured(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): boolean;
declare function resolveProviderAuthProfileApiKey(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<string | undefined>;
//#endregion
export { toFormUrlEncoded as _, COPILOT_USER_AGENT as a, validateAnthropicSetupToken as b, buildCopilotIdeHeaders as c, isProviderAuthProfileConfigured as d, listUsableProviderAuthProfileIds as f, generatePkceVerifierChallenge as g, generateHexPkceVerifierChallenge as h, COPILOT_INTEGRATION_ID as i, deriveCopilotApiBaseUrlFromToken as l, resolveProviderAuthProfileApiKey as m, COPILOT_EDITOR_VERSION as n, CachedCopilotToken as o, resolveCopilotApiToken as p, COPILOT_GITHUB_API_VERSION as r, DEFAULT_COPILOT_API_BASE_URL as s, COPILOT_EDITOR_PLUGIN_VERSION as t, isProviderApiKeyConfigured as u, resolveDefaultSecretProviderAlias as v, normalizeApiKeyConfig as x, buildTokenProfileId as y };