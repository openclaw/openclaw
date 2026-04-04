import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { PROVIDER_ID, SYNTHETIC_API_KEY } from "./src/provider-models.js";
import { createLiteRtLmShimStreamFn } from "./src/stream.js";

export default definePluginEntry({
  id: "litertlm",
  name: "LiteRT-LM Local Provider",
  description:
    "Experimental local-model provider over LiteRT-LM and Edge Gallery-downloaded .litertlm files",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "LiteRT-LM Local",
      docsPath: "/providers/litertlm-local",
      auth: [],
      discovery: {
        order: "late",
        run: async () => null,
      },
      createStreamFn: ({ model }) => {
        return createLiteRtLmShimStreamFn({ model });
      },
      resolveSyntheticAuth: () => {
        return {
          apiKey: SYNTHETIC_API_KEY,
          source: "litertlm local synthetic auth",
          mode: "api-key",
        };
      },
      buildMissingAuthMessage: () =>
        "LiteRT-LM local provider does not use external API keys, but it does require a local Python runtime with litert_lm installed.",
      buildUnknownModelHint: () =>
        "Known experimental models are litertlm/gemma4-e2b-edge-gallery and optionally litertlm/gemma4-e4b-edge-gallery when available.",
    });
  },
});
