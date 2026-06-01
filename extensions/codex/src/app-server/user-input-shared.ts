import { formatCodexDisplayText } from "../command-formatters.js";
import type { JsonObject } from "./protocol.js";

export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
};

export type UserInputOption = {
  label: string;
  description: string;
};

export function formatUserInputPrompt(questions: UserInputQuestion[]): string {
  const lines = ["Codex needs input:"];
  questions.forEach((question, index) => {
    if (questions.length > 1) {
      lines.push(
        "",
        `${index + 1}. ${formatCodexDisplayText(question.header)}`,
        formatCodexDisplayText(question.question),
      );
    } else {
      lines.push(
        "",
        formatCodexDisplayText(question.header),
        formatCodexDisplayText(question.question),
      );
    }
    if (question.isSecret) {
      lines.push("This channel may show your reply to other participants.");
    }
    question.options?.forEach((option, optionIndex) => {
      lines.push(
        `${optionIndex + 1}. ${formatCodexDisplayText(option.label)}${
          option.description ? ` - ${formatCodexDisplayText(option.description)}` : ""
        }`,
      );
    });
    if (question.isOther) {
      lines.push("Other: reply with your own answer.");
    }
  });
  return lines.join("\n");
}

export function buildUserInputResponse(
  questions: UserInputQuestion[],
  inputText: string,
): JsonObject {
  const answers: JsonObject = {};
  if (questions.length === 1) {
    const question = questions[0];
    if (question) {
      const answer = normalizeAnswer(inputText, question);
      answers[question.id] = { answers: answer ? [answer] : [] };
    }
    return { answers };
  }

  const keyed = parseKeyedAnswers(inputText);
  const fallbackLines = inputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  questions.forEach((question, index) => {
    const key =
      keyed.get(question.id.toLowerCase()) ??
      keyed.get(question.header.toLowerCase()) ??
      keyed.get(question.question.toLowerCase()) ??
      keyed.get(String(index + 1));
    const answer = key ?? fallbackLines[index] ?? "";
    const normalized = answer ? normalizeAnswer(answer, question) : undefined;
    answers[question.id] = { answers: normalized ? [normalized] : [] };
  });
  return { answers };
}

export function emptyUserInputResponse(): JsonObject {
  return { answers: {} };
}

function normalizeAnswer(answer: string, question: UserInputQuestion): string | undefined {
  const trimmed = answer.trim();
  const options = question.options ?? [];
  const optionIndex = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
  const indexed = optionIndex >= 0 ? options[optionIndex] : undefined;
  if (indexed) {
    return indexed.label;
  }
  const exact = options.find((option) => option.label.toLowerCase() === trimmed.toLowerCase());
  if (exact) {
    return exact.label;
  }
  if (options.length > 0 && !question.isOther) {
    return undefined;
  }
  return trimmed || undefined;
}

function parseKeyedAnswers(inputText: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const line of inputText.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:=-]+?)\s*[:=-]\s*(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const key = match[1]?.trim().toLowerCase();
    const value = match[2]?.trim();
    if (key && value) {
      answers.set(key, value);
    }
  }
  return answers;
}
