import { t as finalizeInboundContext } from "../../inbound-context-DMWZCRo0.js";
import "../../reply-dispatch-runtime-8sovS7U_.js";
import { t as discordPlugin } from "../../channel-Dl7rBSDu.js";
import { n as discordOutbound } from "../../outbound-adapter-CvFv-xYr.js";
import { t as __testing } from "../../thread-bindings.manager-BqTf0tRR.js";
import { n as buildDiscordInboundAccessContext } from "../../inbound-context-BJSLrsiW.js";
//#region extensions/discord/src/monitor/inbound-context.test-helpers.ts
function buildFinalizedDiscordDirectInboundContext() {
	const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
		channelConfig: null,
		guildInfo: null,
		sender: {
			id: "U1",
			name: "Alice",
			tag: "alice"
		},
		isGuild: false
	});
	return finalizeInboundContext({
		Body: "hi",
		BodyForAgent: "hi",
		RawBody: "hi",
		CommandBody: "hi",
		From: "discord:U1",
		To: "user:U1",
		SessionKey: "agent:main:discord:direct:u1",
		AccountId: "default",
		ChatType: "direct",
		ConversationLabel: "Alice",
		SenderName: "Alice",
		SenderId: "U1",
		SenderUsername: "alice",
		GroupSystemPrompt: groupSystemPrompt,
		OwnerAllowFrom: ownerAllowFrom,
		UntrustedStructuredContext: untrustedContext,
		Provider: "discord",
		Surface: "discord",
		WasMentioned: false,
		MessageSid: "m1",
		CommandAuthorized: true,
		OriginatingChannel: "discord",
		OriginatingTo: "user:U1"
	});
}
//#endregion
export { buildFinalizedDiscordDirectInboundContext, discordOutbound, discordPlugin, __testing as discordThreadBindingTesting };
