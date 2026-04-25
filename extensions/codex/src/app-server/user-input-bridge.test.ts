import { describe, expect, it, vi } from "vitest";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

function createParams() {
  const onBlockReply = vi.fn();
  return {
    paramsForRun: {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      onBlockReply,
    } as unknown as Parameters<typeof createCodexUserInputBridge>[0]["paramsForRun"],
    onBlockReply,
  };
}

describe("Codex app-server user input bridge", () => {
  it("prompts the originating chat and resolves request_user_input from the next queued message", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params.paramsForRun,
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
      paramsForRun: params.paramsForRun,
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
      paramsForRun: params.paramsForRun,
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
      paramsForRun: params.paramsForRun,
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
            question:
              "Open \u001b]8;;https://example.invalid\u0007visible\u001b]8;;\u0007? dangling \u001b]8;;https://evil.example",
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
    expect(text).toContain("Open visible? dangling");
    expect(text).toContain("Fast");
    expect(text).toContain("Use less reasoning");
    expect(text).not.toContain("https://example.invalid");
    expect(text).not.toContain("https://evil.example");
    const unsafeDisplayControls = new RegExp(
      String.raw`[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u200b-\u200f]`,
    );
    expect(text.replace(/\n/g, "")).not.toMatch(unsafeDisplayControls);
  });

  it("caps oversized request_user_input prompt fields before forwarding to chat", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params.paramsForRun,
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

  it("bounds request_user_input question and option counts before prompt formatting", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params.paramsForRun,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const options = Array.from({ length: 60 }, (_, index) => ({
      label: `Option ${index + 1}`,
      description: "",
    }));
    const questions = Array.from({ length: 25 }, (_, index) => ({
      id: `q${index + 1}`,
      header: `Header ${index + 1}`,
      question: `Question ${index + 1}`,
      isOther: false,
      isSecret: false,
      options: index === 0 ? options : null,
    }));

    const response = bridge.handleRequest({
      id: "input-6",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions,
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    const text = vi.mocked(params.onBlockReply).mock.calls[0]?.[0].text ?? "";
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("Header 20");
    expect(text).not.toContain("Header 21");
    expect(text).toContain("Option 50");
    expect(text).not.toContain("Option 51");
    expect(bridge.handleQueuedMessage("q20: final\nq21: ignored")).toBe(true);
    await expect(response).resolves.toMatchObject({
      answers: {
        q20: { answers: ["final"] },
      },
    });
  });
});
