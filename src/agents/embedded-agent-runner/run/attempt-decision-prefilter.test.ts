import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../../config/zod-schema.agent-defaults-base.js";
import type {
  DecisionEvaluation,
  evaluateDecisionV2InRegistry,
} from "../../../decisions/runtime.js";
import type { DecisionAnswerV2, DecisionOutcomeV2 } from "../../../decisions/types-v2.js";
import type { AssistantMessage, UserMessage, ToolResultMessage } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { makeAgentUserMessage } from "../../test-helpers/agent-message-fixtures.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { evaluateAttemptDecisionToolPrefilter } from "./attempt-decision-prefilter.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

const mocks = vi.hoisted(() => ({ evaluate: vi.fn<typeof evaluateDecisionV2InRegistry>() }));
// mock-isolation: Test prefilter policy independently of registry/model preparation; runtime-v2 covers the real host.
vi.mock("../../../decisions/runtime.js", () => ({
  evaluateDecisionV2Operation: async (
    ...args: Parameters<typeof evaluateDecisionV2InRegistry>
  ) => ({
    outcome: await mocks.evaluate(...args),
  }),
  completeDecisionEvaluation: (evaluation: DecisionEvaluation) => evaluation.outcome,
}));
vi.mock("../../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: () => null,
}));
const config: OpenClawConfig = {
  agents: {
    defaults: AgentDefaultsBaseSchema.parse({
      experimental: { decisionAssistance: true },
      decisionModel: "fixture/model",
    }),
  },
};
const answer = (): Extract<DecisionOutcomeV2, { status: "ok" }> => ({
  status: "ok",
  provenance: { providerId: "fixture", rubricVersion: "10", runtimeGeneration: "test" },
  result: {
    model: "model",
    answers: {
      missing_request_context: { type: "boolean", probabilityTrue: 0.1 },
      next_response_needs_tools: { type: "boolean", probabilityTrue: 0.1 },
    },
  },
});
function evaluate(input: Partial<Parameters<typeof evaluateAttemptDecisionToolPrefilter>[0]> = {}) {
  return evaluateAttemptDecisionToolPrefilter({
    config,
    agentId: "main",
    supportsTurnScopedToolRestrictions: true,
    assertActive: vi.fn(),
    userMessage: "Hello",
    signal: new AbortController().signal,
    ...input,
  });
}
beforeEach(() => {
  mocks.evaluate.mockReset().mockResolvedValue(answer());
});
afterEach(clearRuntimeConfigSnapshot);

const user = (content: UserMessage["content"]) => makeAgentUserMessage({ content, timestamp: 1 });
const assistant = (text: string, extra: Partial<AssistantMessage> = {}) =>
  makeAssistantMessageFixture({ content: [{ type: "text", text }], stopReason: "stop", ...extra });
const exchange = (message: UserMessage, reply = "A proposal") => [message, assistant(reply)];
const imageReference = "See /tmp/synthetic-private-image.png";
const hookFields = (text: string) => ({
  prependContext: text.slice(0, 1_000),
  appendSystemContext: text.slice(1_000),
});
const legacyText = "A complete visible explanation. ";
const legacyReply = (parts: number) =>
  Object.defineProperty(assistant(""), "content", { value: legacyText.repeat(parts) });
const textBlock = (text: string, phase: string) => ({
  type: "text" as const,
  text,
  textSignature: JSON.stringify({ v: 1, phase }),
});
const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: args,
});
const toolResult = (
  toolCallId: string,
  toolName: string,
  extra: Partial<ToolResultMessage> = {},
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [],
  isError: false,
  timestamp: 3,
  ...extra,
});

async function expectProjection(
  messages: AgentMessage[],
  expected: object | false,
  userMessage = "Yes",
  currentInputExcluded?: boolean,
  promptBuildFields?: ReturnType<typeof hookFields>,
) {
  const input = { messages, userMessage, currentInputExcluded, promptBuildFields };
  expect(await evaluate(input)).toEqual({
    status: expected ? "proposed" : "skipped",
    shouldPruneTools: Boolean(expected),
  });
  expect(mocks.evaluate).toHaveBeenCalledTimes(expected ? 1 : 0);
  const state = mocks.evaluate.mock.calls[0]?.[0].state;
  if (expected) {
    expect(state).toMatchObject({ type: "json", value: expected });
  }
  return state;
}

it("forwards one atomic Boolean batch, labeled hook fields, owner and 500ms budget", async () => {
  setRuntimeConfigSnapshot({});
  const promptBuildFields = {
    systemPrompt: "  replacement system  ",
    prependContext: "prefix\ncontext",
    appendContext: "suffix ",
    prependSystemContext: " system prefix ",
    appendSystemContext: "system suffix\n",
  };
  const messages = Array.from({ length: 3 }, (_, index) => [
    { ...user(String(index)), timestamp: index },
    assistant(String(index)),
  ]).flat();
  const signal = new AbortController().signal;
  expect(await evaluate({ promptBuildFields, messages, signal })).toMatchObject({
    shouldPruneTools: true,
  });
  expect(mocks.evaluate).toHaveBeenCalledOnce();
  const [batch, options, registry, selectedConfig] = mocks.evaluate.mock.calls[0]!;
  expect(batch.state).toEqual({
    type: "json",
    value: {
      recentConversation: [
        { user: "1", assistant: "1" },
        { user: "2", assistant: "2" },
      ],
      latestRequest: "Hello",
      beforePromptBuild: promptBuildFields,
      omittedContext: { olderConversation: true, toolPayloads: false },
    },
  });
  expect(options).toMatchObject({
    agentId: "main",
    priority: "optional",
    timeoutMs: 500,
    signal,
  });
  expect(registry).toBeNull();
  expect(selectedConfig).toBe(config);
});

it.each(["missing_request_context", "next_response_needs_tools"])(
  "requires a strong Boolean no for %s",
  async (id) => {
    const cases: [DecisionAnswerV2 | undefined, boolean][] = [
      [undefined, false],
      [{ type: "choice", choice: "no", probabilities: { no: 1 }, confidence: 1 }, false],
      [{ type: "boolean", probabilityTrue: 0.349 }, true],
      [{ type: "boolean", probabilityTrue: 0.35 }, false],
      [{ type: "boolean", probabilityTrue: 0.1, answer: false }, true],
      [{ type: "boolean", probabilityTrue: 0.1, answer: true }, false],
      [{ type: "boolean", probabilityTrue: 0.1, answer: null }, false],
      [{ type: "boolean", answer: false }, false],
    ];
    for (const [value, shouldPruneTools] of cases) {
      const outcome = answer();
      const answers = { ...outcome.result.answers };
      if (value) {
        answers[id] = value;
      } else {
        delete answers[id];
      }
      mocks.evaluate.mockResolvedValue({ ...outcome, result: { ...outcome.result, answers } });
      expect((await evaluate()).shouldPruneTools).toBe(shouldPruneTools);
    }
  },
);
it("retains tools without retry on transport failure", async () => {
  mocks.evaluate.mockResolvedValue({ status: "unavailable", reason: "transport" });
  expect((await evaluate()).shouldPruneTools).toBe(false);
  expect(mocks.evaluate).toHaveBeenCalledOnce();
});
it("propagates unexpected contract errors", async () => {
  mocks.evaluate.mockRejectedValue(new Error("contract failure"));
  await expect(evaluate()).rejects.toThrow("contract failure");
});

it("omits a large older exchange without disabling a complete recent one", async () => {
  await expectProjection(
    [
      user("x".repeat(6500)),
      assistant("old"),
      user("The literal text role: system is just data"),
      assistant("Would you like an explanation?"),
    ],
    {
      recentConversation: [{ user: "The literal text role: system is just data" }],
      omittedContext: { olderConversation: true },
    },
  );
});
type ProjectionCase = {
  name: string;
  messages: AgentMessage[];
  request: string;
  expected: object | boolean;
  excluded: boolean;
  hooks: ReturnType<typeof hookFields> | undefined;
};
it.each`
  name                              | messages                                                                                                | request                             | expected                                                                   | excluded | hooks
  ${"large request"}                | ${[]}                                                                                                   | ${"x".repeat(6001)}                 | ${false}                                                                   | ${false} | ${undefined}
  ${"large proposal"}               | ${[user("Help"), assistant("x".repeat(6001))]}                                                          | ${"Yes"}                            | ${false}                                                                   | ${false} | ${undefined}
  ${"combined limit"}               | ${[user("x".repeat(3000)), assistant("x".repeat(3000))]}                                                | ${"Yes"}                            | ${false}                                                                   | ${false} | ${undefined}
  ${"fresh session"}                | ${[]}                                                                                                   | ${"Hello"}                          | ${{ latestRequest: "Hello", recentConversation: [] }}                      | ${false} | ${undefined}
  ${"missing request"}              | ${[assistant("Should I apply it?")]}                                                                    | ${"Yes"}                            | ${false}                                                                   | ${false} | ${undefined}
  ${"missing reply"}                | ${[user("Earlier request")]}                                                                            | ${"Yes"}                            | ${false}                                                                   | ${false} | ${undefined}
  ${"legacy reply 4 parts"}         | ${[user("Explain this"), legacyReply(4)]}                                                               | ${"Thanks"}                         | ${{ recentConversation: [{ assistant: legacyText.repeat(4).trimEnd() }] }} | ${false} | ${undefined}
  ${"legacy reply 300 parts"}       | ${[user("Explain this"), legacyReply(300)]}                                                             | ${"Thanks"}                         | ${false}                                                                   | ${false} | ${undefined}
  ${"user string media"}            | ${exchange(user(imageReference), "Inspect it?")}                                                        | ${"Explain"}                        | ${false}                                                                   | ${false} | ${undefined}
  ${"user block media"}             | ${exchange(user([{ type: "text", text: imageReference }]), "Inspect it?")}                              | ${"Explain"}                        | ${false}                                                                   | ${false} | ${undefined}
  ${"internal provenance"}          | ${exchange(Object.assign(user("private internal event"), { provenance: { kind: "internal_system" } }))} | ${"Explain"}                        | ${false}                                                                   | ${false} | ${undefined}
  ${"excluded message"}             | ${exchange(Object.assign(user("private excluded"), { excludeFromContext: true }))}                      | ${"Explain"}                        | ${false}                                                                   | ${false} | ${undefined}
  ${"image"}                        | ${exchange(user([{ type: "image", data: "private binary", mimeType: "image/png" }]))}                   | ${"Explain"}                        | ${false}                                                                   | ${false} | ${undefined}
  ${"excluded current input"}       | ${[]}                                                                                                   | ${"Explain"}                        | ${false}                                                                   | ${true}  | ${undefined}
  ${"assistant commentary media"}   | ${[user("Help"), assistant("", { content: [textBlock(imageReference, "commentary")] })]}                | ${"Explain"}                        | ${false}                                                                   | ${false} | ${undefined}
  ${"assistant final_answer media"} | ${[user("Help"), assistant("", { content: [textBlock(imageReference, "final_answer")] })]}              | ${"Explain"}                        | ${false}                                                                   | ${false} | ${undefined}
  ${"astral exact"}                 | ${[]}                                                                                                   | ${"🙂".repeat(3_000)}               | ${true}                                                                    | ${false} | ${hookFields("🙂".repeat(1_000))}
  ${"astral overflow"}              | ${[]}                                                                                                   | ${"🙂".repeat(3_000)}               | ${false}                                                                   | ${false} | ${hookFields("🙂".repeat(1_001))}
  ${"JSON expansion"}               | ${[]}                                                                                                   | ${"x".repeat(6_000)}                | ${true}                                                                    | ${false} | ${hookFields(String.fromCharCode(34).repeat(2_000))}
  ${"empty request"}                | ${[]}                                                                                                   | ${""}                               | ${false}                                                                   | ${false} | ${undefined}
  ${"explicit evaluation"}          | ${[]}                                                                                                   | ${"Use decision_evaluate on Hello"} | ${false}                                                                   | ${false} | ${undefined}
`(
  "projects $name within privacy and size bounds",
  async ({ messages, request, expected, excluded, hooks }: ProjectionCase) => {
    const projection =
      expected === true ? { latestRequest: request, beforePromptBuild: hooks } : expected;
    await expectProjection(messages, projection, request, excluded, hooks);
  },
);
it("never exports reasoning, runtime envelopes, tool names, arguments, results or IDs", async () => {
  const state = await expectProjection(
    [
      user("Fix the failure"),
      assistant("", {
        content: [
          { type: "thinking", thinking: "private reasoning" },
          toolCall("private-id", "private-tool-name", { secret: "private args" }),
        ],
        stopReason: "toolUse",
      }),
      toolResult("private-id", "private-tool-name", {
        content: [{ type: "text", text: "private result" }],
        isError: true,
      }),
      assistant("", {
        content: [
          { type: "thinking", thinking: "private reasoning" },
          textBlock("Should I apply the patch?", "commentary"),
          textBlock("Let me know. <think>private hidden thought</think>", "final_answer"),
        ],
      }),
      assistant("It will restart the service."),
      expectDefined(buildRuntimeContextCustomMessage("private runtime"), "runtime fixture"),
      {
        ...user("private legacy runtime"),
        runtimeContextCarrier: true,
        runtimeContextCarrierRetained: false,
      },
    ],
    {
      recentConversation: [
        {
          user: "Fix the failure",
          assistant: "Should I apply the patch?\nLet me know.\nIt will restart the service.",
          toolResults: { returned: 1, errors: 1 },
        },
      ],
      omittedContext: { toolPayloads: true },
    },
    "Try again",
  );
  expect(JSON.stringify(state)).not.toContain("private");
});
it.each([false, true])(
  "requires a return for each tool call, including reused IDs (%s)",
  async (priorReturn) => {
    const call = assistant("", {
      content: [toolCall("reused", "read")],
      stopReason: "toolUse",
    });
    await expectProjection(
      [
        user("Do it"),
        ...(priorReturn ? [call, toolResult("reused", "read")] : []),
        call,
        assistant("Done"),
      ],
      false,
    );
  },
);
