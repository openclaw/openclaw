import { definePluginEntry } from "openclaw/plugin-sdk/core";
import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "openclaw/plugin-sdk/provider-web-search";

export default definePluginEntry({
  id: "parallel",
  name: "Parallel Plugin",
  description: "Bundled Parallel plugin",
  register(api) {
    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "parallel",
        label: "Parallel",
        hint: "LLM-optimized excerpts",
        envVars: ["PARALLEL_API_KEY"],
        placeholder: "par-...",
        signupUrl: "https://parallel.ai",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        autoDetectOrder: 45,
        getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "parallel"),
        setCredentialValue: (searchConfigTarget, value) =>
          setScopedCredentialValue(searchConfigTarget, "parallel", value),
      }),
    );
  },
});
