import { t as buildSlackInteractiveBlocks } from "./blocks-render-KRq-hLT2.js";
import { n as parseSlackBlocksInput } from "./blocks-input-BkCFIqct.js";
//#region extensions/slack/src/reply-blocks.ts
function resolveSlackReplyBlocks(payload) {
	const slackData = payload.channelData?.slack;
	const interactiveBlocks = buildSlackInteractiveBlocks(payload.interactive);
	let channelBlocks = [];
	if (slackData && typeof slackData === "object" && !Array.isArray(slackData)) channelBlocks = parseSlackBlocksInput(slackData.blocks) ?? [];
	const blocks = [...channelBlocks, ...interactiveBlocks];
	if (blocks.length > 50) throw new Error(`Slack blocks cannot exceed 50 items after interactive render`);
	return blocks.length > 0 ? blocks : void 0;
}
//#endregion
export { resolveSlackReplyBlocks as t };
