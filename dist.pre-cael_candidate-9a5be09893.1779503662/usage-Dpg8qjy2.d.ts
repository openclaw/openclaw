import { t as ProviderUsageSnapshot } from "./provider-usage.types-BGbkzahX.js";

//#region extensions/github-copilot/usage.d.ts
declare function fetchCopilotUsage(token: string, timeoutMs: number, fetchFn: typeof fetch): Promise<ProviderUsageSnapshot>;
//#endregion
export { fetchCopilotUsage as t };