import assert from "node:assert/strict";
import { claimPendingAgentQuestionAnswer } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { isJsonObject } from "./protocol.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { createCodexUserInputTestParams as createParams } from "./user-input-bridge.test-support.js";
import { createUserInputGateway } from "./user-input-gateway.test-support.js";

function formParams(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "forms",
    mode: "form",
    message: "Complete the profile",
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string", title: "Name" } },
      required: ["name"],
    },
    ...overrides,
  };
}

function emptyFormParams(overrides: Record<string, unknown> = {}) {
  return formParams({
    requestedSchema: { type: "object", properties: {} },
    message: "Confirm the requested action",
    ...overrides,
  });
}

function createGateway(
  waitAnswer: (id: string) => unknown,
  cancel: (id: string) => void = () => {},
) {
  const gateway = createUserInputGateway(waitAnswer, cancel);
  const params = createParams();
  const bridge = createCodexUserInputBridge({
    paramsForRun: params,
    threadId: "thread-1",
    turnId: "turn-1",
    gatewayCall: gateway.call,
  });
  const request = (id: string, input = formParams(), signal?: AbortSignal) =>
    bridge.handleElicitationRequest({ id, params: input }, signal);
  return { ...gateway, params, request, cancelPending: () => bridge.cancelPending() };
}

function createAnsweringGateway(answerBatches: Array<Record<string, string[]>>) {
  let answerIndex = 0;
  return createGateway(() => {
    const answers = answerBatches[answerIndex++];
    assert(answers, "missing gateway answer batch");
    return { status: "answered", answers: { answers } };
  });
}

function createControlledGateway() {
  const waits = new Map<string, (value: unknown) => void>();
  const gateway = createGateway(
    (id) =>
      new Promise((resolve) => {
        waits.set(id, resolve);
      }),
    (id) => {
      waits.get(id)?.({ status: "cancelled" });
    },
  );
  return {
    ...gateway,
    async waitForAnswers(count: number) {
      await vi.waitFor(() =>
        expect(gateway.calls.filter(({ method }) => method === "question.waitAnswer")).toHaveLength(
          count,
        ),
      );
    },
    answer(questionId: string, answers: Record<string, string[]>) {
      waits.get(questionId)?.({ status: "answered", answers: { answers } });
    },
  };
}

function expectResult(response: Promise<unknown>, action: string, content: unknown = null) {
  return expect(response).resolves.toEqual({ action, content, _meta: null });
}

describe("Codex ordinary MCP elicitation adapter", () => {
  it.each([
    { mode: "form", choice: "Allow", action: "accept", meta: null },
    { mode: "openai/form", choice: "Decline", action: "decline", meta: null },
  ])("waits for $choice before answering an empty $mode form ($meta)", async (testCase) => {
    const gateway = createControlledGateway();
    const { params } = gateway;
    const requestParams = emptyFormParams({ mode: testCase.mode, _meta: testCase.meta });
    const response = gateway.request("empty", requestParams);
    const settled = vi.fn();
    void response.then(settled);
    try {
      await gateway.waitForAnswers(1);
      await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
      expect(settled).not.toHaveBeenCalled();
      const prompt = vi.mocked(params.onBlockReply!).mock.calls[0]?.[0];
      expect(prompt?.text).toContain(requestParams.message);
      const request = gateway.questions[0]!;
      expect(request.questions).toHaveLength(1);
      const question = request.questions[0];
      assert(isJsonObject(question) && typeof question.questionId === "string");
      gateway.answer(request.id, { [question.questionId]: [testCase.choice] });
      await expectResult(response, testCase.action, testCase.action === "accept" ? {} : null);
    } finally {
      await gateway.cancelPending();
    }
  });

  it("cancels an empty form without letting its late answer resolve the next queued form", async () => {
    const gateway = createControlledGateway();
    const controller = new AbortController();
    const confirmation = gateway.request("empty", emptyFormParams(), controller.signal);
    const successor = gateway.request("successor");
    try {
      await gateway.waitForAnswers(1);
      expect(gateway.questions).toHaveLength(1);
      const first = gateway.questions[0]!;
      const question = first.questions[0];
      assert(isJsonObject(question) && typeof question.questionId === "string");
      controller.abort();
      gateway.answer(first.id, { [question.questionId]: ["Allow"] });
      await expectResult(confirmation, "cancel");
      await gateway.waitForAnswers(2);
      const second = gateway.questions[1]!;
      expect(second.id).not.toBe(first.id);
      gateway.answer(second.id, { name: ["Ada"] });
      await expectResult(successor, "accept", { name: "Ada" });
    } finally {
      await gateway.cancelPending();
    }
  });

  it("uses only direct isSecret metadata and never persists that field in Gateway questions", async () => {
    const gateway = createAnsweringGateway([{ password: ["public-value"] }]);
    const { params } = gateway;
    const response = gateway.request(
      "secret-metadata",
      formParams({
        requestedSchema: {
          type: "object",
          properties: {
            password: { type: "string" },
            token: { type: "string", isSecret: true },
          },
          required: ["password", "token"],
        },
      }),
    );
    const replies = vi.mocked(params.onBlockReply!).mock.calls;
    await vi.waitFor(() =>
      expect(replies.some(([reply]) => reply.text?.includes("may show your reply"))).toBe(true),
    );
    await expect(
      claimPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text: "private-value" }),
    ).resolves.toBe(true);
    await expectResult(response, "accept", {
      password: "public-value",
      token: "private-value",
    });
    expect(JSON.stringify(gateway.questions)).not.toContain("token");
  });

  it("compiles a queued request before caller mutation and preserves FIFO", async () => {
    const gateway = createControlledGateway();
    const controller = new AbortController();
    const first = gateway.request("first", formParams(), controller.signal);
    await vi.waitFor(() => expect(gateway.questions).toHaveLength(1));

    const raw = formParams();
    const second = gateway.request("second", raw);
    (raw.requestedSchema.properties.name as { type: string }).type = "integer";

    controller.abort();
    await expectResult(first, "cancel");
    await vi.waitFor(() => expect(gateway.questions).toHaveLength(2));
    await gateway.waitForAnswers(2);
    const queued = gateway.questions[1]!;
    gateway.answer(queued.id, { name: ["Grace"] });
    await expectResult(second, "accept", { name: "Grace" });
  });

  it("skips a cancelled queued request promptly and preserves FIFO for its successor", async () => {
    const gateway = createControlledGateway();
    const active = gateway.request("active");
    const controller = new AbortController();
    const queued = gateway.request("queued", formParams(), controller.signal);
    const successor = gateway.request("successor");
    await vi.waitFor(() => expect(gateway.questions).toHaveLength(1));
    const queuedResult = vi.fn();
    void queued.then(queuedResult);
    controller.abort();
    await vi.waitFor(() => expect(queuedResult).toHaveBeenCalledOnce());
    await expect(queued).resolves.toMatchObject({ action: "cancel" });
    await gateway.waitForAnswers(1);
    const current = gateway.questions[0]!;
    gateway.answer(current.id, { name: ["Ada"] });
    await expect(active).resolves.toMatchObject({ action: "accept" });
    await vi.waitFor(() => expect(gateway.questions).toHaveLength(2));
    await gateway.waitForAnswers(2);
    gateway.answer(gateway.questions[1]!.id, { name: ["Grace"] });
    await expect(successor).resolves.toMatchObject({
      action: "accept",
      content: { name: "Grace" },
    });
  });

  it("lets lifecycle cancellation fence a late committed answer", async () => {
    const wait = createDeferred<unknown>();
    const gateway = createGateway(() => wait.promise);
    const controller = new AbortController();
    const response = gateway.request("late", formParams(), controller.signal);
    await vi.waitFor(() => expect(gateway.questions).toHaveLength(1));
    controller.abort();
    wait.resolve({ status: "answered", answers: { answers: { name: ["too late"] } } });
    await expectResult(response, "cancel");
  });

  it("recognizes openaiForm, URL, nullable turn, and exact scope envelopes", async () => {
    const gateway = createAnsweringGateway([
      { name: ["Ada"] },
      { continue: ["I've completed this step"] },
    ]);
    await expectResult(
      gateway.request("nullable", formParams({ turnId: null, mode: "openaiForm" })),
      "accept",
      { name: "Ada" },
    );
    await expectResult(
      gateway.request(
        "url",
        formParams({
          mode: "url",
          requestedSchema: undefined,
          url: "https://example.com/authorize",
          elicitationId: "auth-1",
        }),
      ),
      "accept",
    );
    expect(gateway.questions[1]?.questions).toContainEqual(
      expect.objectContaining({ url: "https://example.com/authorize" }),
    );
    await expect(
      gateway.request("wrong-turn", formParams({ turnId: "other" })),
    ).resolves.toBeUndefined();
    await expect(
      gateway.request("wrong-thread", formParams({ threadId: "other" })),
    ).resolves.toBeUndefined();
  });

  it("rejects inherited and accessor thread correlation without invoking getters", async () => {
    const gateway = createAnsweringGateway([]);
    const inherited = formParams();
    Object.setPrototypeOf(inherited, { threadId: "thread-1" });
    delete (inherited as Partial<typeof inherited>).threadId;
    const getter = vi.fn(() => "thread-1");
    const accessor = Object.defineProperty(formParams(), "threadId", {
      enumerable: true,
      get: getter,
    });

    for (const [id, params] of Object.entries({ inherited, accessor })) {
      await expect(gateway.request(id, params)).resolves.toBeUndefined();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(gateway.calls).toEqual([]);
  });

  it("rechecks thread correlation on the detached snapshot", async () => {
    const gateway = createAnsweringGateway([{ name: ["Ada"] }]);
    let threadReads = 0;
    const request = new Proxy(formParams(), {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "threadId" || !descriptor || !("value" in descriptor)) {
          return descriptor;
        }
        threadReads += 1;
        return { ...descriptor, value: threadReads === 1 ? "thread-1" : "other-thread" };
      },
    });

    await expect(gateway.request("changing-thread", request)).resolves.toBeUndefined();
    expect(threadReads).toBeGreaterThanOrEqual(2);
    expect(gateway.calls).toEqual([]);
  });

  it("preserves snapshot rejection and descriptor trap behavior", async () => {
    const gateway = createAnsweringGateway([]);
    const request = Object.defineProperty(formParams(), "threadId", {
      enumerable: false,
      value: "thread-1",
    });

    await expect(gateway.request("non-enumerable", request)).resolves.toMatchObject({
      action: "decline",
      _meta: { message: expect.stringContaining("malformed or over-limit") },
    });

    const trapped = new Proxy(formParams(), {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor unavailable");
      },
    });
    await expect(gateway.request("descriptor-trap", trapped)).rejects.toThrow(
      "descriptor unavailable",
    );
  });
});
