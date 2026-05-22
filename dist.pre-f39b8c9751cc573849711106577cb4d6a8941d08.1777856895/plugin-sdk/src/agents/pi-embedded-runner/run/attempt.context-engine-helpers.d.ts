import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ContextEngine } from "../../../context-engine/types.js";
import type { BootstrapMode } from "../../bootstrap-mode.js";
import { type NormalizedUsage } from "../../usage.js";
import type { PromptCacheChange } from "../prompt-cache-observability.js";
import type { EmbeddedRunAttemptResult } from "./types.js";
export { assembleHarnessContextEngine as assembleAttemptContextEngine, bootstrapHarnessContextEngine as runAttemptContextEngineBootstrap, finalizeHarnessContextEngineTurn as finalizeAttemptContextEngineTurn, } from "../../harness/context-engine-lifecycle.js";
export type AttemptContextEngine = ContextEngine;
export type AttemptBootstrapContext<TBootstrapFile = unknown, TContextFile = unknown> = {
    bootstrapFiles: TBootstrapFile[];
    contextFiles: TContextFile[];
};
export declare function resolveAttemptBootstrapContext<TBootstrapFile, TContextFile>(params: {
    contextInjectionMode: "always" | "continuation-skip" | "never";
    bootstrapContextMode?: string;
    bootstrapContextRunKind?: string;
    bootstrapMode?: BootstrapMode;
    sessionFile: string;
    hasCompletedBootstrapTurn: (sessionFile: string) => Promise<boolean>;
    resolveBootstrapContextForRun: () => Promise<AttemptBootstrapContext<TBootstrapFile, TContextFile>>;
}): Promise<AttemptBootstrapContext<TBootstrapFile, TContextFile> & {
    isContinuationTurn: boolean;
    shouldRecordCompletedBootstrapTurn: boolean;
}>;
export declare function buildContextEnginePromptCacheInfo(params: {
    retention?: "none" | "short" | "long";
    lastCallUsage?: NormalizedUsage;
    observation?: {
        broke: boolean;
        previousCacheRead?: number;
        cacheRead?: number;
        changes?: PromptCacheChange[] | null;
    } | undefined;
    lastCacheTouchAt?: number | null;
}): EmbeddedRunAttemptResult["promptCache"];
export declare function findCurrentAttemptAssistantMessage(params: {
    messagesSnapshot: AgentMessage[];
    prePromptMessageCount: number;
}): AssistantMessage | undefined;
/** Resolve the effective prompt-cache touch timestamp for the current assistant turn. */
export declare function resolvePromptCacheTouchTimestamp(params: {
    lastCallUsage?: NormalizedUsage;
    assistantTimestamp?: unknown;
    fallbackLastCacheTouchAt?: number | null;
}): number | null;
export declare function buildLoopPromptCacheInfo(params: {
    messagesSnapshot: AgentMessage[];
    prePromptMessageCount: number;
    retention?: "none" | "short" | "long";
    fallbackLastCacheTouchAt?: number | null;
}): EmbeddedRunAttemptResult["promptCache"];
