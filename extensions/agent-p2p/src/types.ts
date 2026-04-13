export type AgentP2PConfig = {
  portalUrl: string;
  apiKey: string;
  agentName?: string;
};

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
