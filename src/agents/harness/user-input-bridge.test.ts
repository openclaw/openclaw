import { describe, expect, it } from "vitest";
import {
  buildAgentHarnessQuestionPromptPayload,
  buildAgentHarnessUserInputAnswers,
  formatAgentHarnessUserInputPrompt,
} from "./user-input-bridge.js";
import type { AgentHarnessUserInputQuestion } from "./user-input-types.js";

const question = (id: string, options: Partial<AgentHarnessUserInputQuestion> = {}) => ({
  id,
  header: id,
  question: id,
  ...options,
});

const twoQuestions: AgentHarnessUserInputQuestion[] = [
  question("ruling4_deny_case", {
    header: "Ruling 4",
    question: "Should the denial stand?",
    isOther: true,
    options: [{ label: "Deny" }, { label: "Allow" }, { label: "Escalate" }],
  }),
  question("cas1_authorization", {
    header: "CAS1 auth",
    question: "Which CAS1 authorization applies?",
    isOther: true,
    options: [{ label: "Approved" }, { label: "Deferred" }],
  }),
];

describe("buildAgentHarnessUserInputAnswers (regression #190485)", () => {
  it("binds a reply line keyed by the real question id", () => {
    expect(buildAgentHarnessUserInputAnswers(twoQuestions, "ruling4_deny_case: Deny")).toEqual({
      answers: {
        ruling4_deny_case: { answers: ["Deny"] },
        cas1_authorization: { answers: [] },
      },
    });
  });

  it("binds a numeric line with a trailing dot to the first question", () => {
    // "1. Approved": the trailing dot is punctuation, so the key normalizes to
    // "1" and binds question 1; the answer text is preserved.
    const answers = buildAgentHarnessUserInputAnswers(twoQuestions, "1. Approved");
    expect(answers.answers.ruling4_deny_case?.answers).toEqual(["Approved"]);
    expect(answers.answers.cas1_authorization?.answers).toEqual([]);
  });

  it("binds numbered lines with trailing dots to each question by position", () => {
    const answers = buildAgentHarnessUserInputAnswers(twoQuestions, "1. Deny\n2. Approved");
    expect(answers.answers.ruling4_deny_case?.answers).toEqual(["Deny"]);
    expect(answers.answers.cas1_authorization?.answers).toEqual(["Approved"]);
  });

  it("does not leave a later question empty for a single prose line answering all questions", () => {
    const answers = buildAgentHarnessUserInputAnswers(
      twoQuestions,
      "Approved all questions ever number is approved",
    );
    expect(answers.answers.ruling4_deny_case?.answers).toEqual([
      "Approved all questions ever number is approved",
    ]);
    expect(answers.answers.cas1_authorization?.answers).toEqual([
      "Approved all questions ever number is approved",
    ]);
  });

  it("keeps positional fallback lines aligned when only some lines are keyed", () => {
    // "1." keys question 1; the second line is positional for question 2.
    const answers = buildAgentHarnessUserInputAnswers(twoQuestions, "1. Deny\nApproved");
    expect(answers.answers.ruling4_deny_case?.answers).toEqual(["Deny"]);
    expect(answers.answers.cas1_authorization?.answers).toEqual(["Approved"]);
  });
});

describe("multi-question reply guidance (regression #190485)", () => {
  it("does not tell users to reply by number when the prompt exposes no numbers", () => {
    const { text } = buildAgentHarnessQuestionPromptPayload({
      questionId: "card",
      questions: twoQuestions,
    });
    expect(text).toContain("Answer each question by number or question id, one answer per line.");
    expect(text).not.toContain("Reply by number or question id.");
    // The prompt numbers the questions (1. / 2.) so "by number" is possible.
    const prompt = formatAgentHarnessUserInputPrompt(twoQuestions);
    expect(prompt).toContain("1. Ruling 4");
    expect(prompt).toContain("2. CAS1 auth");
  });
});

describe("question presentation fallback text (regression #190485)", () => {
  it("numbers option bullets so 'reply by number' is possible on degraded channels", () => {
    const [{ ...singleQuestion }] = twoQuestions;
    const { presentation } = buildAgentHarnessQuestionPromptPayload({
      questionId: "card",
      questions: [singleQuestion],
    });
    expect(presentation).toBeDefined();
    const blocks = presentation?.blocks ?? [];
    const textBlocks = blocks.filter((block) => block.type === "text");
    expect(textBlocks).toHaveLength(2);
    const optionGuidance = textBlocks[1]?.type === "text" ? textBlocks[1].text : "";
    expect(optionGuidance).toContain("1. Deny");
    expect(optionGuidance).toContain("2. Allow");
    expect(optionGuidance).toContain("3. Escalate");
    expect(optionGuidance).not.toContain("- Deny");
  });
});
