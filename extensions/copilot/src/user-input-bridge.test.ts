import { expectDefined } from "@openclaw/normalization-core";
import {
  claimPendingAgentQuestionAnswer,
  type AgentHarnessQuestionGatewayCall,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotUserInputBridge } from "./user-input-bridge.js";

function createHarness(signal?: AbortSignal) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const wait = createDeferred<unknown>();
  const call: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
    calls.push({ method, params });
    if (method === "question.request") {
      return { id: (params as { id: string }).id, expiresAtMs: Date.now() + 75_000 };
    }
    if (method === "question.waitAnswer") {
      return await wait.promise;
    }
    if (method === "question.resolve") {
      const resolved = params as {
        answers?: { answers: Record<string, string[]> };
        cancel?: boolean;
      };
      const result = resolved.cancel
        ? { status: "cancelled" as const }
        : { status: "answered" as const, answers: resolved.answers! };
      wait.resolve(result);
      return result;
    }
    throw new Error(`unexpected gateway method: ${method}`);
  };
  const params = {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    agentId: "main",
    hostCapabilities: createCopilotTestHostCapabilities(),
    timeoutMs: 75_000,
    onBlockReply: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
  const bridge = createCopilotUserInputBridge({
    paramsForRun: params,
    gatewayCall: call,
    signal,
  });
  return {
    params,
    calls,
    bridge,
    ask: (question: string, choices?: string[]) =>
      bridge.onUserInputRequest(
        { question, choices, allowFreeform: !choices },
        { sessionId: "sdk-session-1" },
      ),
    answer: (text: string) =>
      claimPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text }),
    prompt: async () => {
      await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
      return vi.mocked(params.onBlockReply!).mock.calls[0]![0];
    },
  };
}

describe("Copilot user input bridge", () => {
  it("registers, presents, claims, and returns a selected option", async () => {
    const { calls, ask, answer, prompt } = createHarness();
    const response = ask("Pick a mode", ["Fast", "Deep"]);
    const payload = await prompt();
    const request = expectDefined(calls[0], "question.request");
    expect(request.params).toMatchObject({
      sessionKey: "agent:main:session-1",
      agentId: "main",
      timeoutMs: 75_000,
      questions: [
        expect.objectContaining({
          questionId: "answer",
          options: [{ label: "Fast" }, { label: "Deep" }],
        }),
      ],
    });
    const questionId = (request.params as { id: string }).id;
    expect(payload.channelData).toEqual({
      askUser: { questionId, optionValues: ["Fast", "Deep"] },
    });
    expect(payload.presentationTextMode).toBe("fallback");
    expect(payload.text).toContain("Reply with the number or option text.");
    expect(payload.text).not.toContain("your own answer");
    await expect(answer("2")).resolves.toBe(true);
    await expect(response).resolves.toEqual({ answer: "Deep", wasFreeform: false });
  });

  it("supports option-less free-form questions", async () => {
    const { calls, ask, answer, prompt } = createHarness();
    const response = ask("Which branch?");
    expect((await prompt()).presentation).toBeUndefined();
    expect(calls[0]?.params).toMatchObject({
      questions: [expect.objectContaining({ options: [] })],
    });
    await answer("fix/harness-parity");
    await expect(response).resolves.toEqual({ answer: "fix/harness-parity", wasFreeform: true });
  });

  it("escapes SDK-controlled prompt text before delivery", async () => {
    const { bridge, ask, prompt } = createHarness();
    const response = ask("Pick [trusted](https://evil) <@U123> @here\u202e", [
      "One @everyone",
      "Two `code`",
    ]);
    const { text = "", presentation } = await prompt();
    expect(text).not.toContain("`code`");
    expect(text).toContain("\uff20here");
    expect(text).toContain("\uff3btrusted\uff3d");
    const visiblePresentation = presentation?.blocks.map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "buttons"
          ? block.buttons.map((button) => button.label).join(" ")
          : "",
    );
    for (const unsafe of ["@here", "@everyone", "<@U123>", "[trusted](https://evil)"]) {
      expect(text).not.toContain(unsafe);
      expect(JSON.stringify(visiblePresentation)).not.toContain(unsafe);
    }
    bridge.cancelPending();
    await response;
  });

  it.each(["before", "after"])("handles abort %s registration", async (when) => {
    const controller = new AbortController();
    if (when === "before") {
      controller.abort();
    }
    const { params, calls, ask, prompt } = createHarness(controller.signal);
    const response = ask("Continue?", ["Yes", "No"]);
    if (when === "after") {
      await prompt();
      controller.abort();
    }
    await expect(response).resolves.toEqual({ answer: "", wasFreeform: true });
    if (when === "before") {
      expect(calls).toEqual([]);
      expect(params.onBlockReply).not.toHaveBeenCalled();
    } else {
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "question.resolve",
          params: expect.objectContaining({ cancel: true, resolvedBy: "run-abort" }),
        }),
      );
    }
  });
});
