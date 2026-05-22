import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { t as registerBedrockMantlePlugin } from "../../register.sync.runtime-DbYjO49M.js";
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
