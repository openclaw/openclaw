import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "amazon-bedrock",
  name: "Amazon Bedrock Provider",
  description: "Bundled Amazon Bedrock provider policy plugin",
  async register(api) {
    const { registerAmazonBedrockPlugin } = await import("./register.runtime.js");
    await registerAmazonBedrockPlugin(api);
  },
});
