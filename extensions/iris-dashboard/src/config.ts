export type DashboardConfig = {
  supabaseUrl: string;
  supabaseServiceKey: string;
  supabaseAnonKey?: string;
  dashboardApiKey: string;
  webhookSecret: string;
  heartbeatOutputFile: string;
  heartbeatSessionKey?: string;
};

export function validateConfig(raw: Record<string, unknown>): DashboardConfig {
  const required = ["supabaseUrl", "supabaseServiceKey", "dashboardApiKey", "webhookSecret"];
  for (const key of required) {
    if (!raw[key] || typeof raw[key] !== "string") {
      throw new Error(`[iris-dashboard] Missing required config key: ${key}`);
    }
  }

  return {
    supabaseUrl: (raw.supabaseUrl as string).replace(/\/$/, ""),
    supabaseServiceKey: raw.supabaseServiceKey as string,
    supabaseAnonKey: raw.supabaseAnonKey as string | undefined,
    dashboardApiKey: raw.dashboardApiKey as string,
    webhookSecret: raw.webhookSecret as string,
    heartbeatOutputFile: (raw.heartbeatOutputFile as string | undefined) ?? "memory/HEARTBEAT.md",
    heartbeatSessionKey: raw.heartbeatSessionKey as string | undefined,
  };
}
