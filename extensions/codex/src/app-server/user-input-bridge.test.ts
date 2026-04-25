import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

type TestParams = EmbeddedRunAttemptParams & {
  onBlockReply: NonNullable<EmbeddedRunAttemptParams["onBlockReply"]>;
};

function createParams(): TestParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    onBlockReply: vi.fn(),
  } as unknown as TestParams;
}

describe("Codex app-server user input bridge", () => {
  it("prompts the originating chat and resolves request_user_input from the next queued message", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-1",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "choice",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Fast", description: "Use less reasoning" },
              { label: "Deep", description: "Use more reasoning" },
            ],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    expect(params.onBlockReply).toHaveBeenCalledWith({
      text: expect.stringContaining("Pick a mode"),
    });
    expect(bridge.handleQueuedMessage("2")).toBe(true);

    await expect(response).resolves.toEqual({
      answers: { choice: { answers: ["Deep"] } },
    });
  });

  it("maps keyed multi-question replies to Codex answer ids", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-2",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "repo",
            header: "Repository",
            question: "Which repo?",
            isOther: true,
            isSecret: false,
            options: null,
          },
          {
            id: "scope",
            header: "Scope",
            question: "Which scope?",
            isOther: false,
            isSecret: false,
            options: [{ label: "Tests", description: "Only tests" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    expect(bridge.handleQueuedMessage("repo: openclaw\nscope: Tests")).toBe(true);

    await expect(response).resolves.toEqual({
      answers: {
        repo: { answers: ["openclaw"] },
        scope: { answers: ["Tests"] },
      },
    });
  });

  it("clears pending prompts when Codex resolves the server request itself", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-3",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "answer",
            header: "Answer",
            question: "Continue?",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    bridge.handleNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "input-3" },
    });

    await expect(response).resolves.toEqual({ answers: {} });
    expect(bridge.handleQueuedMessage("too late")).toBe(false);
  });

  it("sanitizes untrusted request_user_input prompt text before forwarding to chat", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    void bridge.handleRequest({
      id: "input-4",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "answer",
            header: "Mode\u202Eevil",
            question: "Open \u001b]8;;https://example.invalid\u0007visible\u001b]8;;\u0007?",
            isOther: true,
            isSecret: false,
            options: [
              {
                label: "Fast\u009b31m",
                description: "Use\u0000 less\u200b reasoning",
              },
            ],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    const text = vi.mocked(params.onBlockReply).mock.calls[0]?.[0].text ?? "";
    expect(text).toContain("Mode evil");
    expect(text).toContain("Open visible?");
    expect(text).toContain("Fast");
    expect(text).toContain("Use less reasoning");
    expect(text).not.toContain("https://example.invalid");
    const unsafeDisplayControls = new RegExp(
      String.raw`[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u200b-\u200f]`,
    );
    expect(text.replace(/\n/g, "")).not.toMatch(unsafeDisplayControls);
  });

  it("caps oversized request_user_input prompt fields before forwarding to chat", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const huge = "A".repeat(100_000);

    void bridge.handleRequest({
      id: "input-5",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "answer",
            header: huge,
            question: huge,
            isOther: false,
            isSecret: false,
            options: [{ label: huge, description: huge }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    const text = vi.mocked(params.onBlockReply).mock.calls[0]?.[0].text ?? "";
    expect(text.length).toBeLessThan(1200);
    expect(text).toContain("...");
    expect(text).not.toContain("A".repeat(1000));
  });
});
