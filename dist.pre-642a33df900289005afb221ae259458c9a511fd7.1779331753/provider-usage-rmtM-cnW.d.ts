import { n as UsageProviderId, t as ProviderUsageSnapshot } from "./provider-usage.types-BGbkzahX.js";

//#region src/infra/provider-usage.fetch.claude.d.ts
declare function fetchClaudeUsage(token: string, timeoutMs: number, fetchFn: typeof fetch): Promise<ProviderUsageSnapshot>;
//#endregion
//#region src/infra/provider-usage.fetch.codex.d.ts
declare function fetchCodexUsage(token: string, accountId: string | undefined, timeoutMs: number, fetchFn: typeof fetch): Promise<ProviderUsageSnapshot>;
//#endregion
//#region src/infra/provider-usage.fetch.gemini.d.ts
declare function fetchGeminiUsage(token: string, timeoutMs: number, fetchFn: typeof fetch, provider: UsageProviderId): Promise<ProviderUsageSnapshot>;
//#endregion
//#region src/infra/provider-usage.fetch.minimax.d.ts
type FetchMinimaxUsageOptions = {
  baseUrl?: string;
};
declare function fetchMinimaxUsage(apiKey: string, timeoutMs: number, fetchFn: typeof fetch, options?: FetchMinimaxUsageOptions): Promise<ProviderUsageSnapshot>;
//#endregion
//#region src/infra/provider-usage.fetch.zai.d.ts
declare function fetchZaiUsage(apiKey: string, timeoutMs: number, fetchFn: typeof fetch): Promise<ProviderUsageSnapshot>;
//#endregion
//#region src/infra/provider-usage.shared.d.ts
declare const PROVIDER_LABELS: Record<UsageProviderId, string>;
declare const clampPercent: (value: number) => number;
declare function resolveLegacyPiAgentAccessToken(env: NodeJS.ProcessEnv, providerIds: string[]): string | undefined;
//#endregion
//#region src/infra/provider-usage.fetch.shared.d.ts
declare function fetchJson(url: string, init: RequestInit, timeoutMs: number, fetchFn: typeof fetch): Promise<Response>;
type BuildUsageHttpErrorSnapshotOptions = {
  provider: UsageProviderId;
  status: number;
  message?: string;
  tokenExpiredStatuses?: readonly number[];
};
declare function buildUsageErrorSnapshot(provider: UsageProviderId, error: string): ProviderUsageSnapshot;
declare function buildUsageHttpErrorSnapshot(options: BuildUsageHttpErrorSnapshotOptions): ProviderUsageSnapshot;
//#endregion
export { clampPercent as a, fetchMinimaxUsage as c, fetchClaudeUsage as d, PROVIDER_LABELS as i, fetchGeminiUsage as l, buildUsageHttpErrorSnapshot as n, resolveLegacyPiAgentAccessToken as o, fetchJson as r, fetchZaiUsage as s, buildUsageErrorSnapshot as t, fetchCodexUsage as u };