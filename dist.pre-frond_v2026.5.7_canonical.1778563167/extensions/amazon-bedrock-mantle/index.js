import { t as definePluginEntry } from "../../plugin-entry-DeObqXcQ.js";
import { t as registerBedrockMantlePlugin } from "../../register.sync.runtime-BZUTXoXg.js";
//#region extensions/amazon-bedrock-mantle/index.ts
var amazon_bedrock_mantle_default = definePluginEntry({
	id: "amazon-bedrock-mantle",
	name: "Amazon Bedrock Mantle Provider",
	description: "Bundled Amazon Bedrock Mantle (OpenAI-compatible) provider plugin",
	register(api) {
		registerBedrockMantlePlugin(api);
	}
});
//#endregion
export { amazon_bedrock_mantle_default as default };
