import type {
  ProviderFetchUsageSnapshotContext,
  ProviderResolveUsageAuthContext,
  ProviderResolvedUsageAuth,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  addProviderUsageModel,
  asProviderUsageObject,
  buildUsageHttpErrorSnapshot,
  buildProviderUsageHistorySnapshot,
  cleanProviderUsageCredential,
  createProviderUsageDailyAccumulator,
  decodeProviderUsageAdminToken,
  encodeProviderUsageAdminToken,
  fetchProviderUsagePages,
  fetchClaudeUsage,
  parseProviderUsageNonNegativeInteger,
  parseProviderUsageNumber,
  resolveProviderUsageDailyPeriod,
  resolveProviderUsageDisplayName,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";
import { CLAUDE_CLI_PROFILE_ID } from "./cli-constants.js";

const ANTHROPIC_COST_URL = "https://api.anthropic.com/v1/organizations/cost_report";
const ANTHROPIC_MESSAGES_USAGE_URL =
  "https://api.anthropic.com/v1/organizations/usage_report/messages";
const ANTHROPIC_ADMIN_TOKEN_PREFIX = "openclaw:anthropic-admin:v1:";
const ANTHROPIC_USAGE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const ANTHROPIC_USAGE_HISTORY_DAYS = 30;

function normalizeAdminKey(raw: string | undefined): string | undefined {
  const cleaned = cleanProviderUsageCredential(raw);
  if (!cleaned) {
    return undefined;
  }
  const withoutBearer = cleaned.toLowerCase().startsWith("bearer ")
    ? cleaned.slice("bearer ".length).trim()
    : cleaned;
  return withoutBearer.toLowerCase().startsWith("sk-ant-admin") ? withoutBearer : undefined;
}

function encodeAdminToken(token: string): string {
  return encodeProviderUsageAdminToken(ANTHROPIC_ADMIN_TOKEN_PREFIX, token);
}

function utcDay(value: string): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
}

export async function fetchAnthropicUsage(
  ctx: ProviderFetchUsageSnapshotContext,
): Promise<ProviderUsageSnapshot> {
  const adminKey = decodeProviderUsageAdminToken(ANTHROPIC_ADMIN_TOKEN_PREFIX, ctx.token);
  if (!adminKey) {
    const snapshot = await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
    if (snapshot.error) {
      return snapshot;
    }
    // Identity comes from the selected credential, so ambient config cannot mislabel an account.
    const accountEmail = ctx.email;
    // Plan labels stay window-gated: a windowless response has no plan quota to
    // label, while the account identity is still worth surfacing.
    const plan =
      snapshot.plan ?? (snapshot.windows.length > 0 ? resolveClaudePlanLabel(ctx) : undefined);
    return {
      ...snapshot,
      ...(plan ? { plan } : {}),
      ...(accountEmail ? { accountEmail } : {}),
    };
  }
  const period = resolveProviderUsageDailyPeriod({
    now: Date.now(),
    defaultPeriodDays: ANTHROPIC_USAGE_HISTORY_DAYS,
  });
  const periodStartingAt = new Date(period.startMs).toISOString();
  const periodEndingAt = new Date(period.endMs).toISOString();
  const fetchPages = (baseUrl: string, groupBy: "description" | "model") =>
    fetchProviderUsagePages({
      responseLabel: "Anthropic usage",
      responseMaxBytes: ANTHROPIC_USAGE_RESPONSE_MAX_BYTES,
      timeoutMs: ctx.timeoutMs,
      fetchFn: ctx.fetchFn,
      buildRequest: (page) => {
        const url = new URL(baseUrl);
        url.searchParams.set("starting_at", periodStartingAt);
        url.searchParams.set("ending_at", periodEndingAt);
        url.searchParams.set("bucket_width", "1d");
        url.searchParams.set("limit", String(period.periodDays));
        url.searchParams.set("group_by[]", groupBy);
        if (page) {
          url.searchParams.set("page", page);
        }
        return {
          url,
          headers: {
            Accept: "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": adminKey,
          },
        };
      },
    });
  const [costs, messages] = await Promise.all([
    fetchPages(ANTHROPIC_COST_URL, "description"),
    fetchPages(ANTHROPIC_MESSAGES_USAGE_URL, "model"),
  ]);
  if (!costs.ok || !messages.ok) {
    const failedStatus = !costs.ok ? costs.status : !messages.ok ? messages.status : undefined;
    if (failedStatus === 401 || failedStatus === 403) {
      return {
        provider: "anthropic",
        displayName: "Anthropic",
        windows: [],
        error: "Admin API key required",
      };
    }
    return failedStatus
      ? buildUsageHttpErrorSnapshot({ provider: "anthropic", status: failedStatus })
      : {
          provider: "anthropic",
          displayName: "Anthropic",
          windows: [],
          error: "Usage unavailable",
        };
  }
  const daily = new Map<string, ReturnType<typeof createProviderUsageDailyAccumulator>>();
  const getDaily = (startingAt: string) => {
    const date = utcDay(startingAt);
    if (!date) {
      return undefined;
    }
    const current = daily.get(date) ?? createProviderUsageDailyAccumulator(date);
    daily.set(date, current);
    return current;
  };

  for (const rawBucket of costs.data) {
    const bucket = asProviderUsageObject(rawBucket);
    const startingAt = typeof bucket?.starting_at === "string" ? bucket.starting_at : undefined;
    if (!startingAt || !Array.isArray(bucket?.results)) {
      continue;
    }
    const accumulator = getDaily(startingAt);
    if (!accumulator) {
      continue;
    }
    for (const rawResult of bucket.results) {
      const result = asProviderUsageObject(rawResult);
      const amount = (parseProviderUsageNumber(result?.amount) ?? 0) / 100;
      const category = resolveProviderUsageDisplayName(
        result?.description ?? result?.cost_type,
        "Claude API",
      );
      accumulator.amount += amount;
      accumulator.categories.set(category, (accumulator.categories.get(category) ?? 0) + amount);
    }
  }

  for (const rawBucket of messages.data) {
    const bucket = asProviderUsageObject(rawBucket);
    const startingAt = typeof bucket?.starting_at === "string" ? bucket.starting_at : undefined;
    if (!startingAt || !Array.isArray(bucket?.results)) {
      continue;
    }
    const accumulator = getDaily(startingAt);
    if (!accumulator) {
      continue;
    }
    for (const rawResult of bucket.results) {
      const result = asProviderUsageObject(rawResult);
      if (!result) {
        continue;
      }
      const cacheCreation = asProviderUsageObject(result.cache_creation);
      const inputTokens = parseProviderUsageNonNegativeInteger(result.uncached_input_tokens);
      const cacheWriteTokens =
        parseProviderUsageNonNegativeInteger(cacheCreation?.ephemeral_1h_input_tokens) +
        parseProviderUsageNonNegativeInteger(cacheCreation?.ephemeral_5m_input_tokens);
      const cacheReadTokens = parseProviderUsageNonNegativeInteger(result.cache_read_input_tokens);
      const outputTokens = parseProviderUsageNonNegativeInteger(result.output_tokens);
      const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
      accumulator.inputTokens += inputTokens;
      accumulator.cacheWriteTokens += cacheWriteTokens;
      accumulator.cacheReadTokens += cacheReadTokens;
      accumulator.outputTokens += outputTokens;
      accumulator.totalTokens += totalTokens;
      addProviderUsageModel(
        accumulator,
        resolveProviderUsageDisplayName(result.model, "Claude API"),
        {
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
          totalTokens,
        },
      );
    }
  }

  return buildProviderUsageHistorySnapshot({
    provider: "anthropic",
    displayName: "Anthropic",
    plan: "Admin API",
    periodDays: period.periodDays,
    unit: "USD",
    daily: daily.values(),
    formatSummary: ({ totalTokens }) => `${totalTokens.toLocaleString("en-US")} tokens`,
  });
}

export async function resolveAnthropicUsageAuth(
  ctx: ProviderResolveUsageAuthContext,
): Promise<ProviderResolvedUsageAuth> {
  const explicitAdminKey =
    cleanProviderUsageCredential(ctx.env.ANTHROPIC_ADMIN_KEY) ??
    cleanProviderUsageCredential(ctx.env.ANTHROPIC_ADMIN_API_KEY);
  if (explicitAdminKey) {
    return { token: encodeAdminToken(explicitAdminKey) };
  }

  const storedCandidates = (await ctx.resolveApiKeyCandidatesFromConfigAndStore?.()) ?? [];
  const storedAdminKey = storedCandidates
    .map(normalizeAdminKey)
    .find((candidate): candidate is string => Boolean(candidate));
  if (storedAdminKey) {
    return { token: encodeAdminToken(storedAdminKey) };
  }

  const oauthToken = await ctx.resolveOAuthToken({
    excludeProfileIds: [CLAUDE_CLI_PROFILE_ID],
  });
  if (oauthToken) {
    return oauthToken;
  }

  const apiKey = storedCandidates[0];
  if (apiKey) {
    const { validateAnthropicSetupToken } = await import("openclaw/plugin-sdk/provider-auth");
    if (validateAnthropicSetupToken(apiKey) === undefined) {
      return { token: apiKey };
    }
  }

  // Claude owns its native refresh-token family. Do not resolve a copied
  // claude-cli profile here: generic OAuth refresh invalidates Claude's login.
  return { handled: true };
}

/** Formats keychain plan metadata like ("max", "default_max_20x") as "Max (20x)". */
function resolveClaudePlanLabel(ctx: ProviderFetchUsageSnapshotContext): string | undefined {
  const base = ctx.subscriptionType?.trim();
  if (!base) {
    return undefined;
  }
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  const tier = ctx.rateLimitTier?.trim().match(/_(\d+x)$/i)?.[1];
  return tier ? `${label} (${tier})` : label;
}
