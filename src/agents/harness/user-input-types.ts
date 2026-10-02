import type {
  QuestionOption,
  QuestionResourceInput,
} from "../../../packages/gateway-protocol/src/schema/questions.js";

export type AgentHarnessUserInputOption = QuestionOption;

export type AgentHarnessUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  /** External step to open without answering the question. */
  url?: string;
  multiSelect?: boolean;
  presentation?: "form";
  resource?: QuestionResourceInput;
  /** Custom array entries are entered one per line. */
  answerFormat?: "lines";
  allowEmpty?: boolean;
  defaultAnswers?: readonly string[];
  isOther?: boolean;
  isSecret?: boolean;
  options?: readonly AgentHarnessUserInputOption[] | null;
};

export type AgentHarnessUserInputAnswers = {
  answers: Record<string, { answers: string[] }>;
};
