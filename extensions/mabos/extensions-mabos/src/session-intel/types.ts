export interface SessionIntelConfig {
  sessionIntelEnabled?: boolean;
  fts?: {
    enabled?: boolean;
    dbPath?: string;
  };
  recall?: {
    enabled?: boolean;
    maxRecallResults?: number;
    summarizeResults?: boolean;
  };
  userModel?: {
    enabled?: boolean;
    profilePath?: string;
    updateInterval?: number;
  };
}

export interface IndexedSession {
  id: string;
  agentId: string;
  companyId: string;
  source: string | null;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  title: string | null;
  summary: string | null;
}

export interface IndexedMessage {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  toolName: string | null;
  timestamp: number;
}

export interface RecallResult {
  sessionId: string;
  sessionTitle: string | null;
  agentId: string;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  relevance: number;
  summary?: string;
}
