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

  it("keeps in-flight prompts pending across transient gateway disconnects", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();
    const settleSpy = vi.fn();
    void promptPromise.then(
      (value) => settleSpy({ kind: "resolve", value }),
      (error) => settleSpy({ kind: "reject", error }),
    );

    agent.handleGatewayDisconnect("1006: connection lost");
    await Promise.resolve();

    expect(settleSpy).not.toHaveBeenCalled();

    agent.handleGatewayReconnect();
    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "final",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("rejects in-flight prompts when the gateway does not reconnect before the grace window", async () => {
    vi.useFakeTimers();
    try {
      const { agent, promptPromise } = await createPendingPromptHarness();
      void promptPromise.catch(() => {});

      agent.handleGatewayDisconnect("1006: connection lost");
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(promptPromise).rejects.toThrow("Gateway disconnected: 1006: connection lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pre-ack send disconnects inside the reconnect grace window", async () => {
    vi.useFakeTimers();
    try {
      const sessionStore = createInMemorySessionStore();
      sessionStore.createSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        cwd: "/tmp",
      });
      const request = vi.fn(async (method: string) => {
        if (method === "chat.send") {
          throw new Error("gateway closed (1006): connection lost");
        }
        return {};
      }) as GatewayClient["request"];
      const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
        sessionStore,
      });
      const promptPromise = agent.prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "hello" }],
        _meta: {},
      } as unknown as PromptRequest);
      const settleSpy = vi.fn();
      void promptPromise.then(
        (value) => settleSpy({ kind: "resolve", value }),
        (error) => settleSpy({ kind: "reject", error }),
      );

      await Promise.resolve();
      expect(settleSpy).not.toHaveBeenCalled();

      agent.handleGatewayDisconnect("1006: connection lost");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settleSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(promptPromise).rejects.toThrow("Gateway disconnected: 1006: connection lost");
    } finally {
      vi.useRealTimers();
    }
  });
});
