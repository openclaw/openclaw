import type {
  QuestionOption,
  QuestionRequestQuestion,
} from "../../../packages/gateway-protocol/src/schema/questions.js";

export type AgentHarnessUserInputOption = QuestionOption;

export type AgentHarnessUserInputQuestion = Omit<
  QuestionRequestQuestion,
  "questionId" | "options" | "defaultAnswers" | "secretStore"
> & {
  id: string;
  defaultAnswers?: readonly string[];
  options?: readonly AgentHarnessUserInputOption[] | null;
};

export type AgentHarnessUserInputAnswers = {
  answers: Record<string, { answers: string[] }>;
};
