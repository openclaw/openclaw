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
async function listVoices(apiKey) {
	const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
	if (!res.ok) throw new Error(`ElevenLabs voices API error (${res.status})`);
	const json = await res.json();
	return Array.isArray(json.voices) ? json.voices : [];
}
function formatVoiceList(voices, limit) {
	const sliced = voices.slice(0, Math.max(1, Math.min(limit, 50)));
	const lines = [];
	lines.push(`Voices: ${voices.length}`);
	lines.push("");
	for (const v of sliced) {
		const name = (v.name ?? "").trim() || "(unnamed)";
		const category = (v.category ?? "").trim();
		const meta = category ? ` · ${category}` : "";
		lines.push(`- ${name}${meta}`);
		lines.push(`  id: ${v.voice_id}`);
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
	const lower = q.toLowerCase();
	const byId = voices.find((v) => v.voice_id === q);
	if (byId) return byId;
	const exactName = voices.find((v) => (v.name ?? "").trim().toLowerCase() === lower);
	if (exactName) return exactName;
	return voices.find((v) => (v.name ?? "").trim().toLowerCase().includes(lower)) ?? null;
}
function asTrimmedString(value) {
	return typeof value === "string" ? value.trim() : "";
}
function resolveCommandLabel(channel) {
	return channel === "discord" ? "/talkvoice" : "/voice";
}
function register(api) {
	api.registerCommand({
		name: "voice",
		nativeNames: { discord: "talkvoice" },
		description: "List/set ElevenLabs Talk voice (affects iOS Talk playback).",
		acceptsArgs: true,
		handler: async (ctx) => {
			const commandLabel = resolveCommandLabel(ctx.channel);
			const tokens = (ctx.args?.trim() ?? "").split(/\s+/).filter(Boolean);
			const action = (tokens[0] ?? "status").toLowerCase();
			const cfg = api.runtime.config.loadConfig();
			const apiKey = asTrimmedString(cfg.talk?.apiKey);
			if (!apiKey) return { text: "Talk voice is not configured.\n\nMissing: talk.apiKey (ElevenLabs API key).\nSet it on the gateway, then retry." };
			const currentVoiceId = (cfg.talk?.voiceId ?? "").trim();
			if (action === "status") return { text: `Talk voice status:
- talk.voiceId: ${currentVoiceId ? currentVoiceId : "(unset)"}\n- talk.apiKey: ${mask(apiKey)}` };
			if (action === "list") {
				const limit = Number.parseInt(tokens[1] ?? "12", 10);
				return { text: formatVoiceList(await listVoices(apiKey), Number.isFinite(limit) ? limit : 12) };
			}
			if (action === "set") {
				const query = tokens.slice(1).join(" ").trim();
				if (!query) return { text: `Usage: ${commandLabel} set <voiceId|name>` };
				const chosen = findVoice(await listVoices(apiKey), query);
				if (!chosen) return { text: `No voice found for ${isLikelyVoiceId(query) ? query : `"${query}"`}. Try: ${commandLabel} list` };
				const nextConfig = {
					...cfg,
					talk: {
						...cfg.talk,
						voiceId: chosen.voice_id
					}
				};
				await api.runtime.config.writeConfigFile(nextConfig);
				return { text: `✅ Talk voice set to ${(chosen.name ?? "").trim() || "(unnamed)"}\n${chosen.voice_id}` };
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
//#endregion
export { register as default };
