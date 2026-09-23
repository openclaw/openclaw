// Codex plugin module implements command account behavior.
import {
  ensureAuthProfileStore,
  resolveAuthProfileEligibility,
  resolveProfileUnusableUntilForDisplay,
  type AuthProfileCredential,
  type AuthProfileFailureReason,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  findNormalizedProviderValue,
  resolveAuthProfileOrder,
} from "openclaw/plugin-sdk/provider-auth";
import { normalizeUniqueStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_CONTROL_METHODS, type CodexControlMethod } from "./app-server/capabilities.js";
import type { JsonValue } from "./app-server/protocol.js";
import {
  summarizeCodexAccountUsage,
  type CodexAccountUsageSummary,
} from "./app-server/rate-limits.js";
import type { CodexControlRequestOptions, SafeValue } from "./command-rpc.js";

const OPENAI_PROVIDER_ID = "openai";

type AuthProfileOrderConfig = Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];

type SafeCodexControlRequest = (
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams: JsonValue | undefined,
  options?: CodexControlRequestOptions,
) => Promise<SafeValue<JsonValue | undefined>>;

type CodexAccountAuthRow = {
  profileId: string;
  label: string;
  kind: string;
  status: string;
  active: boolean;
  billingNote?: string;
};

export type CodexAccountAuthOverview = {
  currentLine?: string;
  subscriptionLabel?: string;
  subscriptionUsage?: string;
  orderTitle: string;
  rows: CodexAccountAuthRow[];
};

export async function readCodexAccountAuthOverview(params: {
  ctx: PluginCommandContext;
  agentDir: string;
  authProfileId: string | null | undefined;
  pluginConfig: unknown;
  safeCodexControlRequest: SafeCodexControlRequest;
  account: SafeValue<JsonValue | undefined>;
  limits: SafeValue<JsonValue | undefined>;
}): Promise<CodexAccountAuthOverview | undefined> {
  if (!params.account.ok && !params.limits.ok) {
    return undefined;
  }
  const config = params.ctx.config;
  const agentDir = params.agentDir;
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
    config,
  });
  const order = resolveDisplayAuthOrder({ config, store });
  const activeProfileId = params.authProfileId ?? undefined;
  if (activeProfileId && !order.includes(activeProfileId)) {
    order.unshift(activeProfileId);
  }
  if (order.length === 0) {
    return undefined;
  }

  const now = Date.now();
  const activeIsSubscription =
    activeProfileId !== undefined && isChatGptSubscriptionProfile(store.profiles[activeProfileId]);
  const subscriptionProfileId = activeIsSubscription
    ? activeProfileId
    : activeProfileId
      ? order.find((profileId) => isChatGptSubscriptionProfile(store.profiles[profileId]))
      : undefined;
  const activeUsage =
    activeIsSubscription && params.limits.ok
      ? summarizeCodexAccountUsage(params.limits.value, now)
      : undefined;
  const subscriptionUsage =
    subscriptionProfileId && !activeIsSubscription
      ? await readSubscriptionUsage({
          ...params,
          agentDir,
          config,
          subscriptionProfileId,
          now,
        })
      : activeUsage;
  const rows = order.map((profileId) =>
    buildProfileRow({
      store,
      config,
      profileId,
      activeProfileId,
      now,
      usage: profileId === subscriptionProfileId ? subscriptionUsage : undefined,
    }),
  );
  const activeRow = rows.find((row) => row.active);
  if (!activeRow) {
    return {
      orderTitle: "Auth order",
      rows,
    };
  }
  const activeCredential = store.profiles[activeRow.profileId];
  const activeIsApiKey = activeCredential?.type === "api_key";
  const subscriptionLabel = subscriptionProfileId
    ? formatProfileLabel(subscriptionProfileId, store.profiles[subscriptionProfileId])
    : undefined;
  const subscriptionUsageLine = formatSubscriptionUsageLine(subscriptionUsage);
  return {
    ...(activeIsApiKey ? { currentLine: buildApiKeyActiveLine(activeRow, subscriptionUsage) } : {}),
    ...(subscriptionLabel ? { subscriptionLabel } : {}),
    ...(subscriptionUsageLine ? { subscriptionUsage: subscriptionUsageLine } : {}),
    orderTitle: "Auth order",
    rows,
  };
}

function resolveDisplayAuthOrder(params: {
  config: AuthProfileOrderConfig;
  store: AuthProfileStore;
}): string[] {
  const explicitOrder =
    findNormalizedProviderValue(params.store.order, OPENAI_PROVIDER_ID) ??
    findNormalizedProviderValue(params.config?.auth?.order, OPENAI_PROVIDER_ID);
  if (explicitOrder && explicitOrder.length > 0) {
    return normalizeUniqueStringEntries(explicitOrder);
  }
  return resolveAuthProfileOrder({
    cfg: params.config,
    store: params.store,
    provider: OPENAI_PROVIDER_ID,
  });
}

async function readSubscriptionUsage(params: {
  pluginConfig: unknown;
  safeCodexControlRequest: SafeCodexControlRequest;
  agentDir: string;
  config: AuthProfileOrderConfig;
  subscriptionProfileId: string;
  now: number;
}): Promise<CodexAccountUsageSummary | undefined> {
  const limits = await params.safeCodexControlRequest(
    params.pluginConfig,
    CODEX_CONTROL_METHODS.rateLimits,
    undefined,
    {
      config: params.config,
      agentDir: params.agentDir,
      authProfileId: params.subscriptionProfileId,
      isolated: true,
    },
  );
  if (!limits.ok) {
    return undefined;
  }
  return summarizeCodexAccountUsage(limits.value, params.now);
}

function buildProfileRow(params: {
  store: AuthProfileStore;
  config: AuthProfileOrderConfig;
  profileId: string;
  activeProfileId?: string;
  now: number;
  usage?: CodexAccountUsageSummary;
}): CodexAccountAuthRow {
  const credential = params.store.profiles[params.profileId];
  const label = formatProfileLabel(params.profileId, credential);
  const kind = formatProfileKind(credential);
  const active = params.profileId === params.activeProfileId;
  const status = active
    ? "active now"
    : params.usage?.blocked
      ? "rate-limited"
      : describeInactiveProfileStatus({
          store: params.store,
          config: params.config,
          profileId: params.profileId,
          credential,
          now: params.now,
        });
  return {
    profileId: params.profileId,
    label,
    kind,
    status,
    active,
    ...(credential?.type === "api_key" && active ? { billingNote: "billed per token" } : {}),
  };
}

function describeInactiveProfileStatus(params: {
  store: AuthProfileStore;
  config: AuthProfileOrderConfig;
  profileId: string;
  credential?: AuthProfileCredential;
  now: number;
}): string {
  const stats = params.store.usageStats?.[params.profileId];
  const blockedUntil = stats?.blockedUntil;
  if (isActiveUntil(blockedUntil, params.now)) {
    return `rate-limited - resets ${formatRelativeReset(blockedUntil, params.now)}`;
  }
  const unusableUntil = resolveProfileUnusableUntilForDisplay(params.store, params.profileId);
  if (isActiveUntil(unusableUntil ?? undefined, params.now)) {
    return describeFailureStatus(stats?.disabledReason ?? stats?.cooldownReason, params.credential);
  }
  const eligibility = resolveAuthProfileEligibility({
    cfg: params.config,
    store: params.store,
    provider: OPENAI_PROVIDER_ID,
    profileId: params.profileId,
    now: params.now,
  });
  if (!eligibility.eligible) {
    return describeEligibilityStatus(eligibility.reasonCode, params.credential);
  }
  return "available if needed";
}

function buildApiKeyActiveLine(
  activeRow: CodexAccountAuthRow,
  subscriptionUsage: CodexAccountUsageSummary | undefined,
): string {
  if (subscriptionUsage?.blocked) {
    const switchBack = subscriptionUsage.blockedResetRelative
      ? ` · switches back ${subscriptionUsage.blockedResetRelative}`
      : " · switches back automatically";
    return `Now using: ${activeRow.label} - subscription rate-limited${switchBack}`;
  }
  return `Now using: ${activeRow.label} - subscription unavailable · switches back automatically`;
}

function formatSubscriptionUsageLine(
  usage: CodexAccountUsageSummary | undefined,
): string | undefined {
  if (!usage) {
    return undefined;
  }
  const parts = usage.usageLine ? [formatUsageLineForDisplay(usage.usageLine)] : [];
  if (usage.blockedResetRelative) {
    parts.push(`Resets ${usage.blockedResetRelative}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatUsageLineForDisplay(value: string): string {
  return value.replace(/^weekly\b/u, "Weekly").replace(/\bshort-term\b/u, "Short-term");
}

function isChatGptSubscriptionProfile(credential: AuthProfileCredential | undefined): boolean {
  return credential?.type === "oauth" || credential?.type === "token";
}

function formatProfileKind(credential: AuthProfileCredential | undefined): string {
  if (!credential) {
    return "credential";
  }
  if (isChatGptSubscriptionProfile(credential)) {
    return "ChatGPT subscription";
  }
  if (credential.type === "api_key") {
    return "API key";
  }
  return "credential";
}

function formatProfileLabel(
  profileId: string,
  credential: AuthProfileCredential | undefined,
): string {
  const tail = profileId.includes(":") ? profileId.slice(profileId.indexOf(":") + 1) : profileId;
  const displayName = credential?.displayName?.trim();
  if (displayName) {
    return credential?.type === "api_key"
      ? simplifyApiKeyDisplayName(displayName, tail)
      : displayName;
  }
  const email = credential?.email?.trim() ?? extractEmailFromProfileId(profileId);
  if (email) {
    return email;
  }
  if (credential?.type === "api_key") {
    return tail || "API key";
  }
  return humanizeProfileTail(tail);
}

function simplifyApiKeyDisplayName(value: string, tail: string): string {
  const stripped = value.replace(/^OpenAI\s+/iu, "").trim();
  if (tail && stripped.toLowerCase() === humanizeApiKeyProfileTail(tail).toLowerCase()) {
    return tail;
  }
  return stripped || value;
}

function humanizeApiKeyProfileTail(tail: string): string {
  const words = splitProfileTail(tail);
  const hasBackup = words.includes("backup");
  const customWords = words.filter((word) => word !== "api" && word !== "key" && word !== "backup");
  const prefix = customWords.map(titleCase).join(" ");
  return [prefix, "API key", hasBackup ? "backup" : ""].filter(Boolean).join(" ");
}

function humanizeProfileTail(tail: string): string {
  const words = splitProfileTail(tail);
  return words.length > 0 ? words.map(titleCase).join(" ") : tail;
}

function splitProfileTail(tail: string): string[] {
  return tail
    .replace(/[_\s]+/gu, "-")
    .split("-")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
}

function titleCase(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function extractEmailFromProfileId(profileId: string): string | undefined {
  const tail = profileId.includes(":") ? profileId.slice(profileId.indexOf(":") + 1) : profileId;
  return /^[^\s@<>()[\]`]+@[^\s@<>()[\]`]+\.[^\s@<>()[\]`]+$/.test(tail) ? tail : undefined;
}

function describeFailureStatus(
  reason: AuthProfileFailureReason | undefined,
  credential: AuthProfileCredential | undefined,
): string {
  if (reason === "auth" || reason === "auth_permanent" || reason === "session_expired") {
    return credential?.type === "api_key" ? "auth failed - check key" : "sign-in expired";
  }
  if (reason === "billing") {
    return "billing unavailable";
  }
  if (reason === "rate_limit") {
    return "rate-limited";
  }
  return "temporarily unavailable";
}

function describeEligibilityStatus(
  reason: string,
  credential: AuthProfileCredential | undefined,
): string {
  if (reason === "profile_missing" || reason === "missing_credential") {
    return credential?.type === "api_key" ? "not configured" : "sign-in required";
  }
  if (reason === "expired" || reason === "invalid_expires") {
    return "sign-in expired";
  }
  if (reason === "unresolved_ref") {
    return "credential unavailable";
  }
  if (reason === "provider_mismatch") {
    return "wrong provider";
  }
  if (reason === "mode_mismatch") {
    return "wrong credential type";
  }
  return "unavailable";
}

function isActiveUntil(value: number | undefined, now: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > now;
}

function formatRelativeReset(untilMs: number, nowMs: number): string {
  const durationMs = Math.max(1_000, untilMs - nowMs);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (durationMs < hourMs) {
    const minutes = Math.ceil(durationMs / minuteMs);
    return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (durationMs < dayMs) {
    const hours = Math.ceil(durationMs / hourMs);
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.ceil(durationMs / dayMs);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}
