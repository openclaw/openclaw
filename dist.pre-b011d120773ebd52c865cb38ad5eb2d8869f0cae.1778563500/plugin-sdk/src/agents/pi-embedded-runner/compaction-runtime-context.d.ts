import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { SkillSnapshot } from "../skills.js";
export type EmbeddedCompactionRuntimeContext = {
    sessionKey?: string;
    messageChannel?: string;
    messageProvider?: string;
    agentAccountId?: string;
    currentChannelId?: string;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    authProfileId?: string;
    workspaceDir: string;
    agentDir: string;
    config?: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
    senderIsOwner?: boolean;
    senderId?: string;
    provider?: string;
    model?: string;
    modelFallbacksOverride?: string[];
    thinkLevel?: ThinkLevel;
    reasoningLevel?: ReasoningLevel;
    bashElevated?: ExecElevatedDefaults;
    extraSystemPrompt?: string;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    ownerNumbers?: string[];
};
/**
 * Resolve the effective compaction target from config, falling back to the
 * caller-supplied provider/model and optionally applying runtime defaults.
 */
export declare function resolveEmbeddedCompactionTarget(params: {
    config?: OpenClawConfig;
    provider?: string | null;
    modelId?: string | null;
    authProfileId?: string | null;
    defaultProvider?: string;
    defaultModel?: string;
}): {
    provider: string | undefined;
    model: string | undefined;
    authProfileId: string | undefined;
};
export declare function buildEmbeddedCompactionRuntimeContext(params: {
    sessionKey?: string | null;
    messageChannel?: string | null;
    messageProvider?: string | null;
    agentAccountId?: string | null;
    currentChannelId?: string | null;
    currentThreadTs?: string | null;
    currentMessageId?: string | number | null;
    authProfileId?: string | null;
    workspaceDir: string;
    agentDir: string;
    config?: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
    senderIsOwner?: boolean;
    senderId?: string | null;
    provider?: string | null;
    modelId?: string | null;
    modelFallbacksOverride?: string[];
    thinkLevel?: ThinkLevel;
    reasoningLevel?: ReasoningLevel;
    bashElevated?: ExecElevatedDefaults;
    extraSystemPrompt?: string;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    ownerNumbers?: string[];
}): EmbeddedCompactionRuntimeContext;
