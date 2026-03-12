import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { type ActiveMediaModel } from "./runner.js";
import type { MediaUnderstandingDecision, MediaUnderstandingOutput, MediaUnderstandingProvider } from "./types.js";
export type ApplyMediaUnderstandingResult = {
    outputs: MediaUnderstandingOutput[];
    decisions: MediaUnderstandingDecision[];
    appliedImage: boolean;
    appliedAudio: boolean;
    appliedVideo: boolean;
    appliedFile: boolean;
};
export declare function applyMediaUnderstanding(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    agentDir?: string;
    providers?: Record<string, MediaUnderstandingProvider>;
    activeModel?: ActiveMediaModel;
}): Promise<ApplyMediaUnderstandingResult>;
