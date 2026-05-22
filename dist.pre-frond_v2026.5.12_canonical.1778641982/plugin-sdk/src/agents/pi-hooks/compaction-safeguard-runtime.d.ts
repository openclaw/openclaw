import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentCompactionIdentifierPolicy } from "../../config/types.agent-defaults.js";
export type CompactionSafeguardRuntimeValue = {
    maxHistoryShare?: number;
    contextWindowTokens?: number;
    identifierPolicy?: AgentCompactionIdentifierPolicy;
    identifierInstructions?: string;
    customInstructions?: string;
    /**
     * Model to use for compaction summarization.
     * Passed through runtime because `ctx.model` is undefined in the compact.ts workflow
     * (extensionRunner.initialize() is never called in that path).
     */
    model?: Model<Api>;
    recentTurnsPreserve?: number;
    qualityGuardEnabled?: boolean;
    qualityGuardMaxRetries?: number;
    /**
     * Id of a registered compaction provider plugin.
     * When set and found in the compaction provider registry, the provider's
     * `summarize()` is called instead of the built-in `summarizeInStages()`.
     */
    provider?: string;
    /**
     * Pending human-readable cancel reason from the current safeguard compaction
     * attempt. OpenClaw consumes this to replace the upstream generic
     * "Compaction cancelled" message.
     */
    cancelReason?: string;
};
export declare const setCompactionSafeguardRuntime: (sessionManager: unknown, value: CompactionSafeguardRuntimeValue | null) => void;
export declare const getCompactionSafeguardRuntime: (sessionManager: unknown) => CompactionSafeguardRuntimeValue | null;
export declare function setCompactionSafeguardCancelReason(sessionManager: unknown, reason: string | undefined): void;
export declare function consumeCompactionSafeguardCancelReason(sessionManager: unknown): string | null;
