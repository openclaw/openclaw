/** Z.AI's native Claude Agent SDK backend. */
import { buildClaudeAgentSdkCliBackend } from "openclaw/plugin-sdk/claude-agent-sdk-runtime";

const ZAI_CLAUDE_AGENT_SDK_BACKEND_ID = "zai-claude-agent-sdk";
const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";

/**
 * Run configured Z.AI models through Claude Code's official Agent SDK.
 *
 * This is intentionally an explicit runtime opt-in. It never changes the
 * native Anthropic backend's endpoint or ambient authentication behavior.
 */
export function buildZaiClaudeAgentSdkBackend() {
  const backend = buildClaudeAgentSdkCliBackend({
    backendId: ZAI_CLAUDE_AGENT_SDK_BACKEND_ID,
    modelProvider: "zai",
    defaultModelRef: "zai/glm-4.7",
    endpoint: ZAI_ANTHROPIC_BASE_URL,
    apiKeyAsAuthToken: true,
    modelAliases: {},
    supportsOneMillionModelSuffix: false,
    // Z.AI credentials are ordinary API keys; they do not need subscription
    // auth dispatch semantics reserved for Anthropic's OAuth plans.
    subscriptionAuthDispatch: false,
  });
  return {
    ...backend,
    config: {
      ...backend.config,
      // Selected keys use the protected bearer route, not an ambient second copy.
      clearEnv: [...(backend.config.clearEnv ?? []), "ZAI_API_KEY", "Z_AI_API_KEY"],
    },
  };
}
