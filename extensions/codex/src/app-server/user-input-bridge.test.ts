import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerCodexUserInputCallback,
  resetCodexConversationChatControlsForTests,
} from "../conversation-chat-controls.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

const CODEX_CONTROL_DELIVERY_RESOLVERS_KEY = Symbol.for("openclaw.codex.controlDeliveryResolvers");

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    sessionKey: "agent:main:session-1",
    messageChannel: "discord",
    agentAccountId: "default",
    senderId: "user-1",
    messageThreadId: "channel-1",
    onBlockReply: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
}

function expectFirstBlockReplyText(params: EmbeddedRunAttemptParams): string {
  const onBlockReply = params.onBlockReply;
  if (onBlockReply === undefined) {
    throw new Error("Expected onBlockReply callback");
  }
  const payload = vi.mocked(onBlockReply).mock.calls[0]?.[0];
  if (typeof payload?.text !== "string") {
    throw new Error("Expected first block reply text");
  }
  return payload.text;
}

function expectFirstBlockReplyValues(params: EmbeddedRunAttemptParams): string[] {
  const onBlockReply = params.onBlockReply;
  if (onBlockReply === undefined) {
    throw new Error("Expected onBlockReply callback");
  }
  const payload = vi.mocked(onBlockReply).mock.calls[0]?.[0];
  const block = payload?.presentation?.blocks.find(
    (entry): entry is { buttons: Array<{ value?: string }> } => entry.type === "buttons",
  );
  return block?.buttons.map((button) => button.value ?? "") ?? [];
}

function expectFirstBlockReplyControlToken(params: EmbeddedRunAttemptParams): string {
  const onBlockReply = params.onBlockReply;
  if (onBlockReply === undefined) {
    throw new Error("Expected onBlockReply callback");
  }
  const payload = vi.mocked(onBlockReply).mock.calls[0]?.[0];
  const token = (payload?.channelData?.codex as { userInputControlToken?: string } | undefined)
    ?.userInputControlToken;
  if (!token) {
    throw new Error("Expected Codex user-input control token");
  }
  return token;
}

describe("Codex app-server user input bridge", () => {
  afterEach(() => {
    resetCodexConversationChatControlsForTests();
  });

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
            isOther: true,
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
    const promptText = expectFirstBlockReplyText(params);
    expect(promptText).toContain("Pick a mode");
    expect(promptText).toContain("Other: reply with your own answer.");
    const values = expectFirstBlockReplyValues(params);
    expect(values.map((value) => value.split(":").at(-1))).toEqual(["1", "2"]);
    expect(
      answerCodexUserInputCallback({
        payload: values[1]?.slice("codex:".length) ?? "",
        ctx: {
          channel: "discord",
          senderId: "user-1",
          accountId: "default",
          sessionKey: "agent:main:session-1",
          messageThreadId: "channel-1",
        },
        sessionFile: "/tmp/session.jsonl",
      }),
    ).toBe("Sent answer to Codex.");

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
    expect(bridge.handleQueuedMessage("repo: openclaw\nscope: Tests")).toEqual({
      handled: true,
      message: "Sent answer to Codex.",
    });

    await expect(response).resolves.toEqual({
      answers: {
        repo: { answers: ["openclaw"] },
        scope: { answers: ["Tests"] },
      },
    });
  });

  it("resolves delivered controls when queued text answers pending user input", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const response = bridge.handleRequest({
      id: "input-delivery",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: true,
            isSecret: false,
            options: [{ label: "Plan only", description: "No execution" }],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    const token = expectFirstBlockReplyControlToken(params);
    const resolver = vi.fn();
    resolveGlobalMap<string, () => void>(CODEX_CONTROL_DELIVERY_RESOLVERS_KEY).set(token, resolver);
    await Promise.resolve();

    expect(bridge.handleQueuedMessage("custom answer")).toEqual({
      handled: true,
      message: "Sent answer to Codex.",
    });
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    expect(
      resolveGlobalMap<string, () => void>(CODEX_CONTROL_DELIVERY_RESOLVERS_KEY).has(token),
    ).toBe(false);
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["custom answer"] } },
    });
  });

  it("rejects free-form option replies when Other is disabled", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-options",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [{ label: "Fast", description: "Use less reasoning" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    expect(bridge.handleQueuedMessage("banana")).toEqual({
      handled: true,
      message: "Sent answer to Codex.",
    });

    await expect(response).resolves.toEqual({
      answers: { mode: { answers: [] } },
    });
  });

  it("escapes prompt question and option text before chat display", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-escaped",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "mode",
            header: "Mode <@U123>",
            question: "Pick [trusted](https://evil) @here",
            isOther: false,
            isSecret: false,
            options: [{ label: "Fast <@U123>", description: "Use [less](https://evil)" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    const text = expectFirstBlockReplyText(params);
    expect(text).toContain("Mode &lt;\uff20U123&gt;");
    expect(text).toContain("Pick \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here");
    expect(text).toContain(
      "Fast &lt;\uff20U123&gt; - Use \uff3bless\uff3d\uff08https://evil\uff09",
    );
    expect(text).not.toContain("<@U123>");
    expect(text).not.toContain("[trusted](https://evil)");
    expect(text).not.toContain("@here");

    expect(bridge.handleQueuedMessage("1")).toEqual({
      handled: true,
      message: "Sent answer to Codex.",
    });
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Fast <@U123>"] } },
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
    expect(bridge.handleQueuedMessage("too late")).toEqual({ handled: false });
  });

  it("resolves malformed empty question prompts without waiting for chat input", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    await expect(
      bridge.handleRequest({
        id: "input-empty",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "tool-1",
          questions: [],
        },
      }),
    ).resolves.toEqual({ answers: {} });
    expect(params.onBlockReply).not.toHaveBeenCalled();
    expect(bridge.handleQueuedMessage("late answer")).toEqual({ handled: false });
  });
});
