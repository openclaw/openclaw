export type PromptTier = "simple" | "medium" | "complex" | "reasoning";

export type DimensionScores = {
  reasoningMarkers: number;
  codePresence: number;
  multiStepPatterns: number;
  technicalTerms: number;
  tokenEstimate: number;
  simpleIndicators: number;
};

export type ClassificationResult = {
  tier: PromptTier;
  confidence: number;
  weightedScore: number;
  scores: DimensionScores;
};

export type TierModelMapping = {
  provider: string;
  model: string;
};

export type SmartRouterConfig = {
  enabled?: boolean;
  confidenceThreshold?: number;
  debug?: boolean;
  tiers?: {
    simple?: TierModelMapping;
    medium?: TierModelMapping;
    complex?: TierModelMapping;
    reasoning?: TierModelMapping;
  };
};
