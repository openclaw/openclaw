import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const slackChannelConfigUiHints = {
	"": {
		label: "Slack",
		help: "Slack channel provider configuration for bot/app tokens, streaming behavior, and DM policy controls. Keep token handling and thread behavior explicit to avoid noisy workspace interactions.",
	},
	"dm.policy": {
		label: "Slack DM Policy",
		help: 'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"] (legacy: channels.slack.dm.allowFrom).',
	},
	dmPolicy: {
		label: "Slack DM Policy",
		help: 'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"].',
	},
	configWrites: {
		label: "Slack Config Writes",
		help: "Allow Slack to write config in response to channel events/commands (default: true).",
	},
	"commands.native": {
		label: "Slack Native Commands",
		help: 'Override native commands for Slack (bool or "auto").',
	},
	"commands.nativeSkills": {
		label: "Slack Native Skill Commands",
		help: 'Override native skill commands for Slack (bool or "auto").',
	},
	allowBots: {
		label: "Slack Allow Bot Messages",
		help: "Allow bot-authored messages to trigger Slack replies (default: false).",
	},
	botToken: {
		label: "Slack Bot Token",
		help: "Slack bot token used for standard chat actions in the configured workspace. Keep this credential scoped and rotate if workspace app permissions change.",
	},
	appToken: {
		label: "Slack App Token",
		help: "Slack app-level token used for Socket Mode connections and event transport when enabled. Use least-privilege app scopes and store this token as a secret.",
	},
	userToken: {
		label: "Slack User Token",
		help: "Optional Slack user token for workflows requiring user-context API access beyond bot permissions. Use sparingly and audit scopes because this token can carry broader authority.",
	},
	userTokenReadOnly: {
		label: "Slack User Token Read Only",
		help: "When true, treat configured Slack user token usage as read-only helper behavior where possible. Keep enabled if you only need supplemental reads without user-context writes.",
	},
	"capabilities.interactiveReplies": {
		label: "Slack Interactive Replies",
		help: "Enable agent-authored Slack interactive reply directives (`[[slack_buttons: ...]]`, `[[slack_select: ...]]`). Default: false.",
	},
	streaming: {
		label: "Slack Streaming Mode",
		help: 'Unified Slack stream preview mode: "off" | "partial" | "block" | "progress". Legacy boolean/streamMode keys are auto-mapped.',
	},
	nativeStreaming: {
		label: "Slack Native Streaming",
		help: "Enable native Slack text streaming (chat.startStream/chat.appendStream/chat.stopStream) when channels.slack.streaming is partial (default: true).",
	},
	streamMode: {
		label: "Slack Stream Mode (Legacy)",
		help: "Legacy Slack preview mode alias (replace | status_final | append); auto-migrated to channels.slack.streaming.",
	},
	"thread.historyScope": {
		label: "Slack Thread History Scope",
		help: 'Scope for Slack thread history context ("thread" isolates per thread; "channel" reuses channel history).',
	},
	"thread.inheritParent": {
		label: "Slack Thread Parent Inheritance",
		help: "If true, Slack thread sessions inherit the parent channel transcript (default: false).",
	},
	"thread.initialHistoryLimit": {
		label: "Slack Thread Initial History Limit",
		help: "Maximum number of existing Slack thread messages to fetch when starting a new thread session (default: 20, set to 0 to disable).",
	},
} satisfies Record<string, ChannelConfigUiHint>;
