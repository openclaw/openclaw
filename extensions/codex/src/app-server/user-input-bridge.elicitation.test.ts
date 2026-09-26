// Codex tests retain only native envelope, extension, queue, and lifecycle behavior.
import {
  claimPendingAgentQuestionAnswer,
  type AgentHarnessQuestionGatewayCall,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
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

function createBridge(options: {
  params?: EmbeddedRunAttemptParams;
  signal?: AbortSignal;
  gatewayCall: AgentHarnessQuestionGatewayCall;
}) {
  return createCodexUserInputBridge({
    paramsForRun: options.params ?? createParams(),
    threadId: "thread-1",
    turnId: "turn-1",
    signal: options.signal,
    gatewayCall: options.gatewayCall,
  });
}

function createAnsweringGateway(answerBatches: Array<Record<string, string[]>>) {
  const calls: GatewayCallRecord[] = [];
  let answerIndex = 0;
  const call: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
    calls.push({ method, params });
    if (method === "question.request") {
      return { id: requireQuestionId(params) };
    }
    if (method === "question.waitAnswer") {
      const answers = answerBatches[answerIndex++];
      if (!answers) {
        throw new Error("missing gateway answer batch");
      }
      return { status: "answered", answers: { answers } };
    }
    return { status: "cancelled" };
  };
  return { call, calls };
}

function createControlledGateway() {
  const calls: GatewayCallRecord[] = [];
  const waits = new Map<string, (value: unknown) => void>();
  const call: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
    calls.push({ method, params });
    const questionId = requireQuestionId(params);
    if (method === "question.request") {
      return { id: questionId };
    }
    if (method === "question.waitAnswer") {
      return await new Promise((resolve) => {
        waits.set(questionId, resolve);
      });
    }
    if (method === "question.resolve") {
      waits.get(questionId)?.({ status: "cancelled" });
      return { status: "cancelled" };
    }
    throw new Error(`unexpected gateway method ${method}`);
  };
  return {
    call,
    calls,
    answer(questionId: string, answers: Record<string, string[]>) {
      waits.get(questionId)?.({ status: "answered", answers: { answers } });
    },
  };
}

function requireQuestionId(value: unknown): string {
  if (!isJsonObject(value) || typeof value.id !== "string") {
    throw new Error("expected Gateway question id");
  }
  return value.id;
}

function requestedQuestions(calls: GatewayCallRecord[]) {
  return calls
    .filter((entry) => entry.method === "question.request")
    .map((entry) => {
      if (!isJsonObject(entry.params) || !Array.isArray(entry.params.questions)) {
        throw new Error("expected Gateway question request");
      }
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
    {
      mode: "form",
      choice: "Decline",
      action: "decline",
      meta: {
        codex_approval_kind: "tool_suggestion",
        tool_type: "plugin",
        suggest_type: "install",
        tool_id: "example@fixture",
        tool_name: "Example",
      },
    },
  ])("waits for $choice before answering an empty $mode form ($meta)", async (testCase) => {
    const params = createParams();
    const gateway = createControlledGateway();
    const bridge = createBridge({ params, gatewayCall: gateway.call });
    const requestParams = emptyFormParams({ mode: testCase.mode, _meta: testCase.meta });
    const response = bridge.handleElicitationRequest({
      id: "empty",
      params: requestParams,
    });
    const settled = vi.fn();
    void response.then(settled);
    try {
      await vi.waitFor(() =>
        expect(
          gateway.calls.filter((entry) => entry.method === "question.waitAnswer"),
        ).toHaveLength(1),
      );
      await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
      expect(settled).not.toHaveBeenCalled();
      const prompt = vi.mocked(params.onBlockReply!).mock.calls[0]?.[0];
      expect(prompt?.text).toContain(requestParams.message);
      const request = requestedQuestions(gateway.calls)[0]!;
      expect(request.questions).toHaveLength(1);
      const question = request.questions[0];
      if (!isJsonObject(question) || typeof question.questionId !== "string") {
        throw new Error("expected confirmation question id");
      }
      gateway.answer(request.id, { [question.questionId]: [testCase.choice] });
      await expect(response).resolves.toEqual({
        action: testCase.action,
        content: testCase.action === "accept" ? {} : null,
        _meta: null,
      });
    } finally {
      await bridge.cancelPending();
    }
  });

  it("cancels an empty form without letting its late answer resolve the next queued form", async () => {
    const gateway = createControlledGateway();
    const bridge = createBridge({ gatewayCall: gateway.call });
    const controller = new AbortController();
    const confirmation = bridge.handleElicitationRequest(
      { id: "empty", params: emptyFormParams() },
      controller.signal,
    );
    const successor = bridge.handleElicitationRequest({ id: "successor", params: formParams() });
    try {
      await vi.waitFor(() =>
        expect(
          gateway.calls.filter((entry) => entry.method === "question.waitAnswer"),
        ).toHaveLength(1),
      );
      expect(requestedQuestions(gateway.calls)).toHaveLength(1);
      const first = requestedQuestions(gateway.calls)[0]!;
      const question = first.questions[0];
      if (!isJsonObject(question) || typeof question.questionId !== "string") {
        throw new Error("expected confirmation question id");
      }
      controller.abort();
      gateway.answer(first.id, { [question.questionId]: ["Allow"] });
      await expect(confirmation).resolves.toEqual({ action: "cancel", content: null, _meta: null });
      await vi.waitFor(() =>
        expect(
          gateway.calls.filter((entry) => entry.method === "question.waitAnswer"),
        ).toHaveLength(2),
      );
      const second = requestedQuestions(gateway.calls)[1]!;
      expect(second.id).not.toBe(first.id);
      gateway.answer(second.id, { name: ["Ada"] });
      await expect(successor).resolves.toEqual({
        action: "accept",
        content: { name: "Ada" },
        _meta: null,
      });
    } finally {
      await bridge.cancelPending();
    }
  });

  it("enables imagePicker only for negotiated openai/form input", async () => {
    const schema = {
      type: "object",
      properties: {
        template: {
          type: "openai/imagePicker",
          items: [{ id: "monthly", title: "Monthly review", image: "https://invalid/unused" }],
        },
      },
      required: ["template"],
    };
    const standardParams = createParams();
    const standardGateway = createAnsweringGateway([]);
    const standard = createBridge({ params: standardParams, gatewayCall: standardGateway.call });
    await expect(
      standard.handleElicitationRequest({
        id: "standard-image",
        params: formParams({ requestedSchema: schema }),
      }),
    ).resolves.toMatchObject({
      action: "decline",
      _meta: { message: expect.stringContaining("unsupported") },
    });
    expect(standardGateway.calls).toEqual([]);

    const extendedGateway = createAnsweringGateway([{ template: ["Monthly review"] }]);
    const extended = createBridge({ gatewayCall: extendedGateway.call });
    await expect(
      extended.handleElicitationRequest({
        id: 41,
        params: formParams({ mode: "openai/form", requestedSchema: schema }),
      }),
    ).resolves.toEqual({ action: "accept", content: { template: "monthly" }, _meta: null });
  });

  it("uses only direct isSecret metadata and never persists that field in Gateway questions", async () => {
    const params = createParams();
    const gateway = createAnsweringGateway([{ password: ["public-value"] }]);
    const bridge = createBridge({ params, gatewayCall: gateway.call });
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
    const bridge = createBridge({ gatewayCall: gateway.call });
    const controller = new AbortController();
    const first = bridge.handleElicitationRequest(
      { id: "first", params: formParams() },
      controller.signal,
    );
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(1));

    const raw = formParams();
    const second = bridge.handleElicitationRequest({ id: "second", params: raw });
    (raw.requestedSchema.properties.name as { type: string }).type = "integer";

    controller.abort();
    await expect(first).resolves.toEqual({ action: "cancel", content: null, _meta: null });
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(2));
    await vi.waitFor(() =>
      expect(gateway.calls.filter((entry) => entry.method === "question.waitAnswer")).toHaveLength(
        2,
      ),
    );
    const queued = requestedQuestions(gateway.calls)[1]!;
    gateway.answer(queued.id, { name: ["Grace"] });
    await expect(second).resolves.toEqual({
      action: "accept",
      content: { name: "Grace" },
      _meta: null,
    });
  });

  it("skips a cancelled queued request promptly and preserves FIFO for its successor", async () => {
    const gateway = createControlledGateway();
    const bridge = createBridge({ gatewayCall: gateway.call });
    const active = bridge.handleElicitationRequest({ id: "active", params: formParams() });
    const controller = new AbortController();
    const queued = bridge.handleElicitationRequest(
      { id: "queued", params: formParams() },
      controller.signal,
    );
    const successor = bridge.handleElicitationRequest({ id: "successor", params: formParams() });
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(1));
    const queuedResult = vi.fn();
    void queued.then(queuedResult);
    controller.abort();
    await vi.waitFor(() => expect(queuedResult).toHaveBeenCalledOnce());
    await expect(queued).resolves.toMatchObject({ action: "cancel" });
    await vi.waitFor(() =>
      expect(gateway.calls.filter((entry) => entry.method === "question.waitAnswer")).toHaveLength(
        1,
      ),
    );
    const current = requestedQuestions(gateway.calls)[0]!;
    gateway.answer(current.id, { name: ["Ada"] });
    await expect(active).resolves.toMatchObject({ action: "accept" });
    await vi.waitFor(() => expect(requestedQuestions(gateway.calls)).toHaveLength(2));
    await vi.waitFor(() =>
      expect(gateway.calls.filter((entry) => entry.method === "question.waitAnswer")).toHaveLength(
        2,
      ),
    );
    gateway.answer(requestedQuestions(gateway.calls)[1]!.id, { name: ["Grace"] });
    await expect(successor).resolves.toMatchObject({
      action: "accept",
      content: { name: "Grace" },
    });
  });

  it("lets lifecycle cancellation fence a late committed answer", async () => {
    let answer!: (value: unknown) => void;
    const wait = new Promise<unknown>((resolve) => {
      answer = resolve;
    });
    const calls: GatewayCallRecord[] = [];
    const gatewayCall: AgentHarnessQuestionGatewayCall = async (method, _opts, params) => {
      calls.push({ method, params });
      if (method === "question.request") {
        return { id: requireQuestionId(params) };
      }
      if (method === "question.waitAnswer") {
        return await wait;
      }
      return { status: "cancelled" };
    };
    const bridge = createBridge({ gatewayCall });
    const controller = new AbortController();
    const response = bridge.handleElicitationRequest(
      { id: "late", params: formParams() },
      controller.signal,
    );
    await vi.waitFor(() => expect(requestedQuestions(calls)).toHaveLength(1));
    controller.abort();
    answer({ status: "answered", answers: { answers: { name: ["too late"] } } });
    await expect(response).resolves.toEqual({ action: "cancel", content: null, _meta: null });
  });

  it("recognizes form, openai/form, URL, nullable turn, and exact scope envelopes", async () => {
    const gateway = createAnsweringGateway([
      { name: ["Ada"] },
      { continue: ["I've completed this step"] },
    ]);
    const bridge = createBridge({ gatewayCall: gateway.call });
    await expect(
      bridge.handleElicitationRequest({ id: "nullable", params: formParams({ turnId: null }) }),
    ).resolves.toEqual({ action: "accept", content: { name: "Ada" }, _meta: null });
    await expect(
      bridge.handleElicitationRequest({
        id: "url",
        params: formParams({
          mode: "url",
          requestedSchema: undefined,
          url: "https://example.com/authorize",
          elicitationId: "auth-1",
        }),
      }),
    ).resolves.toEqual({ action: "accept", content: null, _meta: null });
    expect(requestedQuestions(gateway.calls)[1]?.questions).toContainEqual(
      expect.objectContaining({ url: "https://example.com/authorize" }),
    );
    await expect(
      bridge.handleElicitationRequest({
        id: "wrong-turn",
        params: formParams({ turnId: "other" }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      bridge.handleElicitationRequest({
        id: "wrong-thread",
        params: formParams({ threadId: "other" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects inherited and accessor thread correlation without invoking getters", async () => {
    const gateway = createAnsweringGateway([]);
    const bridge = createBridge({ gatewayCall: gateway.call });
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
    const bridge = createBridge({ gatewayCall: gateway.call });
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

    await expect(
      bridge.handleElicitationRequest({ id: "changing-thread", params: request }),
    ).resolves.toBeUndefined();
    expect(threadReads).toBeGreaterThanOrEqual(2);
    expect(gateway.calls).toEqual([]);
  });

  it("preserves snapshot rejection and descriptor trap behavior", async () => {
    const bridge = createBridge({ gatewayCall: createAnsweringGateway([]).call });
    const request = formParams();
    Object.defineProperty(request, "threadId", {
      enumerable: false,
      value: "thread-1",
    });

    await expect(
      bridge.handleElicitationRequest({ id: "non-enumerable", params: request }),
    ).resolves.toMatchObject({
      action: "decline",
      _meta: { message: expect.stringContaining("malformed or over-limit") },
    });

    const trapped = new Proxy(formParams(), {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor unavailable");
      },
    });
    await expect(
      bridge.handleElicitationRequest({ id: "descriptor-trap", params: trapped }),
    ).rejects.toThrow("descriptor unavailable");
  });
});
