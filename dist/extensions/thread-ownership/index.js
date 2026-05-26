import { c as normalizeOptionalString } from "../../string-coerce-DyL154ka.js";
import { b as escapeRegExp } from "../../utils-sBTEdeml.js";
import { n as fetchWithSsrFGuard } from "../../fetch-guard-BEAbHb5H.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { n as resolveLivePluginConfigObject } from "../../plugin-config-runtime-DWa7yCpn.js";
import { u as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "../../ssrf-policy-CIwd6x-p.js";
import "../../text-utility-runtime-CaGXarh9.js";
import "../../api-BAwiNYK3.js";
//#region extensions/thread-ownership/index.ts
const mentionedThreads = /* @__PURE__ */ new Map();
const MENTION_TTL_MS = 300 * 1e3;
function isThreadOwnershipConfig(value) {
	return value !== null && typeof value === "object";
}
function resolveThreadToken(value) {
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function resolveSlackConversationId(value) {
	const raw = normalizeOptionalString(value) ?? "";
	if (!raw) return "";
	const trimmed = raw.trim();
	const resolved = /^(?:slack:)?channel:(.+)$/i.exec(trimmed)?.[1]?.trim() || trimmed;
	return /^[CDGUW][A-Z0-9]+$/i.test(resolved) ? resolved.toUpperCase() : resolved;
}
function cleanExpiredMentions() {
	const now = Date.now();
	for (const [key, ts] of mentionedThreads) if (now - ts > MENTION_TTL_MS) mentionedThreads.delete(key);
}
function containsAgentNameMention(text, agentName) {
	const trimmedName = agentName.trim();
	if (!trimmedName) return false;
	return new RegExp(`(^|[^\\w])@${escapeRegExp(trimmedName)}(?=$|[^\\w])`, "i").test(text);
}
function resolveOwnershipAgent(config) {
	const list = Array.isArray(config.agents?.list) ? config.agents.list.filter((entry) => entry !== null && typeof entry === "object") : [];
	const selected = list.find((entry) => entry.default === true) ?? list[0];
	const id = normalizeOptionalString(selected?.id) ?? "unknown";
	const identityName = normalizeOptionalString(selected?.identity?.name) ?? "";
	const fallbackName = normalizeOptionalString(selected?.name) ?? "";
	return {
		id,
		name: identityName || fallbackName
	};
}
var thread_ownership_default = definePluginEntry({
	id: "thread-ownership",
	name: "Thread Ownership",
	description: "Slack thread claim coordination for multi-agent setups",
	register(api) {
		const resolveCurrentState = () => {
			const currentConfig = api.runtime.config?.current?.() ?? api.config;
			const livePluginCfg = resolveLivePluginConfigObject(api.runtime.config?.current ? () => api.runtime.config.current() : void 0, "thread-ownership", isThreadOwnershipConfig(api.pluginConfig) ? api.pluginConfig : void 0);
			const pluginCfg = isThreadOwnershipConfig(livePluginCfg) ? livePluginCfg : {};
			return {
				currentConfig,
				forwarderUrl: (pluginCfg.forwarderUrl ?? process.env.SLACK_FORWARDER_URL ?? "http://slack-forwarder:8750").replace(/\/$/, ""),
				abTestChannels: new Set((pluginCfg.abTestChannels ?? process.env.THREAD_OWNERSHIP_CHANNELS?.split(",").filter(Boolean) ?? []).map((entry) => resolveSlackConversationId(entry)).filter(Boolean)),
				botUserId: process.env.SLACK_BOT_USER_ID ?? "",
				agent: resolveOwnershipAgent(currentConfig)
			};
		};
		api.on("message_received", async (event, ctx) => {
			if (ctx.channelId !== "slack") return;
			const { agent, botUserId } = resolveCurrentState();
			const text = event.content ?? "";
			const threadTs = resolveThreadToken(event.threadId) || resolveThreadToken(event.metadata?.threadId) || resolveThreadToken(event.metadata?.threadTs);
			const channelId = resolveSlackConversationId(ctx.conversationId) || resolveSlackConversationId(event.metadata?.channelId) || "";
			if (!threadTs || !channelId) return;
			if (containsAgentNameMention(text, agent.name) || botUserId && text.includes(`<@${botUserId}>`)) {
				cleanExpiredMentions();
				mentionedThreads.set(`${channelId}:${threadTs}`, Date.now());
			}
		});
		api.on("message_sending", async (event, ctx) => {
			if (ctx.channelId !== "slack") return;
			const { abTestChannels, agent, forwarderUrl } = resolveCurrentState();
			const threadTs = resolveThreadToken(event.replyToId) || resolveThreadToken(event.threadId) || resolveThreadToken(event.metadata?.threadId) || resolveThreadToken(event.metadata?.threadTs);
			const channelId = resolveSlackConversationId(ctx.conversationId) || resolveSlackConversationId(event.metadata?.channelId) || resolveSlackConversationId(event.to) || "";
			if (!threadTs || !channelId) return;
			if (abTestChannels.size > 0 && !abTestChannels.has(channelId)) return;
			cleanExpiredMentions();
			if (mentionedThreads.has(`${channelId}:${threadTs}`)) return;
			try {
				const { response: resp, release } = await fetchWithSsrFGuard({
					url: `${forwarderUrl}/api/v1/ownership/${channelId}/${threadTs}`,
					init: {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ agent_id: agent.id })
					},
					timeoutMs: 3e3,
					policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
					auditContext: "thread-ownership"
				});
				try {
					if (resp.ok) return;
					if (resp.status === 409) {
						const body = await resp.json();
						api.logger.info?.(`thread-ownership: cancelled send to ${channelId}:${threadTs} — owned by ${body.owner}`);
						return { cancel: true };
					}
					api.logger.warn?.(`thread-ownership: unexpected status ${resp.status}, allowing send`);
				} finally {
					await release();
				}
			} catch (err) {
				api.logger.warn?.(`thread-ownership: ownership check failed (${String(err)}), allowing send`);
			}
		});
	}
});
//#endregion
export { thread_ownership_default as default };
