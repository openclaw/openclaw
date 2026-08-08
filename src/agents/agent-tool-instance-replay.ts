import { getPluginToolMeta } from "../plugins/tools.js";
import { getChannelAgentToolMeta } from "./channel-tool-metadata.js";

type AgentToolInstanceReplayPolicy = {
  declaredReplaySafe: boolean | undefined;
  externallyOwned: boolean;
  restartDeclaredReplaySafe: boolean | undefined;
};

/** Resolve replay declarations from the concrete plugin, channel, or core tool owner. */
export function resolveAgentToolInstanceReplayPolicy(tool: {
  name?: string;
}): AgentToolInstanceReplayPolicy {
  const pluginMeta = getPluginToolMeta(tool as Parameters<typeof getPluginToolMeta>[0]);
  if (pluginMeta) {
    return {
      declaredReplaySafe: pluginMeta.replaySafe === true,
      externallyOwned: true,
      restartDeclaredReplaySafe: pluginMeta.mcp ? false : pluginMeta.replaySafe === true,
    };
  }
  if (getChannelAgentToolMeta(tool as never)) {
    return {
      declaredReplaySafe: false,
      externallyOwned: true,
      restartDeclaredReplaySafe: false,
    };
  }
  return {
    declaredReplaySafe: undefined,
    externallyOwned: false,
    restartDeclaredReplaySafe: undefined,
  };
}

export const agentToolReplaySafetyOptions = {
  declaredReplaySafe: (tool: { name?: string }) =>
    resolveAgentToolInstanceReplayPolicy(tool).declaredReplaySafe,
};

export const agentToolRestartSafetyOptions = {
  declaredReplaySafe: (tool: { name?: string }) =>
    resolveAgentToolInstanceReplayPolicy(tool).restartDeclaredReplaySafe,
};
