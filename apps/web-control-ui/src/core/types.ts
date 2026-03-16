export type AppMode = "use" | "control";
export type UsageVariant = "native" | "mission" | "star" | "blank";

export type ConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type ChatMessageKind = "reply" | "status" | "build" | "command";
export type ChatFilter = "all" | "reply" | "status" | "build" | "command";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  kind?: ChatMessageKind;
};

export type SessionRow = {
  key: string;
  lastActivity: string;
  messageCount: number;
  agentId?: string;
  kind?: string;
  label?: string;
  model?: string;
  updatedAt?: number;
};
