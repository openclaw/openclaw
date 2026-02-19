export type SocietyOfMindsStrategy = "parallel" | "sequential" | "debate";

export type ModelResult = {
  model: string;
  result: string;
  sessionKey: string;
  runId: string;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  cost?: number;
  error?: string;
};

export type SocietyOfMindsTask = {
  task: string;
  label?: string;
  strategy?: SocietyOfMindsStrategy;
  models?: string[];
  synthesisModel?: string;
  maxConcurrent?: number;
};

export type SocietyOfMindsResult = {
  status: "success" | "partial" | "error";
  synthesizedResult?: string;
  modelResults: ModelResult[];
  errors?: string[];
  totalTokens?: number;
  totalCost?: number;
};

export type ModelRouterDecision = {
  model: string;
  reason: string;
};
