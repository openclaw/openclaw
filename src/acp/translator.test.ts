import { describe, expect, it, vi } from "vitest";
import { AcpGatewayAgent } from "./translator.js";

type InternalPendingPrompt = {
  sessionId: string;
  sessionKey: string;
  idempotencyKey: string;
  resolve: (response: { stopReason: string }) => void;
  reject: (err: Error) => void;
  sentTextLength?: number;
  sentText?: string;
};

type InternalAgent = {
  pendingPrompts: Map<string, InternalPendingPrompt>;
};

describe("AcpGatewayAgent chat final handling", () => {
  it("flushes final message text before resolving pending prompt", async () => {
    // Fix regression: text that arrived within the 150ms throttle window is
    // never emitted as a delta event. The final event carries the complete
    // buffered text; handleChatEvent must call handleDeltaEvent(…) with that
    // text before resolving the pending prompt so the client receives the
    // incremental chunk it missed.

    const sessionUpdate = vi.fn().mockResolvedValue(undefined);

    // Minimal AgentSideConnection mock — only sessionUpdate is exercised.
    const connection = { sessionUpdate } as unknown as ConstructorParameters<
      typeof AcpGatewayAgent
    >[0];

    // Minimal GatewayClient mock — not called in this test path.
    const gateway = {} as unknown as ConstructorParameters<typeof AcpGatewayAgent>[1];

    const agent = new AcpGatewayAgent(connection, gateway, {});

    // Inject a pending prompt directly, simulating that a `prompt()` call is
    // in-flight and 5 chars ("Hello") have already been streamed as deltas.
    const resolve = vi.fn();
    const reject = vi.fn();
    (agent as unknown as InternalAgent).pendingPrompts.set("session-final", {
      sessionId: "session-final",
      sessionKey: "sk-final",
      idempotencyKey: "run-final",
      resolve,
      reject,
      sentTextLength: 5,
      sentText: "Hello",
    });

    // Deliver a `final` chat event carrying the complete text "Hello world".
    // The 6 new chars (" world") must be flushed via sessionUpdate before
    // resolve() is called.
    await agent.handleGatewayEvent({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "sk-final",
        runId: "run-final",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          timestamp: Date.now(),
        },
      },
    });

    // sessionUpdate must have been called with the incremental chunk " world"
    const updateCalls = sessionUpdate.mock.calls as Array<
      [
        {
          sessionId: string;
          update: { sessionUpdate: string; content?: { type: string; text: string } };
        },
      ]
    >;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const chunkCall = updateCalls.find(
      ([req]) => req.update.sessionUpdate === "agent_message_chunk",
    );
    expect(chunkCall).toBeDefined();
    expect(chunkCall?.[0].update.content?.text).toBe(" world");

    // resolve() must have been called with end_turn stop reason
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ stopReason: "end_turn" });
  });
});
