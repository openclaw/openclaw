import { T as isAllowedBlueBubblesSender } from "../../probe-CSbKOI0M.js";
import { a as bluebubblesCapabilities, c as bluebubblesMeta, i as blueBubblesSetupAdapter, l as bluebubblesReload, n as collectBlueBubblesStatusIssues, o as bluebubblesConfigAdapter, r as blueBubblesSetupWizard, s as bluebubblesConfigSchema, t as bluebubblesPlugin, u as describeBlueBubblesAccount } from "../../channel-BHOlqyIG.js";
import { n as createBlueBubblesConversationBindingManager, t as __testing } from "../../conversation-bindings-BbutvPNF.js";
import { i as resolveBlueBubblesInboundConversationId, n as normalizeBlueBubblesAcpConversationId, r as resolveBlueBubblesConversationIdFromTarget, t as matchBlueBubblesAcpConversation } from "../../conversation-id-CJGv1rv7.js";
import { n as resolveBlueBubblesGroupToolPolicy, t as resolveBlueBubblesGroupRequireMention } from "../../group-policy-ChfWx4jf.js";
//#region extensions/bluebubbles/src/channel.setup.ts
const bluebubblesSetupPlugin = {
	id: "bluebubbles",
	meta: {
		...bluebubblesMeta,
		aliases: [...bluebubblesMeta.aliases],
		preferOver: [...bluebubblesMeta.preferOver]
	},
	capabilities: bluebubblesCapabilities,
	reload: bluebubblesReload,
	configSchema: bluebubblesConfigSchema,
	setupWizard: blueBubblesSetupWizard,
	config: {
		...bluebubblesConfigAdapter,
		isConfigured: (account) => account.configured,
		describeAccount: (account) => describeBlueBubblesAccount(account)
	},
	setup: blueBubblesSetupAdapter
};
//#endregion
export { __testing, bluebubblesPlugin, bluebubblesSetupPlugin, collectBlueBubblesStatusIssues, createBlueBubblesConversationBindingManager, isAllowedBlueBubblesSender, matchBlueBubblesAcpConversation, normalizeBlueBubblesAcpConversationId, resolveBlueBubblesConversationIdFromTarget, resolveBlueBubblesGroupRequireMention, resolveBlueBubblesGroupToolPolicy, resolveBlueBubblesInboundConversationId };
