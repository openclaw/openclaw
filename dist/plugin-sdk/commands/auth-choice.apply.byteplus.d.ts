import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
/** Default model for BytePlus auth onboarding. */
export declare const BYTEPLUS_DEFAULT_MODEL = "byteplus-plan/ark-code-latest";
export declare function applyAuthChoiceBytePlus(params: ApplyAuthChoiceParams): Promise<ApplyAuthChoiceResult | null>;
