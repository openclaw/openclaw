import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { expect, it, vi } from "vitest";
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
const mappedAnswers = (proof: string) => ({ "Runner?": "A", "Proof?": proof });
const answered = (...proof: string[]) =>
  vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
    status: "answered",
    answers: { question_1: ["A"], question_2: proof },
  }));
const input = {
  questions: [
    question({ question: "Runner?" }),
    question({ question: "Proof?", multiSelect: true }),
  ],
};
const allowed = (proof: string) => ({
  behavior: "allow",
  updatedInput: { ...input, answers: mappedAnswers(proof) },
});
const withDescription = (description: string) => [
  { ...input.questions[0], options: [{ label: "A", description }, ...options("B")] },
  input.questions[1],
];
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
async function expectRejected(payload: Record<string, unknown>, field: string) {
  const requestUserInput = vi.fn();
  expect(await ask(authorizerFor(requestUserInput), payload)).toMatchObject({
    behavior: "deny",
    message: expect.stringContaining(field),
  });
  expect(requestUserInput).not.toHaveBeenCalled();
}

it("maps single and multi-select questions and answers", async () => {
  const requestUserInput = answered("A", "B");
  await expect(ask(authorizerFor(requestUserInput))).resolves.toEqual(allowed("A, B"));
  expect(requestUserInput.mock.calls[0]![0].questions).toMatchObject([
    { id: "question_1", multiSelect: false, isOther: true },
    { id: "question_2", multiSelect: true, isOther: true },
  ]);
});

it.each([
  ["an oversized description", "x".repeat(2_000), `${"x".repeat(1_023)}…`],
  ["a surrogate at the boundary", `${"x".repeat(1_022)}🌍 tail`, `${"x".repeat(1_022)}…`],
  ["the exact display limit", "x".repeat(1_024), "x".repeat(1_024)],
])("preserves the question set and answers with %s", async (_case, description, displayed) => {
  const requestUserInput = answered("A");
  const payload = { questions: withDescription(description) };

  const result = await ask(authorizerFor(requestUserInput), payload);

  expect(payload.questions[0]!.options[0]!.description).toBe(description);
  const questions = requestUserInput.mock.calls[0]![0].questions;
  expect(questions).toHaveLength(2);
  expect(questions[0]?.options?.[0]?.description).toBe(displayed);
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
  const requestUserInput = answered("A");
  const authorizer = authorizerFor(requestUserInput);
  const rejected = rejectedQuestions("questions[0].header must be at most 12 characters");
  const invalid = malformed({ header: "Too long for Claude" });

  await expect(ask(authorizer, invalid, "rejected-question")).resolves.toEqual(rejected);
  await expect(ask(authorizer, input, "rejected-question")).resolves.toEqual(rejected);
  expect(requestUserInput).not.toHaveBeenCalled();

  await expect(ask(authorizer, input, "corrected-question")).resolves.toEqual(allowed("A"));
  expect(requestUserInput).toHaveBeenCalledOnce();
});

it.each([
  [undefined, "questions"],
  [Array.from({ length: 5 }, () => question()), "questions"],
  [["not a question"], "questions[0]"],
] as const)("rejects invalid question lists: %j", async (questions, field) => {
  await expectRejected({ questions }, field);
});

it.each([
  ["multiSelect", "no", "multiSelect"],
  ["options", options("A"), "options"],
  ["options", [...options("A"), { label: "B", description: "" }], "options[1].description"],
  ["options", options("A".repeat(257), "B"), "options[0].label"],
  ["question", "Q".repeat(4_097), "question"],
  ["options", validOptions.map(({ description }) => ({ description })), "options[0].label"],
] as const)("identifies invalid %s before asking the user", async (field, value, detail) => {
  await expectRejected(malformed({ [field]: value }), `questions[0].${detail}`);
});
