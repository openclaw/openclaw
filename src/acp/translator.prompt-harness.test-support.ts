import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { expect, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import { createPromptRequest } from "./translator.bridge-test-helpers.js";
import type { AcpGatewayAgent } from "./translator.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

const DEFAULT_SESSION_ID = "session-1";
export const DEFAULT_SESSION_KEY = "agent:main:main";

export function createSessionAgentHarness(
  request: GatewayClient["request"],
  options: { sessionId?: string; sessionKey?: string; cwd?: string } = {},
) {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({ sessionId, sessionKey, cwd: options.cwd ?? "/tmp" });
  const connection = createAcpConnection();
  const agent = createAcpGatewayAgent(connection, createAcpGateway(request), { sessionStore });
  return {
    agent,
    sessionId,
    sessionKey,
    sessionStore,
    sessionUpdate: connection["__sessionUpdateMock"],
  };
}

export function promptAgent(
  agent: AcpGatewayAgent,
  sessionId = DEFAULT_SESSION_ID,
  text = "hello",
) {
  return agent.prompt(createPromptRequest(sessionId, text));
}

export function observeSettlement(promise: ReturnType<AcpGatewayAgent["prompt"]>) {
  const settleSpy = vi.fn();
  void promise.then(
    (value) => settleSpy({ kind: "resolve", value }),
    (error: unknown) => settleSpy({ kind: "reject", error }),
  );
  return settleSpy;
}

export async function createPendingPromptHarness() {
  let runId: string | undefined;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chat.send") {
      runId = params?.idempotencyKey as string | undefined;
      return new Promise<never>(() => {});
    }
    return {};
  }) as GatewayClient["request"];

  const { agent, sessionId, sessionUpdate } = createSessionAgentHarness(request);
  const promptPromise = promptAgent(agent, sessionId);

  await vi.waitFor(() => {
    expect(runId).toBeDefined();
  });

  return { agent, promptPromise, runId: runId!, sessionUpdate };
}

export function createChatEvent(payload: Record<string, unknown>): EventFrame {
  return { type: "event", event: "chat", payload } as EventFrame;
}
