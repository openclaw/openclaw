import { t as definePluginEntry } from "../../plugin-entry-DeObqXcQ.js";
import { t as registerAmazonBedrockPlugin } from "../../register.sync.runtime-nBqfvCbX.js";
//#region extensions/amazon-bedrock/index.ts
var amazon_bedrock_default = definePluginEntry({
	id: "amazon-bedrock",
	name: "Amazon Bedrock Provider",
	description: "Bundled Amazon Bedrock provider policy plugin",
	register(api) {
		registerAmazonBedrockPlugin(api);
	}
});
//#endregion
export { amazon_bedrock_default as default };
