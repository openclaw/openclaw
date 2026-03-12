import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { type ActiveMediaModel } from "./runner.js";
import type { MediaUnderstandingProvider } from "./types.js";
/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
export declare function transcribeFirstAudio(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    agentDir?: string;
    providers?: Record<string, MediaUnderstandingProvider>;
    activeModel?: ActiveMediaModel;
}): Promise<string | undefined>;
