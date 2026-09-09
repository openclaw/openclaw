/** Native login facts belong to Codex, never to an OpenClaw bearer profile. */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { probeCodexNativeAuth } from "./src/app-server/native-auth.js";

const codexProviderDiscovery: ProviderPlugin = {
  id: "codex",
  label: "Codex",
  auth: [],
  prepareSyntheticAuth: ({ config, provider, env, signal, pluginRoot }) =>
    provider === "codex"
      ? probeCodexNativeAuth({ config, env, signal, pluginRoot })
      : Promise.resolve(undefined),
};

export default codexProviderDiscovery;
