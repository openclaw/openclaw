export type ReactionLevel = "off" | "ack" | "minimal" | "extensive";
export type ResolvedReactionLevel = {
    level: ReactionLevel;
    /** Whether ACK reactions (e.g., 👀 when processing) are enabled. */
    ackEnabled: boolean;
    /** Whether agent-controlled reactions are enabled. */
    agentReactionsEnabled: boolean;
    /** Guidance level for agent reactions (minimal = sparse, extensive = liberal). */
    agentReactionGuidance?: "minimal" | "extensive";
};
export declare function resolveReactionLevel(params: {
    value: unknown;
    defaultLevel: ReactionLevel;
    invalidFallback: "ack" | "minimal";
}): ResolvedReactionLevel;
