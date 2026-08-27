import { buildCopilotIdeHeaders } from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
  clampPercent,
  PROVIDER_LABELS,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { PUBLIC_GITHUB_COPILOT_DOMAIN } from "./domain.js";

type CopilotUsageResponse = {
  quota_snapshots?: {
    premium_interactions?: { percent_remaining?: number | null };
    chat?: { percent_remaining?: number | null };
  };
  copilot_plan?: string;
};

export async function fetchCopilotUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  githubDomain: string = PUBLIC_GITHUB_COPILOT_DOMAIN,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    `https://api.${githubDomain}/copilot_internal/user`,
    {
      headers: {
        Authorization: `token ${token}`,
        ...buildCopilotIdeHeaders({ includeApiVersion: true }),
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return buildUsageHttpErrorSnapshot({
      provider: "github-copilot",
      status: res.status,
    });
  }

  let payload: unknown;
  try {
    payload = await readProviderJsonResponse<unknown>(res, "github-copilot-usage");
  } catch (error) {
    // Keep bounded-reader failures visible while normalizing malformed provider JSON.
    if (
      error instanceof Error &&
      error.message === "github-copilot-usage: malformed JSON response" &&
      (error.cause instanceof SyntaxError || error.cause instanceof TypeError)
    ) {
      return buildUsageErrorSnapshot(
        "github-copilot",
        "Copilot returned unreadable usage data. Try refreshing usage later.",
      );
    }
    throw error;
  }
  const data = isRecord(payload) ? (payload as CopilotUsageResponse) : {};
  const windows: UsageWindow[] = [];

  for (const [key, label] of [
    ["premium_interactions", "Premium"],
    ["chat", "Chat"],
  ] as const) {
    const quota = data.quota_snapshots?.[key];
    if (quota) {
      windows.push({ label, usedPercent: clampPercent(100 - (quota.percent_remaining ?? 0)) });
    }
  }

  return {
    provider: "github-copilot",
    displayName: PROVIDER_LABELS["github-copilot"],
    windows,
    plan: data.copilot_plan,
  };
}
