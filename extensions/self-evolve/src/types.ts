export type EmbeddingProvider = "openai" | "hash";
export type LearnMode = "balanced" | "tools_only" | "all";

export type SelfEvolveConfig = {
  embedding: {
    provider: EmbeddingProvider;
    apiKey?: string;
    baseUrl?: string;
    model: string;
    dimensions?: number;
  };
  retrieval: {
    k1: number;
    k2: number;
    delta: number;
    tau: number;
    lambda: number;
    epsilon: number;
  };
  learning: {
    alpha: number;
    gamma: number;
    qInit: number;
    rewardSuccess: number;
    rewardFailure: number;
  };
  memory: {
    maxEntries: number;
    maxExperienceChars: number;
    includeFailures: boolean;
    stateFile?: string;
  };
  reward: {
    provider: "openai";
    apiKey?: string;
    baseUrl?: string;
    model: string;
    temperature: number;
  };
  runtime: {
    minPromptChars: number;
    observeTurns: number;
    minAbsReward: number;
    minRewardConfidence: number;
    learnMode: LearnMode;
    noToolMinAbsReward: number;
    noToolMinRewardConfidence: number;
    newIntentSimilarityThreshold: number;
    idleTurnsToClose: number;
    pendingTtlMs: number;
    maxTurnsPerTask: number;
  };
  experience: {
    summarizer: "openai";
    apiKey?: string;
    baseUrl?: string;
    model: string;
    temperature: number;
    maxToolEvents: number;
    maxRawChars: number;
    maxSummaryChars: number;
  };
};

export type EpisodicTriplet = {
  id: string;
  intent: string;
  experience: string;
  embedding: number[];
  qValue: number;
  visits: number;
  selectedCount: number;
  successCount: number;
  lastReward: number;
  createdAt: number;
  updatedAt: number;
};

export type EpisodicStateFile = {
  version: 1;
  entries: EpisodicTriplet[];
};

export type RetrievalCandidate = {
  triplet: EpisodicTriplet;
  similarity: number;
};

export type ScoredCandidate = RetrievalCandidate & {
  similarityZ: number;
  qValueZ: number;
  score: number;
};
