//#region src/infra/provider-usage.types.d.ts
type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};
type ProviderUsageSnapshot = {
  provider: UsageProviderId;
  displayName: string;
  windows: UsageWindow[];
  plan?: string;
  error?: string;
};
type UsageProviderId = "anthropic" | "github-copilot" | "google-gemini-cli" | "minimax" | "openai-codex" | "xiaomi" | "zai";
//#endregion
export { UsageProviderId as n, UsageWindow as r, ProviderUsageSnapshot as t };