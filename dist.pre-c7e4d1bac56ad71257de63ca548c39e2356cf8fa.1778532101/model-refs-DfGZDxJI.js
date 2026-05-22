import { c as isRecord } from "./utils-D5swhEXt.js";
//#region src/config/model-refs.ts
const AGENT_MODEL_CONFIG_KEYS = [
	"model",
	"imageModel",
	"imageGenerationModel",
	"videoGenerationModel",
	"musicGenerationModel",
	"pdfModel"
];
function collectConfiguredModelRefs(config, options = {}) {
	const refs = [];
	const pushModelRef = (path, value) => {
		if (typeof value === "string" && value.trim()) refs.push({
			path,
			value: value.trim()
		});
	};
	const collectModelConfig = (path, value) => {
		if (typeof value === "string") {
			pushModelRef(path, value);
			return;
		}
		if (!isRecord(value)) return;
		pushModelRef(`${path}.primary`, value.primary);
		if (Array.isArray(value.fallbacks)) for (const [index, entry] of value.fallbacks.entries()) pushModelRef(`${path}.fallbacks.${index}`, entry);
	};
	const collectFromAgent = (path, agent) => {
		if (!isRecord(agent)) return;
		for (const key of AGENT_MODEL_CONFIG_KEYS) collectModelConfig(`${path}.${key}`, agent[key]);
		if (isRecord(agent.models)) for (const modelRef of Object.keys(agent.models)) pushModelRef(`${path}.models.${modelRef}`, modelRef);
	};
	const root = isRecord(config) ? config : {};
	const agents = isRecord(root.agents) ? root.agents : {};
	collectFromAgent("agents.defaults", agents.defaults);
	if (Array.isArray(agents.list)) for (const [index, entry] of agents.list.entries()) collectFromAgent(`agents.list.${index}`, entry);
	if (options.includeChannelModelOverrides !== false) {
		const channels = isRecord(root.channels) ? root.channels : {};
		const modelByChannel = isRecord(channels.modelByChannel) ? channels.modelByChannel : {};
		for (const [channelId, channelMap] of Object.entries(modelByChannel)) {
			if (!isRecord(channelMap)) continue;
			for (const [targetId, modelRef] of Object.entries(channelMap)) pushModelRef(`channels.modelByChannel.${channelId}.${targetId}`, modelRef);
		}
	}
	return refs;
}
//#endregion
export { collectConfiguredModelRefs as n, AGENT_MODEL_CONFIG_KEYS as t };
