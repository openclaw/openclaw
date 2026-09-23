/** Native login facts belong to Codex, never to an OpenClaw bearer profile. */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const codexProviderDiscovery: ProviderPlugin = {
  id: "codex",
  label: "Codex",
  auth: [],
  prepareSyntheticAuth: async ({ config, provider, env, signal, pluginRoot }) => {
    if (provider !== "codex") {
      return undefined;
    }
    const { probeCodexNativeAuth } = await import("./src/app-server/native-auth.js");
    return await probeCodexNativeAuth({ config, env, signal, pluginRoot });
  },
};

export default codexProviderDiscovery;
