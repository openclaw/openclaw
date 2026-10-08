import { describe, expect, it, vi } from "vitest";
import { expectOversizedPromptRejected } from "./translator.bridge-test-helpers.js";
import {
  createChatEvent,
  createPendingPromptHarness,
  DEFAULT_SESSION_KEY,
} from "./translator.prompt-harness.test-support.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

describe("acp final chat snapshots", () => {
  it("streams append-only frames and emits only the final missing tail before settlement", async () => {
    const { agent, sessionUpdate, promptPromise, runId } = await createPendingPromptHarness();
    const send = (payload: Record<string, unknown>) =>
      agent.handleGatewayEvent(
        createChatEvent({ sessionKey: DEFAULT_SESSION_KEY, runId, ...payload }),
      );
    await send({ state: "delta", message: { content: [{ type: "text", text: "Hello" }] } });
    await send({ state: "delta", deltaText: " wide" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " wide" } },
    });
    await send({
      state: "delta",
      message: { content: [{ type: "text", text: "Hello wide" }] },
    });
    await send({
      state: "final",
      stopReason: "max_tokens",
      message: { content: [{ type: "text", text: "Hello wide world" }] },
    });
    await expect(promptPromise).resolves.toEqual({ stopReason: "max_tokens" });
    expect(
      sessionUpdate.mock.calls.flatMap(([notification]) =>
        notification.update.sessionUpdate === "agent_message_chunk"
          ? [notification.update.content]
          : [],
      ),
    ).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " wide" },
      { type: "text", text: " world" },
    ]);
  });
});

describe("acp prompt size hardening", () => {
  it("rejects oversized prompt blocks without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-oversize",
      text: "a".repeat(2 * 1024 * 1024 + 1),
    });
  });

  it("rejects oversize final messages from cwd prefix without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-prefix",
      text: "a".repeat(2 * 1024 * 1024),
    });
  });
});
