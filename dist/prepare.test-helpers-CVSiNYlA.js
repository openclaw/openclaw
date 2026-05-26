import "./temp-path-C0pVd7ka.js";
import { s as createSlackMonitorContext } from "./room-context-DrGzGSyg.js";
import "node:fs";
import "node:path";
//#region extensions/slack/src/monitor/message-handler/prepare.test-helpers.ts
function createInboundSlackTestContext(params) {
	return createSlackMonitorContext({
		cfg: params.cfg,
		accountId: "default",
		botToken: "token",
		app: { client: params.appClient ?? {} },
		runtime: {},
		botUserId: "B1",
		botId: "B1",
		teamId: "T1",
		apiAppId: "A1",
		historyLimit: 0,
		dmHistoryLimit: params.dmHistoryLimit,
		sessionScope: "per-sender",
		mainKey: "main",
		dmEnabled: true,
		dmPolicy: "open",
		allowFrom: ["*"],
		allowNameMatching: false,
		groupDmEnabled: true,
		groupDmChannels: [],
		defaultRequireMention: params.defaultRequireMention ?? true,
		channelsConfig: params.channelsConfig,
		groupPolicy: "open",
		useAccessGroups: false,
		reactionMode: "off",
		reactionAllowlist: [],
		replyToMode: params.replyToMode ?? "off",
		threadHistoryScope: "thread",
		threadInheritParent: false,
		threadRequireExplicitMention: params.threadRequireExplicitMention ?? false,
		slashCommand: {
			enabled: false,
			name: "openclaw",
			sessionPrefix: "slack:slash",
			ephemeral: true
		},
		textLimit: 4e3,
		ackReactionScope: "group-mentions",
		typingReaction: "",
		mediaMaxBytes: 1024,
		removeAckAfterReply: false
	});
}
//#endregion
export { createInboundSlackTestContext as t };
