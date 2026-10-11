import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isProfileInCooldown,
  markAuthProfileBlockedUntil,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveCodexAppServerAuthProfileOrder,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
import type { CodexAppServerPreparedAuth } from "./auth-types.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerHomeScope } from "./config-contracts.js";
import type { JsonValue } from "./protocol.js";
import { resolveCodexUsageLimitResetAtMs } from "./rate-limits.js";
import {
  CodexUsageLimitPromptError,
  formatCodexTurnStartUsageLimitError,
} from "./usage-limit-error.js";

const quotaKinds = new WeakMap<object, CodexBoundedTurnQuotaKind>();

export type CodexBoundedTurnQuotaKind = "usageLimitExceeded" | "rateLimitExceeded";

export type BoundedCodexTurnAuthPlan = {
  /** `undefined` keeps the client's current automatic or native selection. */
  profiles: Array<string | undefined>;
  /** Automatic same-provider selection may record quota and try the next profile. */
  rotate: boolean;
  store?: AuthProfileStore;
};

type QuotaSource = {
  message?: string | null;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
};

export function resolveBoundedCodexTurnAuthPlan(params: {
  profile?: string;
  preparedAuth?: CodexAppServerPreparedAuth;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: OpenClawConfig;
  hasClientFactory: boolean;
  homeScope: CodexAppServerHomeScope;
}): BoundedCodexTurnAuthPlan {
  // Prepared auth and native user homes are already bound to one credential.
  // They stay fail-closed; pinned profiles are handled below.
  if (params.preparedAuth || params.homeScope === "user") {
    return { profiles: [undefined], rotate: false };
  }
  const pinned = params.profile?.trim();
  if (pinned) {
    return { profiles: [pinned], rotate: false };
  }
  // A stub transport without a store must not open the operator credential
  // store. Production callers omit the factory and resolve the canonical store.
  if (!params.authProfileStore && params.hasClientFactory) {
    return { profiles: [undefined], rotate: false };
  }
  const store = resolveCodexAppServerAuthProfileStore({
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  const ordered = resolveCodexAppServerAuthProfileOrder({ store, config: params.config });
  const eligible = ordered.filter((profileId) => !isProfileInCooldown(store, profileId));
  const profiles = eligible.length > 0 ? eligible : ordered.slice(0, 1);
  if (profiles.length === 0) {
    return { profiles: [undefined], rotate: false };
  }
  return { profiles, rotate: true, store };
}

export function readCodexBoundedTurnQuotaKind(
  source: { codexErrorInfo?: JsonValue | null } | null | undefined,
): CodexBoundedTurnQuotaKind | undefined {
  const info = source?.codexErrorInfo;
  return info === "usageLimitExceeded" || info === "rateLimitExceeded" ? info : undefined;
}

export function tagCodexBoundedTurnQuotaFailure(
  error: Error,
  kind: CodexBoundedTurnQuotaKind,
): void {
  quotaKinds.set(error, kind);
}

export function readThrownCodexBoundedTurnQuotaKind(
  error: unknown,
): CodexBoundedTurnQuotaKind | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const tagged = quotaKinds.get(error);
  if (tagged) {
    return tagged;
  }
  if (error instanceof CodexUsageLimitPromptError) {
    return "usageLimitExceeded";
  }
  if (!("data" in error)) {
    return undefined;
  }
  const data = error.data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as {
    error?: { codexErrorInfo?: JsonValue | null };
    codexErrorInfo?: JsonValue | null;
  };
  const nested = record.error && typeof record.error === "object" ? record.error : record;
  return readCodexBoundedTurnQuotaKind(nested);
}

/** Records a provider reset on the canonical cooldown owner. Never throws. */
export async function recordBoundedCodexTurnQuotaBlock(params: {
  client: CodexAppServerClient;
  kind: CodexBoundedTurnQuotaKind;
  error: unknown;
  source?: QuotaSource;
  profileId?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  modelId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const profileId = params.profileId?.trim();
  if (!profileId || !params.store) {
    return;
  }
  try {
    const rateLimits = await readQuotaRateLimits(params);
    const blockedUntil = resolveCodexUsageLimitResetAtMs(rateLimits);
    if (!blockedUntil) {
      return;
    }
    await markAuthProfileBlockedUntil({
      store: params.store,
      profileId,
      blockedUntil,
      source: "codex_rate_limits",
      agentDir: params.agentDir,
      modelId: params.modelId,
    });
  } catch (error) {
    embeddedAgentLog.debug("failed to mark Codex auth profile blocked from a bounded turn", {
      authProfileId: profileId,
      error: formatErrorMessage(error),
    });
  }
}

async function readQuotaRateLimits(params: {
  client: CodexAppServerClient;
  kind: CodexBoundedTurnQuotaKind;
  error: unknown;
  source?: QuotaSource;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  if (params.kind !== "usageLimitExceeded") {
    return params.source?.rateLimits;
  }
  if (params.signal?.aborted || (params.timeoutMs !== undefined && params.timeoutMs <= 0)) {
    return params.source?.rateLimits;
  }
  const refreshed = await formatCodexTurnStartUsageLimitError({
    client: params.client,
    error: params.source !== undefined ? { data: { error: params.source } } : params.error,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  return refreshed?.rateLimitsForProfile ?? params.source?.rateLimits;
}

export async function runBoundedCodexTurnAuthAttempts<T>(params: {
  plan: BoundedCodexTurnAuthPlan;
  taskLabel: string;
  deadline: number;
  run: (profileId: string | undefined) => Promise<T>;
}): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < params.plan.profiles.length; index += 1) {
    if (index > 0 && performance.now() >= params.deadline) {
      break;
    }
    const profileId = params.plan.profiles[index];
    try {
      return await params.run(profileId);
    } catch (error) {
      lastError = error;
      const quota = readThrownCodexBoundedTurnQuotaKind(error);
      const hasNextProfile = index < params.plan.profiles.length - 1;
      if (!params.plan.rotate || !quota || !hasNextProfile) {
        throw error;
      }
      embeddedAgentLog.info(
        "codex bounded turn hit a provider quota limit; rotating auth profile",
        {
          taskLabel: params.taskLabel,
          quota,
        },
      );
    }
  }
  if (lastError !== undefined) {
    throw lastError;
  }
  throw new Error(`codex app-server ${params.taskLabel} auth rotation produced no result`);
}
