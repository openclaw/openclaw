import assert from "node:assert/strict";
import {
  claimPendingAgentQuestionAnswer,
  type AgentHarnessQuestionGatewayCall,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { isJsonObject } from "./protocol.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { createCodexUserInputTestParams as createParams } from "./user-input-bridge.test-support.js";

type GatewayCallRecord = { method: string; params: unknown };

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

function createBridge(gatewayCall: AgentHarnessQuestionGatewayCall, paramsForRun = createParams()) {
  return createCodexUserInputBridge({
    paramsForRun,
    threadId: "thread-1",
    turnId: "turn-1",
    gatewayCall,
  });
}

function createGateway(
  waitAnswer: (id: string) => unknown,
  cancel: (id: string) => void = () => {},
) {
  const calls: GatewayCallRecord[] = [];
  const call: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
    calls.push({ method, params });
    const id = requireQuestionId(params);
    if (method === "question.request") {
      return { id };
    }
    if (method === "question.waitAnswer") {
      return await waitAnswer(id);
    }
    if (method !== "question.resolve") {
      throw new Error(`unexpected gateway method ${method}`);
    }
    cancel(id);
    return { status: "cancelled" };
  };
  return { call, calls };
}

function createAnsweringGateway(answerBatches: Array<Record<string, string[]>>) {
  let answerIndex = 0;
  return createGateway(() => {
    const answers = answerBatches[answerIndex++];
    if (!answers) {
      throw new Error("missing gateway answer batch");
    }
    return { status: "answered", answers: { answers } };
  });
}

function createControlledGateway() {
  const waits = new Map<string, (value: unknown) => void>();
  const { call, calls } = createGateway(
    (id) =>
      new Promise((resolve) => {
        waits.set(id, resolve);
      }),
    (id) => {
      waits.get(id)?.({ status: "cancelled" });
    },
  );
  return {
    call,
    calls,
    async waitForAnswers(count: number) {
      await vi.waitFor(() =>
        expect(calls.filter((entry) => entry.method === "question.waitAnswer")).toHaveLength(count),
      );
    },
    answer(questionId: string, answers: Record<string, string[]>) {
      waits.get(questionId)?.({ status: "answered", answers: { answers } });
    },
  };
}

function elicit(
  bridge: ReturnType<typeof createBridge>,
  id: string,
  params = formParams(),
  signal?: AbortSignal,
) {
  return bridge.handleElicitationRequest({ id, params }, signal);
}

function expectResult(
  response: ReturnType<typeof elicit>,
  action: string,
  content: unknown = null,
) {
  return expect(response).resolves.toEqual({ action, content, _meta: null });
}

function requireQuestionId(value: unknown): string {
  assert(isJsonObject(value) && typeof value.id === "string");
  return value.id;
}

function requestedQuestions(calls: GatewayCallRecord[]) {
  return calls
    .filter((entry) => entry.method === "question.request")
    .map((entry) => {
      assert(isJsonObject(entry.params) && Array.isArray(entry.params.questions));
      return {
        id: requireQuestionId(entry.params),
        questions: entry.params.questions,
      };
    });
}

describe("Codex ordinary MCP elicitation adapter", () => {
  it.each([
    { mode: "form", choice: "Allow", action: "accept", meta: null },
    { mode: "openai/form", choice: "Decline", action: "decline", meta: null },
  ])("waits for $choice before answering an empty $mode form ($meta)", async (testCase) => {
    const params = createParams();
    const gateway = createControlledGateway();
    const bridge = createBridge(gateway.call, params);
    const requestParams = emptyFormParams({ mode: testCase.mode, _meta: testCase.meta });
    const response = elicit(bridge, "empty", requestParams);
    const settled = vi.fn();
    void response.then(settled);
    try {
      await gateway.waitForAnswers(1);
      await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
      expect(settled).not.toHaveBeenCalled();
      const prompt = vi.mocked(params.onBlockReply!).mock.calls[0]?.[0];
      expect(prompt?.text).toContain(requestParams.message);
      const request = requestedQuestions(gateway.calls)[0]!;
      expect(request.questions).toHaveLength(1);
      const question = request.questions[0];
      assert(isJsonObject(question) && typeof question.questionId === "string");
      gateway.answer(request.id, { [question.questionId]: [testCase.choice] });
      await expectResult(response, testCase.action, testCase.action === "accept" ? {} : null);
    } finally {
      await bridge.cancelPending();
    }
  });

  it("cancels an empty form without letting its late answer resolve the next queued form", async () => {
    const gateway = createControlledGateway();
    const bridge = createBridge(gateway.call);
    const controller = new AbortController();
    const confirmation = elicit(bridge, "empty", emptyFormParams(), controller.signal);
    const successor = elicit(bridge, "successor");
    try {
      await gateway.waitForAnswers(1);
      expect(requestedQuestions(gateway.calls)).toHaveLength(1);
      const first = requestedQuestions(gateway.calls)[0]!;
      const question = first.questions[0];
      assert(isJsonObject(question) && typeof question.questionId === "string");
      controller.abort();
      gateway.answer(first.id, { [question.questionId]: ["Allow"] });
      await expectResult(confirmation, "cancel");
      await gateway.waitForAnswers(2);
      const second = requestedQuestions(gateway.calls)[1]!;
      expect(second.id).not.toBe(first.id);
      gateway.answer(second.id, { name: ["Ada"] });
      await expectResult(successor, "accept", { name: "Ada" });
    } finally {
      await bridge.cancelPending();
    }
  });

  it("uses only direct isSecret metadata and never persists that field in Gateway questions", async () => {
    const params = createParams();
    const gateway = createAnsweringGateway([{ password: ["public-value"] }]);
    const bridge = createBridge(gateway.call, params);
    const response = bridge.handleElicitationRequest({
      id: "secret-metadata",
      params: formParams({
        requestedSchema: {
          type: "object",
          properties: {
            password: { type: "string" },
            token: { type: "string", isSecret: true },
          },
          required: ["password", "token"],
        },
      }),
    });
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(params.onBlockReply!)
          .mock.calls.some(([payload]) => payload.text?.includes("may show your reply")),
      ).toBe(true),
    );
    await expect(
      claimPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text: "private-value" }),
    ).resolves.toBe(true);
    await expect(response).resolves.toEqual({
      action: "accept",
      content: { password: "public-value", token: "private-value" },
      _meta: null,
    });
    expect(JSON.stringify(requestedQuestions(gateway.calls))).not.toContain("token");
  });

  it("compiles a queued request before caller mutation and preserves FIFO", async () => {
    const gateway = createControlledGateway();
    const bridge = createBridge(gateway.call);
    const controller = new AbortController();
    const first = elicit(bridge, "first", formParams(), controller.signal);
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(1));

    const raw = formParams();
    const second = elicit(bridge, "second", raw);
    (raw.requestedSchema.properties.name as { type: string }).type = "integer";

    controller.abort();
    await expectResult(first, "cancel");
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(2));
    await gateway.waitForAnswers(2);
    const queued = requestedQuestions(gateway.calls)[1]!;
    gateway.answer(queued.id, { name: ["Grace"] });
    await expectResult(second, "accept", { name: "Grace" });
  });

  it("skips a cancelled queued request promptly and preserves FIFO for its successor", async () => {
    const gateway = createControlledGateway();
    const bridge = createBridge(gateway.call);
    const active = elicit(bridge, "active");
    const controller = new AbortController();
    const queued = elicit(bridge, "queued", formParams(), controller.signal);
    const successor = elicit(bridge, "successor");
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(1));
    const queuedResult = vi.fn();
    void queued.then(queuedResult);
    controller.abort();
    await vi.waitFor(() => expect(queuedResult).toHaveBeenCalledOnce());
    await expect(queued).resolves.toMatchObject({ action: "cancel" });
    await gateway.waitForAnswers(1);
    const current = requestedQuestions(gateway.calls)[0]!;
    gateway.answer(current.id, { name: ["Ada"] });
    await expect(active).resolves.toMatchObject({ action: "accept" });
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(2));
    await gateway.waitForAnswers(2);
    gateway.answer(requestedQuestions(gateway.calls)[1]!.id, { name: ["Grace"] });
    await expect(successor).resolves.toMatchObject({
      action: "accept",
      content: { name: "Grace" },
    });
  });

  it("lets lifecycle cancellation fence a late committed answer", async () => {
    const wait = createDeferred<unknown>();
    const gateway = createGateway(() => wait.promise);
    const bridge = createBridge(gateway.call);
    const controller = new AbortController();
    const response = elicit(bridge, "late", formParams(), controller.signal);
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(1));
    controller.abort();
    wait.resolve({ status: "answered", answers: { answers: { name: ["too late"] } } });
    await expectResult(response, "cancel");
  });

  it("recognizes openaiForm, URL, nullable turn, and exact scope envelopes", async () => {
    const gateway = createAnsweringGateway([
      { name: ["Ada"] },
      { continue: ["I've completed this step"] },
    ]);
    const bridge = createBridge(gateway.call);
    await expectResult(
      elicit(bridge, "nullable", formParams({ turnId: null, mode: "openaiForm" })),
      "accept",
      { name: "Ada" },
    );
    await expectResult(
      elicit(
        bridge,
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
    expect(requestedQuestions(gateway.calls)[1]?.questions).toContainEqual(
      expect.objectContaining({ url: "https://example.com/authorize" }),
    );
    await expect(
      elicit(bridge, "wrong-turn", formParams({ turnId: "other" })),
    ).resolves.toBeUndefined();
    await expect(
      elicit(bridge, "wrong-thread", formParams({ threadId: "other" })),
    ).resolves.toBeUndefined();
  });

  it("rejects inherited and accessor thread correlation without invoking getters", async () => {
    const gateway = createAnsweringGateway([]);
    const bridge = createBridge(gateway.call);
    const inherited = formParams();
    Object.setPrototypeOf(inherited, { threadId: "thread-1" });
    delete (inherited as Partial<typeof inherited>).threadId;
    let getterCalls = 0;
    const accessor = formParams();
    Object.defineProperty(accessor, "threadId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "thread-1";
      },
    });

    for (const [id, params] of Object.entries({ inherited, accessor })) {
      await expect(bridge.handleElicitationRequest({ id, params })).resolves.toBeUndefined();
    }
    expect(getterCalls).toBe(0);
    expect(gateway.calls).toEqual([]);
  });

  it("rechecks thread correlation on the detached snapshot", async () => {
    const gateway = createAnsweringGateway([{ name: ["Ada"] }]);
    const bridge = createBridge(gateway.call);
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

    await expect(elicit(bridge, "changing-thread", request)).resolves.toBeUndefined();
    expect(threadReads).toBeGreaterThanOrEqual(2);
    expect(gateway.calls).toEqual([]);
  });

  it("preserves snapshot rejection and descriptor trap behavior", async () => {
    const bridge = createBridge(createAnsweringGateway([]).call);
    const request = formParams();
    Object.defineProperty(request, "threadId", {
      enumerable: false,
      value: "thread-1",
    });

    await expect(elicit(bridge, "non-enumerable", request)).resolves.toMatchObject({
      action: "decline",
      _meta: { message: expect.stringContaining("malformed or over-limit") },
    });

    const trapped = new Proxy(formParams(), {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor unavailable");
      },
    });
    await expect(elicit(bridge, "descriptor-trap", trapped)).rejects.toThrow(
      "descriptor unavailable",
    );
  });
});
