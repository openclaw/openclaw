export type PwAiModule = typeof import("./pw-ai.js");
type PwAiLoadMode = "soft" | "strict";
export declare function getPwAiModule(opts?: {
    mode?: PwAiLoadMode;
}): Promise<PwAiModule | null>;
export {};
