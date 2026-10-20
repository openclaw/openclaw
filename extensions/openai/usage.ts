import type {
  ProviderFetchUsageSnapshotContext,
  ProviderResolveUsageAuthContext,
  ProviderResolvedUsageAuth,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveOpenAICodexAuthIdentity } from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  addProviderUsageModel,
  asProviderUsageObject,
  buildProviderUsageHistorySnapshot,
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  cleanProviderUsageCredential,
  createProviderUsageDailyAccumulator,
  decodeProviderUsageAdminToken,
  encodeProviderUsageAdminToken,
  fetchProviderUsagePages,
  fetchCodexUsage,
  parseProviderUsageNonNegativeInteger,
  parseProviderUsageNumber,
  resolveProviderUsageDailyPeriod,
  resolveProviderUsageDisplayName,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";
import { isSIWCAuthFlow } from "./token-sharing.js";

const OPENAI_COSTS_URL = "https://api.openai.com/v1/organization/costs";
const OPENAI_COMPLETIONS_USAGE_URL = "https://api.openai.com/v1/organization/usage/completions";
const OPENAI_ADMIN_TOKEN_PREFIX = "openclaw:openai-admin:v1:";
const OPENAI_USAGE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const OPENAI_USAGE_HISTORY_DAYS = 30;

function utcDay(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

async function fetchPages(params: {
  baseUrl: string;
  groupBy: "line_item" | "model";
  apiKey: string;
  projectId?: string;
  startTime: number;
  endTime: number;
  periodDays: number;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<{ ok: true; data: unknown[] } | { ok: false; status?: number }> {
  return await fetchProviderUsagePages({
    responseLabel: "OpenAI usage",
    responseMaxBytes: OPENAI_USAGE_RESPONSE_MAX_BYTES,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    buildRequest: (page) => {
      const url = new URL(params.baseUrl);
      url.searchParams.set("start_time", String(params.startTime));
      url.searchParams.set("end_time", String(params.endTime));
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", String(params.periodDays));
      url.searchParams.set("group_by", params.groupBy);
      if (params.projectId) {
        url.searchParams.set("project_ids", params.projectId);
      }
      if (page) {
        url.searchParams.set("page", page);
      }
      return {
        url,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
      };
    },
  });
}

function aggregateHistory(params: {
  costs: unknown[];
  completions: unknown[];
  periodDays: number;
  projectId?: string;
}): ProviderUsageSnapshot {
  const daily = new Map<number, ReturnType<typeof createProviderUsageDailyAccumulator>>();
  for (const kind of ["costs", "completions"] as const) {
    for (const rawBucket of params[kind]) {
      const bucket = asProviderUsageObject(rawBucket);
      const startTime = parseProviderUsageNumber(bucket?.start_time);
      if (startTime === undefined || !Array.isArray(bucket?.results)) {
        continue;
      }
      const accumulator =
        daily.get(startTime) ?? createProviderUsageDailyAccumulator(utcDay(startTime), true);
      daily.set(startTime, accumulator);
      for (const rawResult of bucket.results) {
        const result = asProviderUsageObject(rawResult);
        if (kind === "costs") {
          const amount =
            parseProviderUsageNumber(asProviderUsageObject(result?.amount)?.value) ?? 0;
          const category = resolveProviderUsageDisplayName(result?.line_item, "API");
          accumulator.amount += amount;
          accumulator.categories.set(
            category,
            (accumulator.categories.get(category) ?? 0) + amount,
          );
          continue;
        }
        if (!result) {
          continue;
        }
        const requests = parseProviderUsageNonNegativeInteger(result.num_model_requests);
        // Organization usage totals already include text, audio, images, and cache writes.
        const totalInputTokens = parseProviderUsageNonNegativeInteger(result.input_tokens);
        const cacheReadTokens = parseProviderUsageNonNegativeInteger(result.input_cached_tokens);
        const cacheWriteTokens =
          parseProviderUsageNonNegativeInteger(result.input_cache_write_tokens) +
          parseProviderUsageNonNegativeInteger(result.input_cache_write_12h_tokens);
        const inputTokens = Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens);
        const outputTokens = parseProviderUsageNonNegativeInteger(result.output_tokens);
        const totalTokens = totalInputTokens + outputTokens;
        accumulator.requests = (accumulator.requests ?? 0) + requests;
        accumulator.inputTokens += inputTokens;
        accumulator.cacheReadTokens += cacheReadTokens;
        accumulator.cacheWriteTokens += cacheWriteTokens;
        accumulator.outputTokens += outputTokens;
        accumulator.totalTokens += totalTokens;
        addProviderUsageModel(
          accumulator,
          resolveProviderUsageDisplayName(result.model, "Responses and Chat Completions"),
          {
            requests,
            inputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            outputTokens,
            totalTokens,
          },
        );
      }
    }
  }

  return buildProviderUsageHistorySnapshot({
    provider: "openai",
    displayName: "OpenAI",
    plan: params.projectId ? `Admin API · ${params.projectId}` : "Admin API",
    periodDays: params.periodDays,
    unit: "USD",
    ...(params.projectId ? { scope: `Project ${params.projectId}` } : {}),
    daily: daily.values(),
    formatSummary: ({ requests, totalTokens }) =>
      `${requests.toLocaleString("en-US")} requests · ${totalTokens.toLocaleString("en-US")} tokens`,
  });
}

async function fetchOpenAIAdminUsage(params: {
  apiKey: string;
  projectId?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
  now?: number;
  periodDays?: number;
}): Promise<ProviderUsageSnapshot> {
  const period = resolveProviderUsageDailyPeriod({
    now: params.now ?? Date.now(),
    periodDays: params.periodDays,
    defaultPeriodDays: OPENAI_USAGE_HISTORY_DAYS,
  });
  const common = {
    apiKey: params.apiKey,
    projectId: params.projectId,
    startTime: Math.floor(period.startMs / 1000),
    endTime: Math.floor(period.endMs / 1000),
    periodDays: period.periodDays,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
  };
  const [costs, completions] = await Promise.all([
    fetchPages({ ...common, baseUrl: OPENAI_COSTS_URL, groupBy: "line_item" }),
    fetchPages({ ...common, baseUrl: OPENAI_COMPLETIONS_USAGE_URL, groupBy: "model" }),
  ]);
  if (!costs.ok || !completions.ok) {
    const failedStatus = !costs.ok
      ? costs.status
      : !completions.ok
        ? completions.status
        : undefined;
    if (failedStatus === 401 || failedStatus === 403) {
      return buildUsageErrorSnapshot("openai", "Admin API key required");
    }
    return failedStatus
      ? buildUsageHttpErrorSnapshot({ provider: "openai", status: failedStatus })
      : buildUsageErrorSnapshot("openai", "Usage unavailable");
  }
  return aggregateHistory({
    costs: costs.data,
    completions: completions.data,
    periodDays: period.periodDays,
    projectId: params.projectId,
  });
}

export async function resolveOpenAIUsageAuth(
  ctx: ProviderResolveUsageAuthContext,
): Promise<ProviderResolvedUsageAuth> {
  const explicitAdminKey = cleanProviderUsageCredential(ctx.env.OPENAI_ADMIN_KEY);
  if (explicitAdminKey) {
    return { token: encodeProviderUsageAdminToken(OPENAI_ADMIN_TOKEN_PREFIX, explicitAdminKey) };
  }
  const oauth = await ctx.resolveOAuthToken();
  if (oauth && isSIWCAuthFlow(oauth.authFlow)) {
    // ChatPass has no supported usage endpoint. Never send its scoped bearer to WHAM.
    return { handled: true };
  }
  if (oauth) {
    return oauth;
  }
  // Inference keys may belong to custom, Azure, or agent-local endpoints. Only
  // the dedicated admin credential may cross to api.openai.com organization APIs.
  return { handled: true };
}

export async function fetchOpenAIUsage(
  ctx: ProviderFetchUsageSnapshotContext,
): Promise<ProviderUsageSnapshot> {
  const adminKey = decodeProviderUsageAdminToken(OPENAI_ADMIN_TOKEN_PREFIX, ctx.token);
  if (!adminKey) {
    const snapshot = await fetchCodexUsage(ctx.token, ctx.accountId, ctx.timeoutMs, ctx.fetchFn);
    if (snapshot.error) {
      return snapshot;
    }
    // ChatGPT access tokens carry the account email as a JWT claim; the auth
    // profile stores no email for these logins.
    const { token: accessToken, email: profileEmail } = ctx;
    const accountEmail =
      resolveOpenAICodexAuthIdentity({ access: accessToken, email: profileEmail }).email ??
      profileEmail;
    return accountEmail ? { ...snapshot, accountEmail } : snapshot;
  }
  return await fetchOpenAIAdminUsage({
    apiKey: adminKey,
    projectId: cleanProviderUsageCredential(ctx.env.OPENAI_PROJECT_ID),
    timeoutMs: ctx.timeoutMs,
    fetchFn: ctx.fetchFn,
  });
}
