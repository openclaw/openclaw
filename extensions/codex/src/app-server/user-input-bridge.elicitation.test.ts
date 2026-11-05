import assert from "node:assert/strict";
import { claimPendingAgentQuestionAnswer } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
  onTestFinished(() => bridge.cancelPending());
  const request = (id: string, input = formParams(), signal?: AbortSignal) =>
    bridge.handleElicitationRequest({ id, params: input }, signal);
  return { ...gateway, params, request };
}

function createAnsweringGateway(answerBatches: Array<Record<string, string[]>>) {
  return createGateway(() => {
    const answers = answerBatches.shift();
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
  const waitForAnswers = (count: number) => vi.waitFor(() => expect(waits.size).toBe(count));
  return {
    ...gateway,
    waitForAnswers,
    async answer(count: number, choice: string) {
      await vi.waitFor(() => expect(waits.has(gateway.questions[count - 1]?.id ?? "")).toBe(true));
      const request = gateway.questions[count - 1]!;
      expect(request.questions).toHaveLength(1);
      const question = request.questions[0];
      assert(isJsonObject(question) && typeof question.questionId === "string");
      waits.get(request.id)?.({
        status: "answered",
        answers: { answers: { [question.questionId]: [choice] } },
      });
      return request;
    },
  };
}

function expectResult(response: Promise<unknown>, action: string, content: unknown = null) {
  return expect(response).resolves.toEqual({ action, content, _meta: null });
}

describe("Codex ordinary MCP elicitation adapter", () => {
  it.each([
    { mode: "form", choice: "Allow", action: "accept" },
    { mode: "openai/form", choice: "Decline", action: "decline" },
  ])("waits for $choice before answering an empty $mode form", async (testCase) => {
    const gateway = createControlledGateway();
    const { params } = gateway;
    const requestParams = emptyFormParams({ mode: testCase.mode, _meta: null });
    const response = gateway.request("empty", requestParams);
    const settled = vi.fn();
    void response.then(settled);
    await gateway.waitForAnswers(1);
    await vi.waitFor(() =>
      expect(vi.mocked(params.onBlockReply!).mock.calls[0]?.[0].text).toContain(
        requestParams.message,
      ),
    );
    expect(settled).not.toHaveBeenCalled();
    await gateway.answer(1, testCase.choice);
    await expectResult(response, testCase.action, testCase.action === "accept" ? {} : null);
  });

  it("cancels an empty form without letting its late answer resolve the next queued form", async () => {
    const gateway = createControlledGateway();
    const controller = new AbortController();
    const confirmation = gateway.request("empty", emptyFormParams(), controller.signal);
    const successor = gateway.request("successor");
    await gateway.waitForAnswers(1);
    const first = gateway.questions[0]!;
    controller.abort();
    await gateway.answer(1, "Allow");
    await expectResult(confirmation, "cancel");
    const second = await gateway.answer(2, "Ada");
    expect(second.id).not.toBe(first.id);
    await expectResult(successor, "accept", { name: "Ada" });
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

  it("skips cancelled queued requests and snapshots the FIFO successor before caller mutation", async () => {
    const gateway = createControlledGateway();
    const active = gateway.request("active");
    const controller = new AbortController();
    const queued = gateway.request("queued", formParams(), controller.signal);
    const raw = formParams();
    const successor = gateway.request("successor", raw);
    raw.requestedSchema.properties.name.type = "integer";
    await vi.waitFor(() => expect(gateway.questions).toHaveLength(1));
    const queuedResult = vi.fn();
    void queued.then(queuedResult);
    controller.abort();
    await vi.waitFor(() => expect(queuedResult).toHaveBeenCalledOnce());
    await expectResult(queued, "cancel");
    await gateway.answer(1, "Ada");
    await expectResult(active, "accept", { name: "Ada" });
    await gateway.answer(2, "Grace");
    await expectResult(successor, "accept", { name: "Grace" });
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
