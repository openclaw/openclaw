export type AgentHarnessUserInputOption = {
  label: string;
  description?: string;
};

export type AgentHarnessUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  /** External step to open without answering the question. */
  url?: string;
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  options?: readonly AgentHarnessUserInputOption[] | null;
};

export type AgentHarnessUserInputAnswers = {
  answers: Record<string, { answers: string[] }>;
};
