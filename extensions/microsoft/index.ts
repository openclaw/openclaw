import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildMicrosoftSpeechProvider } from "openclaw/plugin-sdk/speech";

const microsoftPlugin = {
  id: "microsoft",
  name: "Microsoft Speech",
  description: "Bundled Microsoft speech provider",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerSpeechProvider(buildMicrosoftSpeechProvider());
  },
};

export default microsoftPlugin;
