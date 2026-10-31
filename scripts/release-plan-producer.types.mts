import type { ReleaseInventorySource } from "./lib/release-plan-source.mts";
import type { ReleasePlan } from "./release-plan-contract.mjs";
import type { ReleaseValidationIntent } from "./release-validation-intent.mjs";
export type { ReleaseInventorySource } from "./lib/release-plan-source.mts";
export type ReleasePlanIntent =
  | "publish"
  | "diagnostic"
  | "postpublish-confidence"
  | "main-qualification";
export type MainQualificationValidationIntent = Extract<
  ReleaseValidationIntent,
  "main-daily" | "main-weekly"
>;
export type RunGh = NonNullable<ReleaseInventorySource["runGh"]>;
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
export type VerifiedReleaseInventory = Pick<ReleasePlan, "tooling" | "version" | "inventory"> &
  Pick<ReleaseInventorySource, "candidateSha">;
