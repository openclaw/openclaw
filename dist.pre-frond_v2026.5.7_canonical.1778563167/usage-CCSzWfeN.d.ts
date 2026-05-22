import { t as ProviderUsageSnapshot } from "./provider-usage.types-7nOu2dJc.js";

//#region extensions/github-copilot/usage.d.ts
declare function fetchCopilotUsage(token: string, timeoutMs: number, fetchFn: typeof fetch): Promise<ProviderUsageSnapshot>;
//#endregion
export { fetchCopilotUsage as t };