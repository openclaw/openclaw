/** Compact list omissions are unknown detail facts, never deletion receipts. */
export const SESSION_ROW_DETAIL_FIELDS = [
  "contextWindows",
  "contextWindowDefault",
  "thinkingLevels",
  "thinkingOptions",
  "thinkingDefault",
  "toolOverrides",
  "providerReview",
  "nativeRuntimeConsent",
  "contextBudgetStatus",
  "agentRuntime",
  "pluginExtensions",
] as const;
