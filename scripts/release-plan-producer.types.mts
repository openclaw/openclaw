import type { ReleasePlan } from "./release-plan-contract.mjs";
export type ReleasePlanIntent =
  | "publish"
  | "diagnostic"
  | "postpublish-confidence"
  | "main-qualification";
export type MainQualificationValidationIntent = "main-daily" | "main-weekly";
export type RunGh = (args: string[]) => string;
export type ReleaseInventorySource = {
  repoRoot?: string;
  candidateSha: string;
  toolingSha: string;
  toolingFullRef: string;
  qualificationAdmission?: unknown;
  qualificationInputs?: Record<string, string | boolean | number>;
  runGh?: RunGh;
  downloadArchive?: (args: string[]) => Uint8Array;
};
export type ReleasePlanSourceBase = ReleaseInventorySource & { candidateRef: string };
export type ReleasePlanSource =
  | (ReleasePlanSourceBase & {
      intent: "main-qualification";
      validationIntent: MainQualificationValidationIntent;
    })
  | (ReleasePlanSourceBase & {
      intent: Exclude<ReleasePlanIntent, "main-qualification">;
      validationIntent?: never;
    });
export type VerifiedReleaseInventory = {
  candidateSha: string;
  tooling: ReleasePlan["tooling"];
  version: string;
  inventory: ReleasePlan["inventory"];
};
