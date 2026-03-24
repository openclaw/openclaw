import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONTEXT_TOKENS } from "openclaw/plugin-sdk/provider-models";
import { createAcpStreamFn, resolveAcpAgentConfig } from "./acp-stream-bridge.js";
import { buildAcpProvider } from "./provider-catalog.js";

const PROVIDER_ID = "acp";
const ACP_DEFAULT_MAX_TOKENS = 16_384;
const ACP_DEFAULT_API_KEY = "acp-local";

/**
 * Build a dynamic model definition for any model id passed to the ACP provider.
 *
 * ACP is a pass-through: the underlying agent subprocess resolves the actual
 * model. OpenClaw only needs a runtime model shape to satisfy the runner.
 */
function buildDynamicAcpModel(ctx: ProviderResolveDynamicModelContext): ProviderRuntimeModel {
  return {
    id: ctx.modelId,
    name: ctx.modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: "https://acp.local/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: ACP_DEFAULT_MAX_TOKENS,
  };
}

export default definePluginEntry({
  id: "acp-provider",
  name: "ACP Provider",
  description:
    "ACP (Agent Client Protocol) provider plugin — bridges ACP agents (Gemini CLI, Claude Code, Codex CLI, etc.) as model providers",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ACP",
      docsPath: "/providers/models",
      envVars: ["ACP_COMMAND", "ACP_ARGS", "ACP_CWD"],
      auth: [
        {
          id: "custom",
          label: "ACP Agent",
          hint: "Spawn an ACP agent subprocess (e.g. gemini, claude-agent-acp, codex)",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const prompter = ctx.prompter;

            const command = await prompter.text({
              message: "Enter the ACP agent command (e.g. gemini, claude-agent-acp, codex):",
              initialValue: process.env.ACP_COMMAND || "gemini",
            });

            if (!command || typeof command !== "string") {
              return { profiles: [], configPatch: ctx.config };
            }

            const argsInput = await prompter.text({
              message: "Enter agent arguments (space-separated, or leave empty):",
              initialValue: process.env.ACP_ARGS || "--experimental-acp",
            });

            const args = typeof argsInput === "string" ? argsInput.trim() : "";

            // Save the ACP configuration via env-style hints in the config
            const cfg = { ...ctx.config };
            const agents = { ...cfg.agents };
            const defaults = { ...agents.defaults };
            const models = { ...defaults.models };

            models["acp/default"] = {
              ...models["acp/default"],
              alias: models["acp/default"]?.alias ?? `ACP (${command})`,
              params: {
                ...(models["acp/default"] as { params?: Record<string, unknown> })?.params,
                acpCommand: command,
                ...(args ? { acpArgs: args } : {}),
              },
            };

            defaults.models = models;
            agents.defaults = defaults;
            cfg.agents = agents;

            return {
              profiles: [
                {
                  profileId: "acp:default",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: ACP_DEFAULT_API_KEY,
                  },
                },
              ],
              configPatch: cfg,
            };
          },
        },
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const acpKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          const envCommand = process.env.ACP_COMMAND?.trim();

          // Activate when either an API key (auth profile) is set or the
          // ACP_COMMAND env var is configured.
          if (!acpKey && !envCommand) {
            return null;
          }

          return {
            provider: {
              ...buildAcpProvider(),
              apiKey: acpKey ?? ACP_DEFAULT_API_KEY,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => buildDynamicAcpModel(ctx),
      capabilities: {
        openAiCompatTurnValidation: false,
      },
      wrapStreamFn: (ctx) => {
        const acpConfig = resolveAcpAgentConfig(ctx.extraParams);
        return createAcpStreamFn(ctx.streamFn, acpConfig);
      },
      isModernModelRef: () => true,
      wizard: {
        setup: {
          choiceId: "acp-agent",
          choiceLabel: "ACP Agent",
          choiceHint: "Agent Client Protocol — use Gemini CLI, Claude Code, or Codex as a provider",
          groupId: "acp",
          groupLabel: "ACP",
          groupHint: "Agent Client Protocol",
          methodId: "custom",
        },
      },
    });
  },
});
