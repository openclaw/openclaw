export type HarnessTier = "allow" | "confirm" | "block";

export type HarnessClassification = {
  tier: HarnessTier;
  reason: string;
  rule?: string;
  layer?: 1 | 2 | 3;
};

export type HarnessMode = "observe" | "enforce";
