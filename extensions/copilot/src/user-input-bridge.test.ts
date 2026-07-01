// Copilot tests cover SDK ask_user bridge behavior.
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCopilotUserInputBridge } from "./user-input-bridge.js";

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    onBlockReply: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
}

function expectFirstBlockReplyText(params: EmbeddedRunAttemptParams): string {
  const onBlockReply = params.onBlockReply;
  if (!onBlockReply) {
    throw new Error("Expected onBlockReply callback");
  }
  const payload = vi.mocked(onBlockReply).mock.calls[0]?.[0];
  if (typeof payload?.text !== "string") {
    throw new Error("Expected first block reply text");
  }
  return payload.text;
}

describe("Copilot user input bridge", () => {
  it("prompts through OpenClaw and resolves the SDK request from the next queued message", async () => {
    const params = createParams();
    const bridge = createCopilotUserInputBridge({ paramsForRun: params });

    const response = bridge.onUserInputRequest(
      {
        question: "Pick a mode",
        choices: ["Fast", "Deep"],
        allowFreeform: false,
      },
      { sessionId: "sdk-session-1" },
    );

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    expect(expectFirstBlockReplyText(params)).toContain("Pick a mode");
    expect(bridge.handleQueuedMessage("2")).toBe(true);

    await expect(response).resolves.toEqual({ answer: "Deep", wasFreeform: false });
  });

  it("returns free-form answers when Copilot allows them", async () => {
    const params = createParams();
    const bridge = createCopilotUserInputBridge({ paramsForRun: params });

    const response = bridge.onUserInputRequest(
      {
        question: "Which branch?",
        allowFreeform: true,
      },
      { sessionId: "sdk-session-1" },
    );

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    expect(bridge.handleQueuedMessage("fix/harness-parity")).toBe(true);

    await expect(response).resolves.toEqual({
      answer: "fix/harness-parity",
      wasFreeform: true,
    });
  });

  it("escapes SDK-controlled prompt text before channel delivery", async () => {
    const params = createParams();
    const bridge = createCopilotUserInputBridge({ paramsForRun: params });

    void bridge.onUserInputRequest(
      {
        question: "Pick [trusted](https://evil) <@U123> @here\u202e",
        choices: ["One @everyone", "Two `code`"],
        allowFreeform: false,
      },
      { sessionId: "sdk-session-1" },
    );

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    const text = expectFirstBlockReplyText(params);
    expect(text).not.toContain("@here");
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("<@U123>");
    expect(text).not.toContain("[trusted](https://evil)");
    expect(text).not.toContain("`code`");
    expect(text).toContain("\uff20here");
    expect(text).toContain("\uff3btrusted\uff3d");
  });

  it("rejects queued messages when no ask_user request is pending", () => {
    const bridge = createCopilotUserInputBridge({ paramsForRun: createParams() });

    expect(bridge.handleQueuedMessage("late")).toBe(false);
  });

  it("resolves pending requests with an empty answer when aborted", async () => {
    const params = createParams();
    const controller = new AbortController();
    const bridge = createCopilotUserInputBridge({
      paramsForRun: params,
      signal: controller.signal,
    });

    const response = bridge.onUserInputRequest(
      {
        question: "Continue?",
        choices: ["Yes", "No"],
        allowFreeform: false,
      },
      { sessionId: "sdk-session-1" },
    );

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(response).resolves.toEqual({ answer: "", wasFreeform: true });
    expect(bridge.handleQueuedMessage("1")).toBe(false);
  });
});
