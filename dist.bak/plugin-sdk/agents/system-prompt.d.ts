import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { EmbeddedSandboxInfo } from "./pi-embedded-runner/types.js";
/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";
type OwnerIdDisplay = "raw" | "hash";
export declare function buildAgentSystemPrompt(params: {
    workspaceDir: string;
    defaultThinkLevel?: ThinkLevel;
    reasoningLevel?: ReasoningLevel;
    extraSystemPrompt?: string;
    ownerNumbers?: string[];
    ownerDisplay?: OwnerIdDisplay;
    ownerDisplaySecret?: string;
    reasoningTagHint?: boolean;
    toolNames?: string[];
    toolSummaries?: Record<string, string>;
    modelAliasLines?: string[];
    userTimezone?: string;
    userTime?: string;
    userTimeFormat?: ResolvedTimeFormat;
    contextFiles?: EmbeddedContextFile[];
    skillsPrompt?: string;
    heartbeatPrompt?: string;
    docsPath?: string;
    workspaceNotes?: string[];
    ttsHint?: string;
    /** Controls which hardcoded sections to include. Defaults to "full". */
    promptMode?: PromptMode;
    /** Whether ACP-specific routing guidance should be included. Defaults to true. */
    acpEnabled?: boolean;
    runtimeInfo?: {
        agentId?: string;
        host?: string;
        os?: string;
        arch?: string;
        node?: string;
        model?: string;
        defaultModel?: string;
        shell?: string;
        channel?: string;
        capabilities?: string[];
        repoRoot?: string;
    };
    messageToolHints?: string[];
    sandboxInfo?: EmbeddedSandboxInfo;
    /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
    reactionGuidance?: {
        level: "minimal" | "extensive";
        channel: string;
    };
    memoryCitationsMode?: MemoryCitationsMode;
}): string;
export declare function buildRuntimeLine(runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    repoRoot?: string;
}, runtimeChannel?: string, runtimeCapabilities?: string[], defaultThinkLevel?: ThinkLevel): string;
export {};
