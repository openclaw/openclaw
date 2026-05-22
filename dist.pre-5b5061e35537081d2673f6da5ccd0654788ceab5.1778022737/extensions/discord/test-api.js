import { t as finalizeInboundContext } from "../../inbound-context-7ossg2z_.js";
import "../../reply-dispatch-runtime-CW8201uc.js";
import { t as discordPlugin } from "../../channel-OGwK2gNX.js";
import { n as discordOutbound } from "../../outbound-adapter-CICL31GL.js";
import { t as __testing } from "../../thread-bindings.manager-B21S8s21.js";
import { n as buildDiscordInboundAccessContext } from "../../inbound-context-_JZbHeZI.js";
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
		UntrustedContext: untrustedContext,
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
