/** Minimal Google A2A subset for ClaWorks robot-to-robot tasks. */

export type A2aMessagePart =
  | { type: "text"; text: string }
  | { type: "data"; data: Record<string, unknown> };

export type A2aMessage = {
  role: "user" | "agent";
  parts: A2aMessagePart[];
};

export type A2aTaskStatus = "submitted" | "working" | "completed" | "failed" | "canceled";

export type A2aTask = {
  id: string;
  status: A2aTaskStatus;
  createdAt: string;
  updatedAt: string;
  message?: A2aMessage;
  metadata?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
};

export type A2aTaskSendRequest = {
  message: A2aMessage;
  metadata?: Record<string, unknown>;
  sessionId?: string;
};

export type A2aAgentCard = {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{ id: string; name: string; description?: string }>;
  endpoints?: { tasks: string };
  claworks?: Record<string, unknown>;
};
