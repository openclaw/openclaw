import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type CodexAsyncQuestion = {
  title: string;
  options?: string[];
};

/** Keep unsupported question payloads on Codex's complete plain-text fallback. */
export function readCodexAsyncQuestions(value: unknown): CodexAsyncQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    return undefined;
  }
  const questions: CodexAsyncQuestion[] = [];
  for (const entry of value) {
    const question = asOptionalRecord(entry);
    if (!question || !isQuestionText(question.title, 4_096)) {
      return undefined;
    }
    const options = question.options;
    if (options === undefined || options === null) {
      questions.push({ title: question.title });
      continue;
    }
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      options.length > 4 ||
      !options.every((option): option is string => isQuestionText(option, 256))
    ) {
      return undefined;
    }
    questions.push({ title: question.title, options: [...options] });
  }
  return questions;
}

function isQuestionText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && value.trim().length > 0;
}
