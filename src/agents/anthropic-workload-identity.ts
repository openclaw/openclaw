import { createHash } from "node:crypto";
/**
 * Anthropic Workload Identity Federation (WIF) credentials for the direct
 * Anthropic provider.
 *
 * Configuration is the Anthropic SDK's own: an `oidc_federation` profile under
 * ANTHROPIC_CONFIG_DIR, or ANTHROPIC_FEDERATION_RULE_ID + ANTHROPIC_ORGANIZATION_ID
 * with ANTHROPIC_IDENTITY_TOKEN_FILE (or ANTHROPIC_IDENTITY_TOKEN). Without that
 * configuration this module stays inert. Minted access tokens live only in process
 * memory and are refreshed before they expire.
 */
import { loadConfigWithSource } from "@anthropic-ai/sdk/core/credentials";
import { defaultCredentials } from "@anthropic-ai/sdk/lib/credentials/credential-chain";
import type { AccessToken, AccessTokenProvider } from "@anthropic-ai/sdk/lib/credentials/types";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const ANTHROPIC_WORKLOAD_IDENTITY_SOURCE = "anthropic-workload-identity";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
// Matches the SDK's advisory refresh threshold for federation tokens.
const REFRESH_BEFORE_EXPIRY_SECONDS = 120;
// Requests already in flight may still carry the previous token after a refresh.
const RECENT_TOKEN_LIMIT = 4;
// Settings that only make sense for WIF; any of them signals intent to use it.
const WORKLOAD_IDENTITY_ENV_VARS = [
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_IDENTITY_TOKEN",
] as const;
const REQUIRED_ENV_VARS = ["ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID"] as const;

type WorkloadIdentityState = {
  configKey?: string;
  provider?: AccessTokenProvider;
  current?: AccessToken;
  pending?: Promise<AccessToken>;
  recentTokens: string[];
};

// Shared with anthropic-workload-identity.test-support.ts.
const STATE_KEY = Symbol.for("openclaw.anthropicWorkloadIdentity");

const state = resolveGlobalSingleton<WorkloadIdentityState>(STATE_KEY, () => ({
  recentTokens: [],
}));

class AnthropicWorkloadIdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicWorkloadIdentityConfigError";
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function assertNoPartialEnvConfig(env: NodeJS.ProcessEnv): void {
  const present = WORKLOAD_IDENTITY_ENV_VARS.filter((name) => readEnv(env, name));
  if (present.length === 0) {
    return;
  }
  const missing: string[] = REQUIRED_ENV_VARS.filter((name) => !readEnv(env, name));
  if (!readEnv(env, "ANTHROPIC_IDENTITY_TOKEN_FILE") && !readEnv(env, "ANTHROPIC_IDENTITY_TOKEN")) {
    missing.push("ANTHROPIC_IDENTITY_TOKEN_FILE (or ANTHROPIC_IDENTITY_TOKEN)");
  }
  throw new AnthropicWorkloadIdentityConfigError(
    `Anthropic workload identity is partially configured (${present.join(", ")} set) but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`,
  );
}

function resetState(): void {
  state.configKey = undefined;
  state.provider = undefined;
  state.current = undefined;
  state.pending = undefined;
}

function rememberToken(token: string): void {
  state.recentTokens = [token, ...state.recentTokens.filter((t) => t !== token)].slice(
    0,
    RECENT_TOKEN_LIMIT,
  );
}

function isFresh(token: AccessToken | undefined, nowSeconds: number): token is AccessToken {
  return (
    token !== undefined &&
    (token.expiresAt === null || token.expiresAt - nowSeconds > REFRESH_BEFORE_EXPIRY_SECONDS)
  );
}

/**
 * Returns a current WIF access token, or undefined when WIF is not configured.
 * Throws when the configuration is incomplete or the token exchange fails.
 */
export async function resolveAnthropicWorkloadIdentityToken(
  params: { env?: NodeJS.ProcessEnv; forceRefresh?: boolean } = {},
): Promise<string | undefined> {
  const env = params.env ?? process.env;
  const loaded = await loadConfigWithSource();
  if (!loaded || loaded.config.authentication.type !== "oidc_federation") {
    // A user_oauth profile is an interactive login, not workload identity.
    resetState();
    if (!loaded) {
      assertNoPartialEnvConfig(env);
    }
    return undefined;
  }
  const configKey = createHash("sha256")
    .update(JSON.stringify({ fromFile: loaded.fromFile, config: loaded.config }))
    .digest("hex");
  if (state.configKey !== configKey || !state.provider) {
    resetState();
    const credentials = await defaultCredentials({
      baseURL: readEnv(env, "ANTHROPIC_BASE_URL") ?? DEFAULT_ANTHROPIC_BASE_URL,
      fetch: globalThis.fetch,
    });
    if (!credentials) {
      return undefined;
    }
    state.configKey = configKey;
    state.provider = credentials.provider;
  }
  const nowSeconds = Date.now() / 1000;
  if (!params.forceRefresh && isFresh(state.current, nowSeconds)) {
    return state.current.token;
  }
  const provider = state.provider;
  const pending = (state.pending ??= provider({ forceRefresh: params.forceRefresh }).finally(() => {
    if (state.pending === pending) {
      state.pending = undefined;
    }
  }));
  const token = await pending;
  if (state.provider === provider) {
    state.current = token;
  }
  rememberToken(token.token);
  return token.token;
}

/** True when the plaintext credential was minted by this process's WIF exchange. */
export function isAnthropicWorkloadIdentityToken(value: string): boolean {
  return state.recentTokens.includes(value);
}

/**
 * Replaces a WIF access token (plain or sentinel-wrapped) with a current one.
 * Other credentials are returned unchanged.
 */
export async function refreshAnthropicWorkloadIdentityApiKey(apiKey: string): Promise<string> {
  const sentinel = looksLikeSecretSentinel(apiKey);
  const plaintext = sentinel ? resolveSecretSentinel(apiKey) : apiKey;
  if (!plaintext || !isAnthropicWorkloadIdentityToken(plaintext)) {
    return apiKey;
  }
  const current = await resolveAnthropicWorkloadIdentityToken();
  if (!current || current === plaintext) {
    return apiKey;
  }
  return sentinel ? mintSecretSentinel(current, { label: "model-auth:anthropic" }) : current;
}
