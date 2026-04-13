// Re-export from config-schema.ts to avoid duplication
export type { AgentP2PConfig } from "./config-schema.js";

export type AgentP2PMessage = {
  type: "message" | "file" | "contact_request";
  from: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

export type AgentP2PAccount = {
  id: string;
  config: AgentP2PConfig;
  status: "connected" | "disconnected" | "error";
};
