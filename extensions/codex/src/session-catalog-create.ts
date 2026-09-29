import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

const CODEX_AGENT_RUNTIME_ID = "codex";
const CODEX_CATALOG_DEFAULT_MODEL_REF = "openai/gpt-6-astra";

export function resolveCodexCatalogCreateSession(
  modelConfig: Pick<
    PluginRuntime["modelConfig"],
    "resolveAllowedModelRef" | "resolveDefaultModelForAgent"
  >,
  config: OpenClawConfig | undefined,
  requestedAgentId?: string,
): { model: string; agentRuntime: string } | undefined {
  if (!config) {
    return undefined;
  }
  const agentId = requestedAgentId ?? resolveDefaultAgentId(config);
  const defaultModel = modelConfig.resolveDefaultModelForAgent({ cfg: config, agentId });
  const modelRef =
    defaultModel.provider === "openai"
      ? `${defaultModel.provider}/${defaultModel.model}`
      : CODEX_CATALOG_DEFAULT_MODEL_REF;
  const allowed = modelConfig.resolveAllowedModelRef({
    cfg: config,
    catalog: [],
    raw: modelRef,
    defaultProvider: defaultModel.provider,
    defaultModel: defaultModel.model,
    agentId,
  });
  return "error" in allowed
    ? undefined
    : { model: allowed.key, agentRuntime: CODEX_AGENT_RUNTIME_ID };
}
