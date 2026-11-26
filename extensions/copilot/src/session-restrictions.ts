import type { SessionConfig } from "@github/copilot-sdk";

const COPILOT_ISOLATED_EXCLUDED_TOOLS = ["builtin:*", "mcp:*", "custom:*"] as const;

/** Disable ambient startup capabilities; callers disable remote export before sending. */
export function createCopilotIsolatedSessionRestrictions(): Partial<SessionConfig> {
  return {
    availableTools: [],
    coauthorEnabled: false,
    customAgents: [],
    customAgentsLocalOnly: true,
    embeddingCacheStorage: "in-memory",
    enableConfigDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableOnDemandInstructionDiscovery: false,
    enableSessionStore: false,
    enableSkills: false,
    excludedTools: [...COPILOT_ISOLATED_EXCLUDED_TOOLS],
    includeSubAgentStreamingEvents: false,
    infiniteSessions: { enabled: false },
    instructionDirectories: [],
    manageScheduleEnabled: false,
    mcpOAuthTokenStorage: "in-memory",
    mcpServers: {},
    memory: { enabled: false },
    pluginDirectories: [],
    requestCanvasRenderer: false,
    requestExtensions: false,
    skillDirectories: [],
    skipCustomInstructions: true,
    skipEmbeddingRetrieval: true,
    tools: [],
  };
}
