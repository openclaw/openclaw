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

async function createPendingPromptHarness(): Promise<PendingPromptHarness> {
  const sessionId = "session-1";
  const sessionKey = "agent:main:main";

  let runId: string | undefined;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chat.send") {
      runId = params?.idempotencyKey as string | undefined;
      return new Promise<never>(() => {});
    }
    return {};
  }) as GatewayClient["request"];

  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({
    sessionId,
    sessionKey,
    cwd: "/tmp",
  });

  const agent = new AcpGatewayAgent(
    createAcpConnection(),
    createAcpGateway(request as unknown as GatewayClient["request"]),
    { sessionStore },
  );
  const promptPromise = agent.prompt({
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
    _meta: {},
  } as unknown as PromptRequest);

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

describe("acp translator stop reason mapping", () => {
  it("error state resolves as end_turn, not refusal", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "error",
        errorMessage: "gateway timeout",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("error state with no errorMessage resolves as end_turn", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "error",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("error state with errorKind resolves as end_turn", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "error",
        errorKind: "rate_limit",
        errorMessage: "too many requests",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("error state with refusal errorKind resolves as end_turn", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "error",
        errorKind: "refusal",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("aborted state resolves as cancelled", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "aborted",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "cancelled" });
  });
});
