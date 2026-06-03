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

  it("renders multi-question prompts one question at a time, posting Q2 as a new reply after Q1 is answered", async () => {
    // Captures the channel-side behavior the user reported: with
    // Codex's request_user_input tool, a single call can contain
    // multiple questions. The bridge now renders Q1 alone, waits for
    // the answer, and posts Q2 as a brand-new reply. The merged answer
    // is sent back to Codex as a single response.
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-seq-1",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "feature",
            header: "Feature",
            question: "Which fake feature should the plan pretend to build?",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Demo panel (Recommended)",
                description: "Plans a tiny visible UI/status panel",
              },
              { label: "CLI flag", description: "Plans a no-op command flag and CLI tests" },
              { label: "Docs note", description: "Plans a documentation-only change" },
            ],
          },
          {
            id: "approval",
            header: "Approval",
            question: "Do you approve this fake plan for implementation after Plan Mode ends?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Approve (Recommended)", description: "Records approval intent" },
              { label: "Revise first", description: "Keeps the plan in discussion" },
              { label: "Do not implement", description: "Planning-only exercise" },
            ],
          },
        ],
      },
    });

    // Step 1: bridge posts Q1 (Feature) only.
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    const q1Payload = vi.mocked(params.onBlockReply).mock.calls[0]?.[0];
    expect(q1Payload?.text).toContain("Which fake feature");
    expect(q1Payload?.text).not.toContain("Do you approve this fake plan");
    const q1Block = q1Payload?.presentation?.blocks.find(
      (entry): entry is { buttons: Array<{ label: string; value?: string }> } =>
        entry.type === "buttons",
    );
    expect(q1Block?.buttons.map((b) => b.label)).toEqual([
      "Demo panel (Recommended)",
      "CLI flag",
      "Docs note",
    ]);
    // No "Feature:" prefix when only one question is on screen.
    expect(q1Block?.buttons.every((b) => !b.label.startsWith("Feature:"))).toBe(true);

    // Step 2: user clicks Q1 button 0 (Demo panel). The bridge posts
    // Q2 (Approval) as a brand-new reply, then returns the merged
    // answer to Codex.
    const q1Callback = q1Block?.buttons[0]?.value?.slice("codex:".length) ?? "";
    expect(
      answerCodexUserInputCallback({
        payload: q1Callback,
        ctx: {
          channel: "discord",
          senderId: "user-1",
          accountId: "default",
          sessionKey: "agent:main:session-1",
          messageThreadId: "channel-1",
        },
        sessionFile: "/tmp/session.jsonl",
      }),
    ).toBe("");

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(2));
    const q2Payload = vi.mocked(params.onBlockReply).mock.calls[1]?.[0];
    expect(q2Payload?.text).toContain("Do you approve this fake plan");
    expect(q2Payload?.text).not.toContain("Which fake feature");
    const q2Block = q2Payload?.presentation?.blocks.find(
      (entry): entry is { buttons: Array<{ label: string; value?: string }> } =>
        entry.type === "buttons",
    );
    expect(q2Block?.buttons.map((b) => b.label)).toEqual([
      "Approve (Recommended)",
      "Revise first",
      "Do not implement",
    ]);
    expect(q2Block?.buttons.every((b) => !b.label.startsWith("Approval:"))).toBe(true);

    // Step 3: user clicks Q2 button 0 (Approve). The bridge resolves
    // the original request with a merged answer covering both questions.
    const q2Callback = q2Block?.buttons[0]?.value?.slice("codex:".length) ?? "";
    expect(
      answerCodexUserInputCallback({
        payload: q2Callback,
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
      answers: {
        feature: { answers: ["Demo panel (Recommended)"] },
        approval: { answers: ["Approve (Recommended)"] },
      },
    });

    // No third reply was posted (the bridge would have raised if a
    // fourth Q had been queued).
    expect(params.onBlockReply).toHaveBeenCalledTimes(2);
  });
});
