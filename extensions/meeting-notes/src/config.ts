export type MeetingNotesConfig = {
  enabled: boolean;
  maxUtterances: number;
};

export function resolveMeetingNotesConfig(raw: unknown): MeetingNotesConfig {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const maxUtterances =
    typeof config.maxUtterances === "number" && Number.isFinite(config.maxUtterances)
      ? Math.max(1, Math.min(10_000, Math.floor(config.maxUtterances)))
      : 2_000;
  return {
    enabled: config.enabled !== false,
    maxUtterances,
  };
}
