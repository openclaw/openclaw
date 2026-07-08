import { describe, expect, it } from "vitest";
import { buildAgentHarnessUserInputAnswers, type AgentHarnessUserInputQuestion } from "./user-input-bridge.js";

function makeQuestions(count: number): AgentHarnessUserInputQuestion[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `q${i + 1}`,
    header: `Question ${i + 1}`,
    question: `What is answer ${i + 1}?`,
    isOther: true,
    isSecret: false,
    options: null,
  }));
}

describe("buildAgentHarnessUserInputAnswers", () => {
  describe("parseKeyedAnswers (via multi-question input)", () => {
    it("parses key: value pairs", () => {
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(questions, "q1: hello\nq2: world");
      expect(result.answers).toEqual({
        q1: { answers: ["hello"] },
        q2: { answers: ["world"] },
      });
    });

    it("parses key=value pairs", () => {
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(questions, "q1 = alpha\nq2 = beta");
      expect(result.answers).toEqual({
        q1: { answers: ["alpha"] },
        q2: { answers: ["beta"] },
      });
    });

    it("parses key - value pairs", () => {
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(questions, "q1 - first\nq2 - second");
      expect(result.answers).toEqual({
        q1: { answers: ["first"] },
        q2: { answers: ["second"] },
      });
    });

    it("parses numbered answers (1: answer format)", () => {
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(questions, "1: alpha\n2: beta");
      expect(result.answers).toEqual({
        q1: { answers: ["alpha"] },
        q2: { answers: ["beta"] },
      });
    });

    it("does NOT split URLs at :// (https://)", () => {
      const questions = makeQuestions(3);
      const result = buildAgentHarnessUserInputAnswers(
        questions,
        "q1: see https://example.com/path\nq2: normal\nq3: also http://test.com",
      );
      expect(result.answers.q1?.answers[0]).toContain("https://example.com/path");
      expect(result.answers.q2?.answers[0]).toBe("normal");
      expect(result.answers.q3?.answers[0]).toContain("http://test.com");
    });

    it("does NOT split Windows paths at :\\", () => {
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(
        questions,
        "q1: file at C:\\Users\\foo\\bar.txt\nq2: normal",
      );
      expect(result.answers.q1?.answers[0]).toContain("C:\\Users\\foo\\bar.txt");
      expect(result.answers.q2?.answers[0]).toBe("normal");
    });

    it("does NOT split time strings (14:30)", () => {
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(
        questions,
        "q1: meet at 14:30 tomorrow\nq2: done",
      );
      // The line "q1: meet at 14:30 tomorrow" should be parsed as key="q1",
      // value="meet at 14:30 tomorrow". The "14:30" within the value should
      // not cause a false split because the keyed-answer regex already
      // captured the outer "q1: ..." pair.
      expect(result.answers.q1?.answers[0]).toContain("14:30");
      expect(result.answers.q2?.answers[0]).toBe("done");
    });

    it("does NOT split a bare time-like line into a fake keyed answer", () => {
      // Simulate fallback parsing: only the last line has a valid key.
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(questions, "14:30\nq2: real answer");
      // "14:30" should not produce a fake key entry because both key and value
      // are purely numeric. It falls through to fallback line indexing.
      expect(result.answers.q1?.answers[0]).toBe("14:30");
      expect(result.answers.q2?.answers[0]).toBe("real answer");
    });

    it("does NOT split a bare date-like line (2026-07-08) into a fake keyed answer", () => {
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(questions, "2026-07-08\nq2: real answer");
      // "2026-07-08" has key="2026", value="07-08" — value contains non-digit
      // chars (`-`) so the numeric guard doesn't catch it. But the keyed
      // answer key "2026" won't match any question id/header/index so it
      // falls through to fallback.
      expect(result.answers.q1?.answers[0]).toBe("2026-07-08");
      expect(result.answers.q2?.answers[0]).toBe("real answer");
    });

    it("handles single-question input (no keyed parsing)", () => {
      const questions = makeQuestions(1);
      const result = buildAgentHarnessUserInputAnswers(questions, "my answer here");
      expect(result.answers).toEqual({
        q1: { answers: ["my answer here"] },
      });
    });

    it("handles empty input", () => {
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(questions, "");
      expect(result.answers).toEqual({
        q1: { answers: [] },
        q2: { answers: [] },
      });
    });

    it("handles lines without delimiters as fallback", () => {
      const questions = makeQuestions(2);
      const result = buildAgentHarnessUserInputAnswers(questions, "alpha\nbeta");
      expect(result.answers).toEqual({
        q1: { answers: ["alpha"] },
        q2: { answers: ["beta"] },
      });
    });
  });
});
