// Credential resolution for the Claude Agent SDK driver.
//
// DEFAULT BEHAVIOR: do not set any Anthropic env vars and let the spawned
// Claude Agent SDK subprocess discover credentials from the user's
// existing `claude login` session in `~/.claude/`. This is the
// **Claude.ai subscription** path (Pro/Max) and is the safe default:
// requests count against the user's subscription quota, not a
// pay-as-you-go API meter.
//
// ONLY when the config explicitly requests `credential: "profile"` do we
// route through OpenClaw's auth-profile store — and even then we refuse
// to populate `ANTHROPIC_API_KEY` unless the resolved credential is
// explicitly an `"api-key"` type profile. OAuth/token profiles go through
// `ANTHROPIC_AUTH_TOKEN`, which the SDK still treats as a subscription
// token, not an API billing token.
//
// Unlike OpenClaw's embedded pi-ai transport (`anthropic-transport-stream.ts`)
// which wraps the Anthropic HTTP client in-process, the Agent SDK spawns
// Claude Code as a subprocess, so per-request middleware isn't available.
// Payload log/policy (`anthropic-payload-log.ts`, `anthropic-payload-policy.ts`)
// doesn't apply here — equivalent observability comes from SDK hooks (see
// `hooks-adapter.ts`).

import type { OpenClawConfig } from "../../config/config.js";
import type { AgentRuntimeClaudeSdkConfig } from "../../config/types.agents.js";
import {
  markAuthProfileCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../auth-profiles.js";
import type { AuthProfileStore } from "../auth-profiles.js";

/** The credential-selection modes exposed to config. */
export type ClaudeSdkCredentialMode = "subscription" | "profile";

export function resolveClaudeSdkCredentialMode(
  runtimeConfig: AgentRuntimeClaudeSdkConfig | undefined,
): ClaudeSdkCredentialMode {
  // Default: subscription. This is the Claude.ai Pro/Max path — requests
  // count against the user's subscription, not a metered API key.
  const requested = runtimeConfig?.credential;
  if (requested === "profile") {
    return "profile";
  }
  return "subscription";
}

export type ResolvedSdkCredential = {
  /** Human-readable label for logs ("subscription" or the profile id). */
  source: string;
  /**
   * Environment variables to merge into the SDK spawn env. Empty object
   * means "inherit from parent process" — used in subscription mode so the
   * SDK picks up the user's existing `claude login` session.
   */
  env: Record<string, string>;
  /**
   * Profile id used, if any. Populated only in profile mode so the caller
   * can call rotation helpers (`rotateOnAuthFailure`) on retry.
   */
  profileId?: string;
};

export type ResolveSdkCredentialParams = {
  /**
   * OpenClaw config. Required when credential mode is `"profile"` (the
   * auth-profile selector reads provider order/pins from config).
   * Ignored in `"subscription"` mode.
   */
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  runtimeConfig: AgentRuntimeClaudeSdkConfig | undefined;
  /** When set, skip the rotation order and use this profile directly. */
  pinnedProfileId?: string;
  /** Agent dir for store-lock bookkeeping; plumbs through to markAuth*. */
  agentDir?: string;
};

/** Error thrown when a config demands profile mode but no eligible profile exists. */
export class ClaudeSdkCredentialUnavailableError extends Error {
  readonly code = "claude_sdk_credential_unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSdkCredentialUnavailableError";
  }
}

/**
 * Resolve the credential the SDK spawn should use.
 *
 * Subscription mode (default): returns an empty env map. The SDK picks up
 * `~/.claude/` credentials from the user's `claude login` session —
 * respecting their Pro/Max subscription.
 *
 * Profile mode: walks OpenClaw's auth-profile order, picks the first
 * eligible profile, and populates either `ANTHROPIC_AUTH_TOKEN` (OAuth)
 * or `ANTHROPIC_API_KEY` (api-key). Callers that cannot afford metered
 * API use should leave the default mode.
 */
export async function resolveSdkCredential(
  params: ResolveSdkCredentialParams,
): Promise<ResolvedSdkCredential> {
  const mode = resolveClaudeSdkCredentialMode(params.runtimeConfig);
  if (mode === "subscription") {
    return { source: "subscription", env: {} };
  }

  const { cfg, store, pinnedProfileId, agentDir } = params;
  if (!cfg && !pinnedProfileId) {
    throw new ClaudeSdkCredentialUnavailableError(
      "Profile-mode credential selection requires an OpenClaw config (for provider-order resolution). " +
        "Either plumb the config through or use subscription mode.",
    );
  }
  // Provider is required by `resolveAuthProfileOrder`. In profile mode we
  // select Anthropic-family profiles; OpenClaw already scopes orders by
  // provider, so "anthropic" is the correct value here.
  const candidateOrder = pinnedProfileId
    ? [pinnedProfileId]
    : resolveAuthProfileOrder({ cfg, store, provider: "anthropic" });

  for (const profileId of candidateOrder) {
    const resolved = await resolveApiKeyForProfile({ cfg, store, profileId, agentDir });
    if (!resolved) {
      continue;
    }
    const cred = store.profiles[profileId];
    const env: Record<string, string> = {};
    if (cred && cred.type === "oauth") {
      env.ANTHROPIC_AUTH_TOKEN = resolved.apiKey;
    } else {
      env.ANTHROPIC_API_KEY = resolved.apiKey;
    }
    await markAuthProfileUsed({ store, profileId, agentDir });
    return {
      source: `profile:${profileId}`,
      env,
      profileId,
    };
  }

  throw new ClaudeSdkCredentialUnavailableError(
    pinnedProfileId
      ? `Pinned auth profile "${pinnedProfileId}" is not eligible for the claude-sdk runtime (cooldown, missing credential, or provider mismatch).`
      : "No Anthropic auth profile is eligible for the claude-sdk runtime. Check `openclaw doctor` for profile status, or switch to `agents.runtime.claudeSdk.credential: subscription` to use your Claude.ai login.",
  );
}

/**
 * Categorize an SDK invocation error well enough to decide whether to
 * rotate auth profiles and retry. The SDK surfaces HTTP status codes via
 * the spawned subprocess's stderr/result messages; we sniff for the
 * standard auth/rate-limit shapes.
 */
export type RotationDecision =
  | { kind: "rotate"; reason: "auth" | "rate_limit" }
  | { kind: "do_not_rotate" };

export function classifySdkFailureForRotation(err: unknown): RotationDecision {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b401\b|unauthorized|invalid[-_ ]?api[-_ ]?key/i.test(msg)) {
    return { kind: "rotate", reason: "auth" };
  }
  if (/\b429\b|rate[-_ ]?limit|too[-_ ]?many[-_ ]?requests/i.test(msg)) {
    return { kind: "rotate", reason: "rate_limit" };
  }
  return { kind: "do_not_rotate" };
}

export type RotateOnAuthFailureParams = {
  store: AuthProfileStore;
  profileId: string;
  error: unknown;
  agentDir?: string;
  runId?: string;
};

/**
 * Apply rotation bookkeeping after a matching failure in profile mode.
 * No-op in subscription mode (callers should not invoke this without a
 * `profileId` — typed to make that explicit).
 */
export async function rotateOnAuthFailure(
  params: RotateOnAuthFailureParams,
): Promise<RotationDecision> {
  const decision = classifySdkFailureForRotation(params.error);
  if (decision.kind === "rotate") {
    await markAuthProfileFailure({
      store: params.store,
      profileId: params.profileId,
      reason: decision.reason,
      agentDir: params.agentDir,
      runId: params.runId,
    });
    await markAuthProfileCooldown({
      store: params.store,
      profileId: params.profileId,
      agentDir: params.agentDir,
      runId: params.runId,
    });
  }
  return decision;
}
