import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "../../string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "../../errors-b3ZrCRlt.js";
import { i as resolveActiveTalkProviderConfig } from "../../talk-C8XF4d_d.js";
import "../../error-runtime-DGHc7DZw.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import "../../talk-config-runtime-bTGEPF_X.js";
import "../../api-DIkBuDgj.js";
//#region extensions/talk-voice/index.ts
function mask(s, keep = 6) {
	const trimmed = s.trim();
	if (trimmed.length <= keep) return "***";
	return `${trimmed.slice(0, keep)}…`;
}
function isLikelyVoiceId(value) {
	const v = value.trim();
	if (v.length < 10 || v.length > 64) return false;
	return /^[a-zA-Z0-9_-]+$/.test(v);
}
function resolveProviderLabel(providerId) {
	switch (providerId) {
		case "openai": return "OpenAI";
		case "microsoft": return "Microsoft";
		case "elevenlabs": return "ElevenLabs";
		default: return providerId;
	}
}
function formatVoiceMeta(voice) {
	const parts = [voice.locale, voice.gender];
	const personalities = voice.personalities?.filter((value) => value.trim().length > 0) ?? [];
	if (personalities.length > 0) parts.push(personalities.join(", "));
	const filtered = parts.filter((part) => Boolean(part?.trim()));
	return filtered.length > 0 ? filtered.join(" · ") : void 0;
}
function formatVoiceList(voices, limit, providerId) {
	const sliced = voices.slice(0, Math.max(1, Math.min(limit, 50)));
	const lines = [];
	lines.push(`${resolveProviderLabel(providerId)} voices: ${voices.length}`);
	lines.push("");
	for (const v of sliced) {
		const name = (v.name ?? "").trim() || "(unnamed)";
		const category = (v.category ?? "").trim();
		const meta = category ? ` · ${category}` : "";
		lines.push(`- ${name}${meta}`);
		lines.push(`  id: ${v.id}`);
		const details = formatVoiceMeta(v);
		if (details) lines.push(`  meta: ${details}`);
		const description = (v.description ?? "").trim();
		if (description) lines.push(`  note: ${description}`);
	}
	if (voices.length > sliced.length) {
		lines.push("");
		lines.push(`(showing first ${sliced.length})`);
	}
	return lines.join("\n");
}
function findVoice(voices, query) {
	const q = query.trim();
	if (!q) return null;
	const lower = normalizeLowercaseStringOrEmpty(q);
	const byId = voices.find((v) => v.id === q);
	if (byId) return byId;
	const exactName = voices.find((v) => normalizeOptionalLowercaseString(v.name) === lower);
	if (exactName) return exactName;
	return voices.find((v) => normalizeLowercaseStringOrEmpty(v.name).includes(lower)) ?? null;
}
function asTrimmedString(value) {
	return typeof value === "string" ? value.trim() : "";
}
function resolveCommandLabel(channel) {
	return channel === "discord" ? "/talkvoice" : "/voice";
}
function asProviderBaseUrl(value) {
	return asTrimmedString(value) || void 0;
}
const TALK_ADMIN_SCOPE = "operator.admin";
function requiresAdminToSetVoice(channel, gatewayClientScopes) {
	if (Array.isArray(gatewayClientScopes)) return !gatewayClientScopes.includes(TALK_ADMIN_SCOPE);
	return channel === "webchat";
}
var talk_voice_default = definePluginEntry({
	id: "talk-voice",
	name: "Talk Voice",
	description: "Command helpers for managing Talk voice configuration",
	register(api) {
		api.registerCommand({
			name: "voice",
			nativeNames: { discord: "talkvoice" },
			description: "List/set Talk provider voices (affects iOS Talk playback).",
			acceptsArgs: true,
			handler: async (ctx) => {
				const commandLabel = resolveCommandLabel(ctx.channel);
				const tokens = (ctx.args?.trim() ?? "").split(/\s+/).filter(Boolean);
				const action = normalizeLowercaseStringOrEmpty(tokens[0] ?? "status");
				const cfg = api.runtime.config.current();
				const active = resolveActiveTalkProviderConfig(cfg.talk);
				if (!active) return { text: "Talk voice is not configured.\n\nMissing: talk.provider and talk.providers.<provider>.\nSet it on the gateway, then retry." };
				const providerId = active.provider;
				const providerLabel = resolveProviderLabel(providerId);
				const apiKey = asTrimmedString(active.config.apiKey);
				const baseUrl = asProviderBaseUrl(active.config.baseUrl);
				const currentVoiceId = asTrimmedString(active.config.voiceId);
				if (action === "status") return { text: `Talk voice status:
- provider: ${providerId}\n- talk.providers.${providerId}.voiceId: ${currentVoiceId ? currentVoiceId : "(unset)"}\n- ${providerId}.apiKey: ${apiKey ? mask(apiKey) : "(unset)"}` };
				if (action === "list") {
					const limit = Number.parseInt(tokens[1] ?? "12", 10);
					try {
						return { text: formatVoiceList(await api.runtime.tts.listVoices({
							provider: providerId,
							cfg,
							apiKey: apiKey || void 0,
							baseUrl
						}), Number.isFinite(limit) ? limit : 12, providerId) };
					} catch (error) {
						return { text: `${providerLabel} voice list failed: ${formatErrorMessage(error)}` };
					}
				}
				if (action === "set") {
					if (requiresAdminToSetVoice(ctx.channel, ctx.gatewayClientScopes)) return { text: `⚠️ ${commandLabel} set requires operator.admin.` };
					const query = tokens.slice(1).join(" ").trim();
					if (!query) return { text: `Usage: ${commandLabel} set <voiceId|name>` };
					let voices;
					try {
						voices = await api.runtime.tts.listVoices({
							provider: providerId,
							cfg,
							apiKey: apiKey || void 0,
							baseUrl
						});
					} catch (error) {
						return { text: `${providerLabel} voice lookup failed: ${formatErrorMessage(error)}` };
					}
					const chosen = findVoice(voices, query);
					if (!chosen) return { text: `No voice found for ${isLikelyVoiceId(query) ? query : `"${query}"`}. Try: ${commandLabel} list` };
					await api.runtime.config.mutateConfigFile({
						afterWrite: { mode: "auto" },
						mutate: (draft) => {
							const nextConfig = {
								...draft,
								talk: {
									...draft.talk,
									provider: providerId,
									providers: {
										...draft.talk?.providers,
										[providerId]: {
											...draft.talk?.providers?.[providerId],
											voiceId: chosen.id
										}
									},
									...providerId === "elevenlabs" ? { voiceId: chosen.id } : {}
								}
							};
							Object.assign(draft, nextConfig);
						}
					});
					return { text: `✅ ${providerLabel} Talk voice set to ${(chosen.name ?? "").trim() || "(unnamed)"}\n${chosen.id}` };
				}
				return { text: [
					"Voice commands:",
					"",
					`${commandLabel} status`,
					`${commandLabel} list [limit]`,
					`${commandLabel} set <voiceId|name>`
				].join("\n") };
			}
		});
	}
});
//#endregion
export { talk_voice_default as default };
