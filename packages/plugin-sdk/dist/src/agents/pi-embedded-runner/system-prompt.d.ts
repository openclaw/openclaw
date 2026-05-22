import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { SubagentDelegationMode } from "../../config/types.agent-defaults.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentPromptSurfaceKind } from "../../plugins/types.js";
import type { ActiveProcessSessionReference } from "../bash-process-references.js";
import type { BootstrapMode } from "../bootstrap-mode.js";
import type { ResolvedTimeFormat } from "../date-time.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import type { ProviderSystemPromptContribution } from "../system-prompt-contribution.js";
import type { PromptMode, SilentReplyPromptMode } from "../system-prompt.types.js";
import type { EmbeddedSandboxInfo } from "./types.js";
import type { ReasoningLevel, ThinkLevel } from "./utils.js";
export declare function buildEmbeddedSystemPrompt(params: {
    config?: OpenClawConfig;
    agentId?: string;
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
    sourcePath?: string;
    ttsHint?: string;
    reactionGuidance?: {
        level: "minimal" | "extensive";
        channel: string;
    };
    workspaceNotes?: string[];
    /** Controls which hardcoded sections to include. Defaults to "full". */
    promptMode?: PromptMode;
    /** Controls the generic silent-reply section. Channel-aware prompts can set "none". */
    silentReplyPromptMode?: SilentReplyPromptMode;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    /** Prompt-only strength for delegating non-trivial work through sub-agents. */
    subagentDelegationMode?: SubagentDelegationMode;
    /** Whether ACP-specific routing guidance should be included. Defaults to true. */
    acpEnabled?: boolean;
    /** Prompt surface controls runtime-specific fallback fragments. Defaults to PI main. */
    promptSurface?: AgentPromptSurfaceKind;
    /** Registered runtime slash/native command names such as `codex`. */
    nativeCommandNames?: string[];
    /** Plugin-owned prompt guidance for registered native slash commands. */
    nativeCommandGuidanceLines?: string[];
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
        activeProcessSessions?: ActiveProcessSessionReference[];
    };
    messageToolHints?: string[];
    sandboxInfo?: EmbeddedSandboxInfo;
    tools: AgentTool[];
    modelAliasLines?: string[];
    userTimezone: string;
    userTime?: string;
    userTimeFormat?: ResolvedTimeFormat;
    contextFiles?: EmbeddedContextFile[];
    bootstrapMode?: BootstrapMode;
    bootstrapTruncationNotice?: string;
    includeMemorySection?: boolean;
    memoryCitationsMode?: MemoryCitationsMode;
    promptContribution?: ProviderSystemPromptContribution;
}): string;
export declare function createSystemPromptOverride(systemPrompt: string): (defaultPrompt?: string) => string;
export declare function applySystemPromptOverrideToSession(session: AgentSession, override: string | ((defaultPrompt?: string) => string)): void;
