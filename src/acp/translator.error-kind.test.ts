/** Tests Gateway errorKind to ACP stopReason mapping and event handler error boundaries. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatEvent,
  createPendingPromptHarness,
  DEFAULT_SESSION_KEY,
} from "./translator.prompt-harness.test-support.js";

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

describe("handleGatewayEvent error boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("catches and logs handleChatEvent failures", async () => {
    const { agent, runId } = await createPendingPromptHarness();
    const log = vi.fn();
    (agent as unknown as { log: typeof log }).log = log;

    // Mock handleChatEvent to throw — simulates unexpected handler failure
    vi.spyOn(
      agent as unknown as { handleChatEvent: () => Promise<void> },
      "handleChatEvent",
    ).mockRejectedValue(new Error("chat handler crashed"));

    // handleGatewayEvent should catch the error, not reject
    await expect(
      agent.handleGatewayEvent(
        createChatEvent({
          runId,
          sessionKey: DEFAULT_SESSION_KEY,
          seq: 1,
          state: "delta",
        }),
      ),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("handleGatewayEvent failed");
    expect(log.mock.calls[0][0]).toContain("chat handler crashed");
  });
});
