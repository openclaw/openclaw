import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { probeMuseNativeAuth } from "./src/native-auth.js";

const museProviderDiscovery: ProviderPlugin = {
  id: "muse",
  label: "Muse Code",
  auth: [],
  prepareSyntheticAuth: async ({ provider, env, signal }) => {
    if (provider !== "muse") {
      return undefined;
    }
    return await probeMuseNativeAuth({ env, signal });
  },
};

export default museProviderDiscovery;
