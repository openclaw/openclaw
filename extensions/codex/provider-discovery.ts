/** Native login facts belong to Codex, never to an OpenClaw bearer profile. */
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const loadNativeAuth = createLazyRuntimeModule(() => import("./src/app-server/native-auth.js"));

const codexProviderDiscovery: ProviderPlugin = {
  id: "codex",
  label: "Codex",
  auth: [],
  prepareSyntheticAuth: async ({ config, provider, env, signal, pluginRoot }) => {
    if (provider !== "codex") {
      return undefined;
    }
    const { probeCodexNativeAuth } = await loadNativeAuth();
    return await probeCodexNativeAuth({ config, env, signal, pluginRoot });
  },
};

export default codexProviderDiscovery;
