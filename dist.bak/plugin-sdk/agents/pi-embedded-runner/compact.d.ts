import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type enqueueCommand } from "../../process/command-queue.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import { type SkillSnapshot } from "../skills.js";
import type { EmbeddedPiCompactResult } from "./types.js";
export type CompactEmbeddedPiSessionParams = {
    sessionId: string;
    runId?: string;
    sessionKey?: string;
    messageChannel?: string;
    messageProvider?: string;
    agentAccountId?: string;
    authProfileId?: string;
    /** Group id for channel-level tool policy resolution. */
    groupId?: string | null;
    /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
    groupChannel?: string | null;
    /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
    groupSpace?: string | null;
    /** Parent session key for subagent policy inheritance. */
    spawnedBy?: string | null;
    /** Whether the sender is an owner (required for owner-only tools). */
    senderIsOwner?: boolean;
    sessionFile: string;
    workspaceDir: string;
    agentDir?: string;
    config?: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
    provider?: string;
    model?: string;
    thinkLevel?: ThinkLevel;
    reasoningLevel?: ReasoningLevel;
    bashElevated?: ExecElevatedDefaults;
    customInstructions?: string;
    trigger?: "overflow" | "manual";
    diagId?: string;
    attempt?: number;
    maxAttempts?: number;
    lane?: string;
    enqueue?: typeof enqueueCommand;
    extraSystemPrompt?: string;
    ownerNumbers?: string[];
};
/**
 * Core compaction logic without lane queueing.
 * Use this when already inside a session/global lane to avoid deadlocks.
 */
export declare function compactEmbeddedPiSessionDirect(params: CompactEmbeddedPiSessionParams): Promise<EmbeddedPiCompactResult>;
/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedPiSessionDirect` to avoid deadlocks.
 */
export declare function compactEmbeddedPiSession(params: CompactEmbeddedPiSessionParams): Promise<EmbeddedPiCompactResult>;
