import { claimPendingAgentQuestionAnswer } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexServerRequestResolvedError } from "./server-requests.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { createCodexUserInputTestParams as createParams } from "./user-input-bridge.test-support.js";
import { createUserInputGateway as createGatewayStub } from "./user-input-gateway.test-support.js";

afterEach(() => {
  vi.useRealTimers();
});

function requestParams(overrides: Record<string, unknown> = {}, secret = false) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "tool-1",
    questions: [
      {
        id: secret ? "token" : "choice",
        header: secret ? "Secret" : "Mode",
        question: secret ? "Enter token" : "Pick a mode",
        isOther: secret,
        isSecret: secret,
        options: secret ? null : [{ label: "Deep", description: "Use more reasoning" }],
      },
    ],
    ...overrides,
  };
}

function setup(
  options: Pick<
    Parameters<typeof createCodexUserInputBridge>[0],
    "signal" | "gatewayCall" | "onOrdinaryResponse"
  > = {},
) {
  const params = createParams(options.signal);
  const gateway = createGatewayStub();
  const onOrdinaryResponse = vi.fn();
  const bridge = createCodexUserInputBridge({
    paramsForRun: params,
    threadId: "thread-1",
    turnId: "turn-1",
    gatewayCall: gateway.call,
    onOrdinaryResponse,
    ...options,
  });
  const request = (id: string, input = requestParams()) =>
    bridge.handleRequest({ id, params: input });
  const answerText = (text: string) =>
    claimPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text });
  const prompt = async (count = 1) => {
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(count));
    return vi.mocked(params.onBlockReply!).mock.calls[count - 1]![0];
  };
  return { params, gateway, onOrdinaryResponse, bridge, request, answerText, prompt };
}

function expectCancelled(gateway: ReturnType<typeof createGatewayStub>) {
  expect(gateway.calls).toContainEqual(
    expect.objectContaining({
      method: "question.resolve",
      params: expect.objectContaining({ cancel: true, resolvedBy: "run-abort" }),
    }),
  );
}

describe("Codex app-server user input bridge", () => {
  it.each([false, true])("cancels the gateway record (already resolved: %s)", async (resolved) => {
    const controller = new AbortController();
    const { prompt, gateway, onOrdinaryResponse, bridge } = setup({
      signal: resolved ? undefined : controller.signal,
    });
    const response = bridge.handleRequest(
      { id: resolved ? 42 : "input-abort", params: requestParams() },
      resolved ? controller.signal : undefined,
    );
    await prompt();
    const lateAnswer =
      !resolved &&
      gateway.call("question.resolve", {}, { answers: { answers: { choice: ["Late answer"] } } });
    controller.abort(resolved ? new CodexServerRequestResolvedError() : undefined);
    await lateAnswer;
    const returned = await response;
    expect(returned).toEqual({ answers: {} });
    expect(onOrdinaryResponse).toHaveBeenCalledTimes(resolved ? 0 : 1);
    if (!resolved) {
      expect(onOrdinaryResponse.mock.calls[0]?.[0].response).toBe(returned);
    }
    expectCancelled(gateway);
  });

  it("records one response when the Gateway wait rejects and settles queued work", async () => {
    const firstWait = createDeferred<unknown>();
    let firstPending = true;
    const gateway = createGatewayStub(async () => {
      if (!firstPending) {
        return { status: "answered", answers: { answers: { choice: ["Deep"] } } };
      }
      firstPending = false;
      return await firstWait.promise;
    });
    const { prompt, onOrdinaryResponse, request } = setup({
      gatewayCall: gateway.call,
    });
    const first = request("first", requestParams({ itemId: "first" }));
    await prompt();
    const second = request("second", requestParams({ itemId: "second" }));
    expect(gateway.calls.filter(({ method }) => method === "question.request")).toHaveLength(1);
    firstWait.reject(new Error("Gateway wait failed"));
    const response = await first;
    expect(response).toEqual({ answers: {} });
    await expect(second).resolves.toEqual({ answers: { choice: { answers: ["Deep"] } } });
    expect(onOrdinaryResponse.mock.calls.map(([result]) => result.itemId)).toEqual([
      "first",
      "second",
    ]);
    expect(onOrdinaryResponse.mock.calls[0]?.[0].response).toBe(response);
  });

  it("does not register a gateway question after the run already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { params, gateway, request } = setup({ signal: controller.signal });

    await expect(request("input-already-aborted")).resolves.toEqual({ answers: {} });
    expect(gateway.calls).toEqual([]);
    expect(params.onBlockReply).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses warned text-only input only for own isSecret (%s)",
    async (secret) => {
      const { prompt, gateway, onOrdinaryResponse, request, answerText } = setup();
      const { isSecret, ...question } = requestParams({}, true).questions[0]!;
      const response = request(
        "input-secret",
        requestParams({
          questions: [
            secret
              ? { ...question, isSecret }
              : Object.assign(Object.create({ isSecret }), question),
          ],
        }),
      );
      const payload = await prompt();
      expect(payload.text?.includes("This channel may show your reply")).toBe(secret);
      if (secret) {
        expect(payload.channelData).toBeUndefined();
        expect(gateway.calls).toHaveLength(0);
      } else {
        expect(gateway.calls.some((entry) => entry.method === "question.request")).toBe(true);
      }
      await expect(answerText("private")).resolves.toBe(true);
      await expect(response).resolves.toEqual({ answers: { token: { answers: ["private"] } } });
      expect(onOrdinaryResponse).toHaveBeenCalledTimes(secret ? 0 : 1);
    },
  );

  it("queues a replacement secret request when an earlier prompt later fails", async () => {
    const firstDelivery = createDeferred<void>();
    const { params, prompt, request, answerText } = setup({ gatewayCall: undefined });
    params.onBlockReply = vi
      .fn()
      .mockReturnValueOnce(firstDelivery.promise)
      .mockResolvedValue(undefined);

    const first = request("input-secret-replaced", requestParams({}, true));
    const replacement = request("input-secret-current", requestParams({}, true));
    expect((await prompt()).text).toContain("may show your reply");

    firstDelivery.reject(new Error("previous prompt delivery failed"));
    await expect(first).resolves.toEqual({ answers: {} });
    expect((await prompt(2)).text).toContain("may show your reply");

    await expect(answerText("replacement secret")).resolves.toBe(true);
    await expect(replacement).resolves.toEqual({
      answers: { token: { answers: ["replacement secret"] } },
    });
  });

  it("auto-resolves nonblocking gateway questions after exactly 120 seconds", async () => {
    vi.useFakeTimers();
    const gateway = createGatewayStub(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "pending" }), 120_000);
        }),
    );
    const { request } = setup({ gatewayCall: gateway.call });

    const response = request(
      "input-nonblocking",
      requestParams({ isBlocking: false, autoResolutionMs: 60_000 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(
      gateway.calls.find((entry) => entry.method === "question.request")?.params,
    ).toMatchObject({
      timeoutMs: 120_000,
    });

    await vi.advanceTimersByTimeAsync(119_999);
    const settled = vi.fn();
    void response.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(response).resolves.toEqual({ answers: {} });
  });
});
