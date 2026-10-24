import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

function authorizerFor(requestUserInput: CliBackendExecuteContext["requestUserInput"]) {
  return createClaudeCliUserInputAuthorizer({
    command: "/usr/local/bin/claude",
    args: [],
    cwd: "/tmp",
    env: {},
    prompt: "test",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "test",
    useResume: false,
    timeoutMs: 30_000,
    requestToolPermission: async () => ({ behavior: "allow", updatedInput: {} }),
    requestUserInput,
  });
}

const options = (...labels: string[]) =>
  labels.map((label) => ({ label, description: "Use " + label }));
const validOptions = options("A", "B");
const question = (overrides: Record<string, unknown> = {}) => ({
  header: "Stack",
  question: "Q?",
  options: validOptions,
  multiSelect: false,
  ...overrides,
});
const malformed = (overrides: Record<string, unknown>) => ({ questions: [question(overrides)] });
const mappedAnswers = (proof: string) => ({ "Runner?": "Vitest", "Proof?": proof });
const answered = (...proof: string[]) =>
  vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
    status: "answered",
    answers: { question_1: ["Vitest"], question_2: proof },
  }));
const input = {
  questions: [
    question({ question: "Runner?", options: options("Vitest", "Node test") }),
    question({
      header: "Proof",
      question: "Proof?",
      options: options("Unit tests", "UI proof"),
      multiSelect: true,
    }),
  ],
};
const allowed = (proof: string) => ({
  behavior: "allow",
  updatedInput: { ...input, answers: mappedAnswers(proof) },
});
const rejectedQuestions = (detail: string) => ({
  behavior: "deny",
  message: `OpenClaw rejected malformed Claude user questions: ${detail}. Correct the invalid field and retry AskUserQuestion.`,
});
function ask(
  authorizer: ReturnType<typeof authorizerFor>,
  payload: Record<string, unknown> = input,
  toolUseId?: string,
) {
  return authorizer.authorize({ input: payload, toolUseId, signal: new AbortController().signal });
}

describe("Claude CLI user input adapter", () => {
  it("maps Claude questions and answers while deduplicating the CLI callbacks", async () => {
    const requestUserInput = answered("Unit tests", "UI proof");
    const authorizer = authorizerFor(requestUserInput);
    const signal = new AbortController().signal;

    const first = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });
    const second = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });

    await expect(first).resolves.toEqual(allowed("Unit tests, UI proof"));
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

  it("shortens an over-long option description instead of denying every question", async () => {
    const requestUserInput = answered("Unit tests");
    const long = "x".repeat(2_000);
    const payload = {
      questions: [question({ options: [...options("A"), { label: "B", description: long }] })],
    };

    const result = await ask(authorizerFor(requestUserInput), payload);

    const [asked] = requestUserInput.mock.calls[0]![0].questions;
    expect(asked!.options![1]).toEqual({ label: "B", description: `${"x".repeat(1_023)}\u2026` });
    expect(result).toMatchObject({ behavior: "allow" });
  });

  it("returns actionable denial guidance when the operator skips", async () => {
    const authorizer = authorizerFor(async () => ({
      status: "cancelled",
      message: "The operator skipped this question.",
    }));

    await expect(ask(authorizer)).resolves.toEqual({
      behavior: "deny",
      message: "The operator skipped this question. Continue with your best judgment.",
    });
  });

  it("guides a malformed question retry without replaying the rejected call", async () => {
    const requestUserInput = answered("Unit tests");
    const authorizer = authorizerFor(requestUserInput);
    const rejected = rejectedQuestions("questions[0].header must be at most 12 characters");
    const invalid = malformed({ header: "Too long for Claude" });

    await expect(ask(authorizer, invalid, "rejected-question")).resolves.toEqual(rejected);
    await expect(ask(authorizer, input, "rejected-question")).resolves.toEqual(rejected);
    expect(requestUserInput).not.toHaveBeenCalled();

    await expect(ask(authorizer, input, "corrected-question")).resolves.toEqual(
      allowed("Unit tests"),
    );
    expect(requestUserInput).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing questions array", {}, "questions must be an array of 1 to 4 questions"],
    [
      "too many questions",
      { questions: ["A", "B", "C", "D", "E"].map((header) => question({ header })) },
      "questions must be an array of 1 to 4 questions",
    ],
    [
      "non-boolean multiSelect",
      malformed({ multiSelect: "no" }),
      "questions[0].multiSelect must be a boolean",
    ],
    [
      "too few options",
      malformed({ options: options("A") }),
      "questions[0].options must be an array of 2 to 4 options",
    ],
    [
      "empty option description",
      malformed({ options: [...options("A"), { label: "B", description: "" }] }),
      "questions[0].options[1].description must not be empty",
    ],
    [
      "missing option label",
      malformed({ options: validOptions.map(({ description }) => ({ description })) }),
      "questions[0].options[0].label must be a string",
    ],
    ["non-record question", { questions: ["not a question"] }, "questions[0] must be an object"],
  ])(
    "reports the failed constraint for %s without echoing payload text",
    async (_case, malformedInput, expectedDetail) => {
      const requestUserInput = vi.fn();
      const authorizer = authorizerFor(requestUserInput);

      const result = await ask(authorizer, malformedInput as Record<string, unknown>);

      expect(result).toEqual(rejectedQuestions(expectedDetail));
      expect(requestUserInput).not.toHaveBeenCalled();
    },
  );
});
