type GatewayRequest = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export type SessionSummary = {
  key: string;
  kind?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  channel?: string;
  updatedAt: number | null;
  model?: string;
  modelProvider?: string;
  totalTokens?: number;
  sendPolicy?: string;
};

export type SessionsListResult = {
  ts?: number;
  count: number;
  sessions: SessionSummary[];
};

export async function loadSessions(
  request: GatewayRequest,
  opts?: {
    limit?: number;
    includeGlobal?: boolean;
    includeUnknown?: boolean;
    includeDerivedTitles?: boolean;
  },
): Promise<SessionsListResult> {
  const result = await request<SessionsListResult>("sessions.list", {
    limit: opts?.limit ?? 50,
    includeGlobal: opts?.includeGlobal ?? false,
    includeUnknown: opts?.includeUnknown ?? false,
    includeDerivedTitles: opts?.includeDerivedTitles ?? false,
  });
  return result ?? { count: 0, sessions: [] };
}
