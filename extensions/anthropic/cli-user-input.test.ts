import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

function createContext(
  requestUserInput: CliBackendExecuteContext["requestUserInput"],
): CliBackendExecuteContext {
  return {
    command: "/usr/local/bin/claude",
    args: [],
    cwd: "/tmp",
    env: {},
    prompt: "test",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "test",
    useResume: false,
    timeoutMs: 30_000,
    requestToolPermission: vi.fn(async () => ({
      behavior: "allow" as const,
      updatedInput: {},
    })),
    requestUserInput,
  };
}

const validOptions = [
  { label: "A", description: "First option." },
  { label: "B", description: "Second option." },
];

const input = {
  questions: [
    {
      header: "Test stack",
      question: "Which test runner should we use?",
      options: [
        { label: "Vitest", description: "Use the existing test stack." },
        { label: "Node test", description: "Use the built-in runner." },
      ],
      multiSelect: false,
    },
    {
      header: "Proof",
      question: "Which proof should we collect?",
      options: [
        { label: "Unit tests", description: "Exercise the adapter." },
        { label: "UI proof", description: "Capture the Control UI." },
      ],
      multiSelect: true,
    },
  ],
};

describe("Claude CLI user input adapter", () => {
  it("maps Claude questions and answers while deduplicating the CLI callbacks", async () => {
    const requestUserInput = vi.fn(async () => ({
      status: "answered" as const,
      answers: {
        question_1: ["Vitest"],
        question_2: ["Unit tests", "UI proof"],
      },
    }));
    const authorizer = createClaudeCliUserInputAuthorizer(createContext(requestUserInput));
    const signal = new AbortController().signal;

    const first = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });
    const second = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });

    await expect(first).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: {
          "Which test runner should we use?": "Vitest",
          "Which proof should we collect?": "Unit tests, UI proof",
        },
      },
    });
    await expect(second).resolves.toEqual(await first);
    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(requestUserInput).toHaveBeenCalledWith({
      toolName: "AskUserQuestion",
      intro: "Claude needs input:",
      toolCallId: "claude-question-1",
      abortSignal: signal,
      questions: [
        { ...input.questions[0], id: "question_1", isOther: true },
        { ...input.questions[1], id: "question_2", isOther: true },
      ],
    });
  });

  it("returns actionable denial guidance when the operator skips", async () => {
    const authorizer = createClaudeCliUserInputAuthorizer(
      createContext(
        vi.fn(async () => ({
          status: "cancelled" as const,
          message: "The operator skipped this question.",
        })),
      ),
    );

    await expect(
      authorizer.authorize({ input, signal: new AbortController().signal }),
    ).resolves.toEqual({
      behavior: "deny",
      message: "The operator skipped this question. Continue with your best judgment.",
    });
  });

  it("guides a malformed question retry without replaying the rejected call", async () => {
    const requestUserInput = vi.fn(async () => ({
      status: "answered" as const,
      answers: { question_1: ["Vitest"], question_2: ["Unit tests"] },
    }));
    const authorizer = createClaudeCliUserInputAuthorizer(createContext(requestUserInput));
    const signal = new AbortController().signal;
    const rejected = {
      behavior: "deny",
      message:
        "OpenClaw rejected malformed Claude user questions: questions[0].header must be at most 12 characters. Correct the invalid field and retry AskUserQuestion.",
    };

    await expect(
      authorizer.authorize({
        input: { questions: [{ ...input.questions[0], header: "Too long for Claude" }] },
        signal,
        toolUseId: "rejected-question",
      }),
    ).resolves.toEqual(rejected);
    await expect(
      authorizer.authorize({ input, signal, toolUseId: "rejected-question" }),
    ).resolves.toEqual(rejected);
    expect(requestUserInput).not.toHaveBeenCalled();

    await expect(
      authorizer.authorize({ input, signal, toolUseId: "corrected-question" }),
    ).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: {
          "Which test runner should we use?": "Vitest",
          "Which proof should we collect?": "Unit tests",
        },
      },
    });
    expect(requestUserInput).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing questions array", {}, "questions must be an array of 1 to 4 questions"],
    [
      "too many questions",
      {
        questions: [
          { header: "A", question: "Q?", options: validOptions, multiSelect: false },
          { header: "B", question: "Q?", options: validOptions, multiSelect: false },
          { header: "C", question: "Q?", options: validOptions, multiSelect: false },
          { header: "D", question: "Q?", options: validOptions, multiSelect: false },
          { header: "E", question: "Q?", options: validOptions, multiSelect: false },
        ],
      },
      "questions must be an array of 1 to 4 questions",
    ],
    [
      "non-boolean multiSelect",
      {
        questions: [{ header: "Stack", question: "Q?", options: validOptions, multiSelect: "no" }],
      },
      "questions[0].multiSelect must be a boolean",
    ],
    [
      "too few options",
      {
        questions: [
          {
            header: "Stack",
            question: "Q?",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          },
        ],
      },
      "questions[0].options must be an array of 2 to 4 options",
    ],
    [
      "empty option description",
      {
        questions: [
          {
            header: "Stack",
            question: "Q?",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "" },
            ],
            multiSelect: false,
          },
        ],
      },
      "questions[0].options[1].description must not be empty",
    ],
    [
      "missing option label",
      {
        questions: [
          {
            header: "Stack",
            question: "Q?",
            options: validOptions.map((option) => ({ description: option.description })),
            multiSelect: false,
          },
        ],
      },
      "questions[0].options[0].label must be a string",
    ],
    ["non-record question", { questions: ["not a question"] }, "questions[0] must be an object"],
  ])(
    "reports the failed constraint for %s without echoing payload text",
    async (_case, malformedInput, expectedDetail) => {
      const requestUserInput = vi.fn();
      const authorizer = createClaudeCliUserInputAuthorizer(createContext(requestUserInput));

      const result = await authorizer.authorize({
        input: malformedInput as Record<string, unknown>,
        signal: new AbortController().signal,
      });

      expect(result).toEqual({
        behavior: "deny",
        message: `OpenClaw rejected malformed Claude user questions: ${expectedDetail}. Correct the invalid field and retry AskUserQuestion.`,
      });
      expect(requestUserInput).not.toHaveBeenCalled();
    },
  );
});

it.each([
  ["x".repeat(2_000), "x".repeat(1_023) + "…"],
  ["x".repeat(1_022) + "🌍 tail", "x".repeat(1_022) + "…"],
  ["x".repeat(1_024), "x".repeat(1_024)],
])("keeps all questions and answers while bounding description", async (description, displayed) => {
  const requestUserInput = vi.fn<NonNullable<CliBackendExecuteContext["requestUserInput"]>>(
    async () => ({
      status: "answered" as const,
      answers: { question_1: ["Vitest"], question_2: ["Unit tests"] },
    }),
  );
  const payload = {
    questions: [
      {
        ...input.questions[0]!,
        options: [{ label: "Vitest", description }, input.questions[0]!.options[1]!],
      },
      input.questions[1]!,
    ],
  };
  const authorizer = createClaudeCliUserInputAuthorizer(createContext(requestUserInput));
  const result = await authorizer.authorize({
    input: payload,
    signal: new AbortController().signal,
  });
  expect(requestUserInput).toHaveBeenCalledOnce();
  expect(requestUserInput.mock.calls[0]?.[0]).toMatchObject({
    questions: [
      {
        id: "question_1",
        options: [{ label: "Vitest", description: displayed }, input.questions[0]!.options[1]!],
      },
      { id: "question_2", question: input.questions[1]!.question },
    ],
  });
  expect(payload.questions[0]!.options[0]!.description).toBe(description);
  expect(result).toMatchObject({
    behavior: "allow",
    updatedInput: {
      answers: {
        "Which test runner should we use?": "Vitest",
        "Which proof should we collect?": "Unit tests",
      },
    },
  });
});
it.each(["label", "question"])("still rejects oversized %s", async (field) => {
  const requestUserInput = vi.fn();
  const question = {
    ...input.questions[0]!,
    options: input.questions[0]!.options.map((option) => Object.assign({}, option)),
  };
  if (field === "label") {
    question.options[0]!.label = "x".repeat(257);
  } else {
    question.question = "x".repeat(4097);
  }
  const result = await createClaudeCliUserInputAuthorizer(
    createContext(requestUserInput),
  ).authorize({
    input: { questions: [question] },
    signal: new AbortController().signal,
  });
  expect(result.behavior).toBe("deny");
  expect(requestUserInput).not.toHaveBeenCalled();
});
