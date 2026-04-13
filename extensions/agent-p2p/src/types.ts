// Re-export from config-schema.ts to avoid duplication
export type { AgentP2PConfig } from "./config-schema.js";

// Message type from Portal
export type AgentP2PMessage = {
  type: "message" | "file" | "contact_request";
  from: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

// Account status
export type AgentP2PAccount = {
  id: string;
  config: import("./config-schema.js").AgentP2PConfig;
  status: "connected" | "disconnected" | "error";
};
