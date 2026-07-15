import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setAgentMailRuntime, getRuntime: getAgentMailRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "agentmail",
    errorMessage: "AgentMail runtime not initialized - plugin not registered",
  });

export { getAgentMailRuntime, setAgentMailRuntime };
