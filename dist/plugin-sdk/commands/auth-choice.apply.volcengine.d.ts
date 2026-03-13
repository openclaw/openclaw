import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
/** Default model for Volcano Engine auth onboarding. */
export declare const VOLCENGINE_DEFAULT_MODEL = "volcengine-plan/ark-code-latest";
export declare function applyAuthChoiceVolcengine(params: ApplyAuthChoiceParams): Promise<ApplyAuthChoiceResult | null>;
