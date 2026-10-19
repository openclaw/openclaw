import {
  claimPendingAgentQuestionAnswer,
  type AgentHarnessQuestionGatewayCall,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotUserInputBridge } from "./user-input-bridge.js";

type GatewayCallRecord = { method: string; opts: unknown; params: unknown };

function createGatewayStub() {
  const calls: GatewayCallRecord[] = [];
  const wait = createDeferred<unknown>();
  const call: AgentHarnessQuestionGatewayCall = async (method, opts, params) => {
    calls.push({ method, opts, params });
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
  return { call, calls };
}

function createHarness(signal?: AbortSignal) {
  const params = {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    agentId: "main",
    hostCapabilities: createCopilotTestHostCapabilities(),
    timeoutMs: 75_000,
    onBlockReply: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
  const gateway = createGatewayStub();
  const bridge = createCopilotUserInputBridge({
    paramsForRun: params,
    gatewayCall: gateway.call,
    signal,
  });
  return {
    params,
    gateway,
    bridge,
    ask: (request: Parameters<typeof bridge.onUserInputRequest>[0]) =>
      bridge.onUserInputRequest(request, { sessionId: "sdk-session-1" }),
    prompt: async () => {
      await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
      return vi.mocked(params.onBlockReply!).mock.calls[0]![0];
    },
  };
}

describe("Copilot user input bridge", () => {
  it("registers, presents, claims, and returns a selected option", async () => {
    const { params, gateway, ask, prompt } = createHarness();
    const response = ask({
      question: "Pick a mode",
      choices: ["Fast", "Deep"],
      allowFreeform: false,
    });
    const payload = await prompt();
    const request = gateway.calls[0];
    if (!request) {
      throw new Error("expected question.request");
    }

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
    expect(payload.channelData).toEqual({
      askUser: {
        questionId: (request.params as { id: string }).id,
        optionValues: ["Fast", "Deep"],
      },
    });
    expect(payload.presentationTextMode).toBe("fallback");
    expect(payload.text).toContain("Reply with the number or option text.");
    expect(payload.text).not.toContain("your own answer");

    await expect(
      claimPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text: "2" }),
    ).resolves.toBe(true);
    await expect(response).resolves.toEqual({ answer: "Deep", wasFreeform: false });
  });

  it("supports option-less free-form questions", async () => {
    const { params, gateway, ask, prompt } = createHarness();
    const response = ask({ question: "Which branch?", allowFreeform: true });
    expect((await prompt()).presentation).toBeUndefined();
    expect(gateway.calls[0]?.params).toMatchObject({
      questions: [expect.objectContaining({ options: [] })],
    });

    await claimPendingAgentQuestionAnswer({
      sessionKey: params.sessionKey,
      text: "fix/harness-parity",
    });
    await expect(response).resolves.toEqual({ answer: "fix/harness-parity", wasFreeform: true });
  });

  it("escapes SDK-controlled prompt text before delivery", async () => {
    const { bridge, ask, prompt } = createHarness();
    const response = ask({
      question: "Pick [trusted](https://evil) <@U123> @here\u202e",
      choices: ["One @everyone", "Two `code`"],
      allowFreeform: false,
    });
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

  it("cancels the gateway record and returns an empty answer on abort", async () => {
    const controller = new AbortController();
    const { gateway, ask, prompt } = createHarness(controller.signal);
    const response = ask({ question: "Continue?", choices: ["Yes", "No"], allowFreeform: false });
    await prompt();
    controller.abort();

    await expect(response).resolves.toEqual({ answer: "", wasFreeform: true });
    expect(gateway.calls).toContainEqual(
      expect.objectContaining({
        method: "question.resolve",
        params: expect.objectContaining({ cancel: true, resolvedBy: "run-abort" }),
      }),
    );
  });

  it("does not register a gateway question after the run already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { params, gateway, ask } = createHarness(controller.signal);

    await expect(
      ask({ question: "Continue?", choices: ["Yes", "No"], allowFreeform: false }),
    ).resolves.toEqual({ answer: "", wasFreeform: true });
    expect(gateway.calls).toEqual([]);
    expect(params.onBlockReply).not.toHaveBeenCalled();
  });
});
