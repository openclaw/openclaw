import type { PromptRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

type PendingPromptHarness = {
  agent: AcpGatewayAgent;
  promptPromise: ReturnType<AcpGatewayAgent["prompt"]>;
  runId: string;
};

const DEFAULT_SESSION_ID = "session-1";
const DEFAULT_SESSION_KEY = "agent:main:main";
const DEFAULT_PROMPT_TEXT = "hello";

function createSessionAgentHarness(
  request: GatewayClient["request"],
  options: { sessionId?: string; sessionKey?: string; cwd?: string } = {},
) {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({
    sessionId,
    sessionKey,
    cwd: options.cwd ?? "/tmp",
  });
  const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
    sessionStore,
  });

  return {
    agent,
    sessionId,
    sessionKey,
    sessionStore,
  };
}

function promptAgent(
  agent: AcpGatewayAgent,
  sessionId = DEFAULT_SESSION_ID,
  text = DEFAULT_PROMPT_TEXT,
) {
  return agent.prompt({
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: {},
  } as unknown as PromptRequest);
}

async function createPendingPromptHarness(): Promise<PendingPromptHarness> {
  let runId: string | undefined;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chat.send") {
      runId = params?.idempotencyKey as string | undefined;
      return new Promise<never>(() => {});
    }
    return {};
  }) as GatewayClient["request"];

  const { agent, sessionId } = createSessionAgentHarness(request);
  const promptPromise = promptAgent(agent, sessionId);

  await vi.waitFor(() => {
    expect(runId).toBeDefined();
  });

  return {
    agent,
    promptPromise,
    runId: runId!,
  };
}

function createChatEvent(payload: Record<string, unknown>): EventFrame {
  return {
    type: "event",
    event: "chat",
    payload,
  } as EventFrame;
}

describe("acp translator errorKind mapping", () => {
  it("maps errorKind: refusal to stopReason: refusal", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "refusal",
        errorMessage: "I cannot fulfill this request.",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "refusal" });
  });

  it("maps errorKind: timeout to stopReason: end_turn", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "timeout",
        errorMessage: "gateway timeout",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("maps unknown errorKind to stopReason: end_turn", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "unknown",
        errorMessage: "something went wrong",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });
});
