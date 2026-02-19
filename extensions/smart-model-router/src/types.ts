export type RoutingRule = {
  type: "task" | "usage" | "fallback";
  condition?: string; // e.g., "coding", "creative"
  targetModel: string;
  fallbackModel?: string;
};

export type RouterState = {
  dailyUsage: Record<string, number>; // profileId -> count
  lastResetDate: string; // YYYY-MM-DD
  manualOverride?: string; // modelId if forced
};

export type RouterConfig = {
  limits: Record<string, number>; // profileId -> dailyLimit
  rules: RoutingRule[];
};
