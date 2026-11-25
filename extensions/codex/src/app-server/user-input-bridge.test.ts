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
        options: secret
          ? null
          : [
              { label: "Fast", description: "Use less reasoning" },
              { label: "Deep", description: "Use more reasoning" },
            ],
      },
    ],
    ...overrides,
  };
}

function secretRequestParams(overrides: Record<string, unknown> = {}) {
  return requestParams(overrides, true);
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
  return { params, gateway, onOrdinaryResponse, bridge, request, answerText };
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
  it("cancels the gateway record on run abort", async () => {
    const controller = new AbortController();
    const { params, gateway, onOrdinaryResponse, bridge } = setup({ signal: controller.signal });
    const response = bridge.handleRequest({ id: "input-abort", params: requestParams() });
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    const lateAnswer = gateway.call(
      "question.resolve",
      {},
      { answers: { answers: { choice: ["Late answer"] } } },
    );
    controller.abort();
    await lateAnswer;
    const returned = await response;
    expect(returned).toEqual({ answers: {} });
    expect(onOrdinaryResponse).toHaveBeenCalledOnce();
    expect(onOrdinaryResponse.mock.calls[0]?.[0].response).toBe(returned);
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
    const { params, onOrdinaryResponse, request } = setup({
      gatewayCall: gateway.call,
    });
    const first = request("first", requestParams({ itemId: "first" }));
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
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

  it("keeps secret questions on the warned text-only path", async () => {
    const { params, gateway, onOrdinaryResponse, request, answerText } = setup();
    const response = request("input-secret", secretRequestParams());
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());

    const payload = vi.mocked(params.onBlockReply!).mock.calls[0]![0];
    expect(payload.text).toContain("This channel may show your reply");
    expect(payload.channelData).toBeUndefined();
    expect(gateway.calls).toHaveLength(0);
    await expect(answerText("private")).resolves.toBe(true);
    await expect(response).resolves.toEqual({ answers: { token: { answers: ["private"] } } });
    expect(onOrdinaryResponse).not.toHaveBeenCalled();
  });

  it("requires isSecret to be an own input property", async () => {
    const { params, gateway, request, answerText } = setup();
    const question = Object.assign(Object.create({ isSecret: true }), {
      id: "token",
      header: "Token",
      question: "Enter token",
      isOther: true,
      options: null,
    });

    const response = request("input-inherited-secret", requestParams({ questions: [question] }));
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());

    expect(gateway.calls.some((entry) => entry.method === "question.request")).toBe(true);
    expect(vi.mocked(params.onBlockReply!).mock.calls[0]![0].text).not.toContain(
      "This channel may show your reply",
    );
    await answerText("public");
    await expect(response).resolves.toEqual({ answers: { token: { answers: ["public"] } } });
  });

  it("queues a replacement secret request when an earlier prompt later fails", async () => {
    const firstDelivery = createDeferred<void>();
    const { params, request, answerText } = setup({ gatewayCall: undefined });
    params.onBlockReply = vi
      .fn()
      .mockReturnValueOnce(firstDelivery.promise)
      .mockResolvedValue(undefined);

    const first = request("input-secret-replaced", secretRequestParams());
    const replacement = request("input-secret-current", secretRequestParams());
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));

    firstDelivery.reject(new Error("previous prompt delivery failed"));
    await expect(first).resolves.toEqual({ answers: {} });
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(params.onBlockReply!)
          .mock.calls.filter(([payload]) => payload.text?.includes("may show your reply")),
      ).toHaveLength(2),
    );

    await expect(answerText("replacement secret")).resolves.toBe(true);
    await expect(replacement).resolves.toEqual({
      answers: { token: { answers: ["replacement secret"] } },
    });
  });

  it("dismisses a resolved inbound request without recording an invented empty answer", async () => {
    const controller = new AbortController();
    const { params, gateway, onOrdinaryResponse, bridge } = setup();
    const response = bridge.handleRequest({ id: 42, params: requestParams() }, controller.signal);
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    controller.abort(new CodexServerRequestResolvedError());

    await expect(response).resolves.toEqual({ answers: {} });
    expect(onOrdinaryResponse).not.toHaveBeenCalled();
    expectCancelled(gateway);
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
