export type PostHogPluginConfig = {
  apiKey: string;
  host: string;
  privacyMode: boolean;
  enabled: boolean;
  traceGrouping: "message" | "session";
  sessionWindowMinutes: number;
};

export type LastAssistantInfo = {
  stopReason?: string;
  errorMessage?: string;
  cost?: {
    input: number;
    output: number;
    total: number;
  };
};

export type RunState = {
  traceId: string;
  spanId: string;
  startTime: number;
  model: string;
  provider: string;
  input: unknown[] | null;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  agentId?: string;
};
