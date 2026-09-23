import { expect } from "vitest";

export type GatewayCall = {
  method?: string;
  params?: Record<string, unknown>;
};

type AgentCallParams = {
  message?: string;
  lane?: string;
  channel?: string;
  sessionKey?: string;
  extraSystemPrompt?: string;
  inputProvenance?: {
    kind?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
    sourceRole?: string;
  };
};

type SessionsSendDetails = {
  status?: string;
  runId?: string;
  reply?: string;
  error?: string;
  sentBeforeError?: boolean;
  sessionKey?: string;
  targetDisposition?: string;
  delivery?: {
    status?: string;
    mode?: string;
  };
};

export function requireGatewayCall(call: unknown, method: string): GatewayCall {
  const request = call as GatewayCall | undefined;
  if (request?.method !== method) {
    throw new Error(`expected ${method} gateway call`);
  }
  return request;
}

export function agentParams(call: { params?: unknown }): AgentCallParams {
  return (call.params ?? {}) as AgentCallParams;
}

export function expectInterSessionAgentCall(call: { params?: unknown }): void {
  // Inter-session sends should be marked as nested non-user agent calls.
  const params = agentParams(call);
  expect(params.message).toContain("[Inter-session message");
  expect(params.message).toContain("isUser=false");
  expect(params.lane).toMatch(/^nested(?::|$)/);
  expect(params.channel).toBe("webchat");
  expect(params.inputProvenance?.kind).toBe("inter_session");
}

export function sessionsSendDetails(details: unknown): SessionsSendDetails {
  return details as SessionsSendDetails;
}
