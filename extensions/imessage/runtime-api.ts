import type { OpenClawConfig as RuntimeApiOpenClawConfig } from "openclaw/plugin-sdk/core";

export {
	formatTrimmedAllowFromEntries,
	resolveIMessageConfigAllowFrom,
	resolveIMessageConfigDefaultTo,
} from "openclaw/plugin-sdk/channel-config-helpers";
export { IMessageConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
export { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
export {
	buildChannelConfigSchema,
	type ChannelPlugin,
	DEFAULT_ACCOUNT_ID,
	getChatChannelMeta,
	type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
export { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
export {
	buildComputedAccountStatusSnapshot,
	collectStatusIssuesFromLastError,
} from "openclaw/plugin-sdk/status-helpers";
export {
	resolveIMessageGroupRequireMention,
	resolveIMessageGroupToolPolicy,
} from "./src/group-policy.js";
export type { MonitorIMessageOpts } from "./src/monitor.js";

export { monitorIMessageProvider } from "./src/monitor.js";
export {
	looksLikeIMessageTargetId,
	normalizeIMessageMessagingTarget,
} from "./src/normalize.js";
export type { IMessageProbe } from "./src/probe.js";
export { probeIMessage } from "./src/probe.js";
export { sendMessageIMessage } from "./src/send.js";

export type IMessageAccountConfig = Omit<
	NonNullable<NonNullable<RuntimeApiOpenClawConfig["channels"]>["imessage"]>,
	"accounts" | "defaultAccount"
>;

export function chunkTextForOutbound(text: string, limit: number): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > limit) {
		const window = remaining.slice(0, limit);
		const splitAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
		const breakAt = splitAt > 0 ? splitAt : limit;
		chunks.push(remaining.slice(0, breakAt).trimEnd());
		remaining = remaining.slice(breakAt).trimStart();
	}
	if (remaining.length > 0 || text.length === 0) {
		chunks.push(remaining);
	}
	return chunks;
}
