import { expect, it, vi } from "vitest";
import type { AgentHarnessQuestionGatewayCall } from "./gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswer } from "./gateway-question.js";
import { runStructuredInput } from "./structured-input-execution.js";
import {
  compileStructuredInputForm,
  compileStructuredInputUrl,
  snapshotStructuredInput,
} from "./structured-input.js";

type GatewayQuestion = { questionId: string };
type GatewayRequest = { id: string; questions: GatewayQuestion[] };
type Answers = Record<string, string[]>;

function compileForm(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return compileStructuredInputForm({
    schema: snapshotStructuredInput({ type: "object", properties, required }),
    message: "Complete the form",
    fallbackMessage: "Input requested",
    options: {
      protocolName: "test",
      allowEmptyForm: true,
      minimumChoiceCount: 1,
      metadata: { secretPath: ["isSecret"] },
    },
  });
}

function createGateway(answer: (questions: GatewayQuestion[]) => Answers | Promise<Answers>) {
  const requested: GatewayRequest[] = [];
  const call: AgentHarnessQuestionGatewayCall = vi.fn(async (method, _opts, rawParams) => {
    const params = rawParams as GatewayRequest;
    if (method === "question.request") {
      requested.push(params);
      return { id: params.id };
    }
    if (method === "question.waitAnswer") {
      const request = requested.find(({ id }) => id === params.id);
      if (!request) {
        throw new Error("missing question registration");
      }
      return { status: "answered", answers: { answers: await answer(request.questions) } };
    }
    if (method === "question.resolve") {
      return { status: "cancelled" };
    }
    throw new Error(`unexpected gateway method ${method}`);
  });
  return { call, requested };
}

function executionParams(gatewayCall: AgentHarnessQuestionGatewayCall) {
  return {
    sessionKey: "agent:main:structured-input",
    agentId: "main",
    runId: "run-1",
    timeoutMs: 90_000,
    gatewayCall,
    delivery: { onBlockReply: vi.fn(async (_payload: { text?: string }) => undefined) },
  };
}

async function claimEventually(sessionKey: string, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await claimPendingAgentQuestionAnswer({ sessionKey, text })) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return false;
}

it("batches ordinary questions by three and isolates secret input from Gateway records", async () => {
  const gateway = createGateway((questions) =>
    Object.fromEntries(questions.map((question) => [question.questionId, [question.questionId]])),
  );
  const content = Object.fromEntries(
    "a b c token d e f g".split(" ").map((key) => [key, key === "token" ? "private-value" : key]),
  );
  const input = compileForm(
    Object.fromEntries(
      Object.keys(content).map((key) => [key, { type: "string", isSecret: key === "token" }]),
    ),
  );
  const params = executionParams(gateway.call);
  const result = runStructuredInput({ input, ...params });

  await vi.waitFor(() =>
    expect(params.delivery.onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("may show your reply") }),
    ),
  );
  await expect(claimEventually(params.sessionKey, "private-value")).resolves.toBe(true);

  await expect(result).resolves.toEqual({
    status: "answered",
    answers: Object.fromEntries(Object.entries(content).map(([key, value]) => [key, [value]])),
    content,
  });
  expect(gateway.requested.map((request) => request.questions.length)).toEqual([3, 3, 1]);
  expect(gateway.requested.flatMap((r) => r.questions)).not.toContainEqual({ questionId: "token" });
});

it("delivers a visible unsupported outcome without creating a Gateway record", async () => {
  const gatewayCall = vi.fn<AgentHarnessQuestionGatewayCall>();
  const params = executionParams(gatewayCall);
  const result = await runStructuredInput({
    input: { kind: "unsupported", message: "Unsupported nested object field." },
    ...params,
  });

  expect(result).toEqual({ status: "unsupported", message: "Unsupported nested object field." });
  expect(params.delivery.onBlockReply).toHaveBeenCalledWith(
    expect.objectContaining({ text: expect.stringContaining("Unsupported nested object field") }),
  );
  expect(gatewayCall).not.toHaveBeenCalled();
});

it.each([
  ["I've completed this step", "answered"],
  ["Decline", "declined"],
] as const)("maps the URL choice %s to %s", async (choice, status) => {
  const gateway = createGateway((questions) => ({ [questions[0]!.questionId]: [choice] }));
  const input = compileStructuredInputUrl({
    url: "https://example.com/authorize",
    elicitationId: "auth-1",
    message: "Review authorization",
    fallbackMessage: "Review URL",
    protocolName: "test",
  });

  const result = runStructuredInput({ input, ...executionParams(gateway.call) });
  await expect(result).resolves.toMatchObject({ status });
});

it("declines decoded values outside the compiled constraint and shows the reason", async () => {
  const gateway = createGateway((questions) => ({ [questions[0]!.questionId]: ["12"] }));
  const params = executionParams(gateway.call);
  const input = compileForm({ count: { type: "integer", minimum: 1, maximum: 9 } });

  const result = await runStructuredInput({ input, ...params });

  expect(result).toMatchObject({
    status: "declined",
    message: expect.stringContaining("at most 9"),
  });
  expect(params.delivery.onBlockReply).toHaveBeenCalledWith(
    expect.objectContaining({ text: expect.stringContaining("at most 9") }),
  );
});

it.each(["populated", "empty"] as const)(
  "fences a %s form answer when the owning turn becomes inactive before commit",
  async (formKind) => {
    let settle!: (value: string) => void;
    const wait = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const gateway = createGateway(async (questions) => {
      const value = await wait;
      return Object.fromEntries(questions.map(({ questionId }) => [questionId, [value]]));
    });
    let active = true;
    const result = runStructuredInput({
      input: compileForm(formKind === "empty" ? {} : { name: { type: "string" } }),
      ...executionParams(gateway.call),
      isActive: () => active,
    });
    await vi.waitFor(() =>
      expect(vi.mocked(gateway.call).mock.calls.map(([method]) => method)).toContain(
        "question.waitAnswer",
      ),
    );

    expect(gateway.requested[0]?.questions[0]?.questionId).toEqual(expect.stringMatching(/./u));
    active = false;
    settle("Allow");

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
  },
);
