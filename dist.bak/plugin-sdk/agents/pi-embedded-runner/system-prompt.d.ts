import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { ResolvedTimeFormat } from "../date-time.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { type PromptMode } from "../system-prompt.js";
import type { EmbeddedSandboxInfo } from "./types.js";
import type { ReasoningLevel, ThinkLevel } from "./utils.js";
export declare function buildEmbeddedSystemPrompt(params: {
    workspaceDir: string;
    defaultThinkLevel?: ThinkLevel;
    reasoningLevel?: ReasoningLevel;
    extraSystemPrompt?: string;
    ownerNumbers?: string[];
    ownerDisplay?: "raw" | "hash";
    ownerDisplaySecret?: string;
    reasoningTagHint: boolean;
    heartbeatPrompt?: string;
    skillsPrompt?: string;
    docsPath?: string;
    ttsHint?: string;
    reactionGuidance?: {
        level: "minimal" | "extensive";
        channel: string;
    };
    workspaceNotes?: string[];
    /** Controls which hardcoded sections to include. Defaults to "full". */
    promptMode?: PromptMode;
    /** Whether ACP-specific routing guidance should be included. Defaults to true. */
    acpEnabled?: boolean;
    runtimeInfo: {
        agentId?: string;
        host: string;
        os: string;
        arch: string;
        node: string;
        model: string;
        provider?: string;
        capabilities?: string[];
        channel?: string;
        /** Supported message actions for the current channel (e.g., react, edit, unsend) */
        channelActions?: string[];
    };
    messageToolHints?: string[];
    sandboxInfo?: EmbeddedSandboxInfo;
    tools: AgentTool[];
    modelAliasLines: string[];
    userTimezone: string;
    userTime?: string;
    userTimeFormat?: ResolvedTimeFormat;
    contextFiles?: EmbeddedContextFile[];
    memoryCitationsMode?: MemoryCitationsMode;
}): string;
export declare function createSystemPromptOverride(systemPrompt: string): (defaultPrompt?: string) => string;
export declare function applySystemPromptOverrideToSession(session: AgentSession, override: string | ((defaultPrompt?: string) => string)): void;
