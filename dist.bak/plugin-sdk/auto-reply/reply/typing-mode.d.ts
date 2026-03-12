import type { TypingMode } from "../../config/types.js";
import type { TypingPolicy } from "../types.js";
import type { TypingController } from "./typing.js";
export type TypingModeContext = {
    configured?: TypingMode;
    isGroupChat: boolean;
    wasMentioned: boolean;
    isHeartbeat: boolean;
    typingPolicy?: TypingPolicy;
    suppressTyping?: boolean;
};
export declare const DEFAULT_GROUP_TYPING_MODE: TypingMode;
export declare function resolveTypingMode({ configured, isGroupChat, wasMentioned, isHeartbeat, typingPolicy, suppressTyping, }: TypingModeContext): TypingMode;
export type TypingSignaler = {
    mode: TypingMode;
    shouldStartImmediately: boolean;
    shouldStartOnMessageStart: boolean;
    shouldStartOnText: boolean;
    shouldStartOnReasoning: boolean;
    signalRunStart: () => Promise<void>;
    signalMessageStart: () => Promise<void>;
    signalTextDelta: (text?: string) => Promise<void>;
    signalReasoningDelta: () => Promise<void>;
    signalToolStart: () => Promise<void>;
};
export declare function createTypingSignaler(params: {
    typing: TypingController;
    mode: TypingMode;
    isHeartbeat: boolean;
}): TypingSignaler;
