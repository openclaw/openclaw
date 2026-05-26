import { l as loadAuthProfileStoreWithoutExternalProfiles, p as updateAuthProfileStoreWithLock } from "./store-BMQkMM4l.js";
import "./provider-auth-BtRKd5us.js";
import "./agent-runtime-Lc7H-PlR.js";
import { o as parseEnv, u as readText } from "./helpers-B_eVYvP7.js";
import { c as HERMES_REASON_SECRET_NO_LONGER_PRESENT, d as hermesItemConflict, f as hermesItemError, h as readHermesSecretDetails, n as HERMES_REASON_AUTH_PROFILE_EXISTS, p as hermesItemSkipped, r as HERMES_REASON_AUTH_PROFILE_WRITE_FAILED, s as HERMES_REASON_MISSING_SECRET_METADATA, u as createHermesSecretItem } from "./items-CPsScumM.js";
//#region extensions/migrate-hermes/secrets.ts
const SECRET_MAPPINGS = [
	{
		envVar: "OPENAI_API_KEY",
		provider: "openai",
		profileId: "openai:hermes-import"
	},
	{
		envVar: "ANTHROPIC_API_KEY",
		provider: "anthropic",
		profileId: "anthropic:hermes-import"
	},
	{
		envVar: "OPENROUTER_API_KEY",
		provider: "openrouter",
		profileId: "openrouter:hermes-import"
	},
	{
		envVar: "GOOGLE_API_KEY",
		provider: "google",
		profileId: "google:hermes-import"
	},
	{
		envVar: "GEMINI_API_KEY",
		provider: "google",
		profileId: "google:hermes-import"
	},
	{
		envVar: "GROQ_API_KEY",
		provider: "groq",
		profileId: "groq:hermes-import"
	},
	{
		envVar: "XAI_API_KEY",
		provider: "xai",
		profileId: "xai:hermes-import"
	},
	{
		envVar: "MISTRAL_API_KEY",
		provider: "mistral",
		profileId: "mistral:hermes-import"
	},
	{
		envVar: "DEEPSEEK_API_KEY",
		provider: "deepseek",
		profileId: "deepseek:hermes-import"
	}
];
async function buildSecretItems(params) {
	const env = parseEnv(await readText(params.source.envPath));
	const store = loadAuthProfileStoreWithoutExternalProfiles(params.targets.agentDir);
	const seenProfiles = /* @__PURE__ */ new Set();
	const items = [];
	for (const mapping of SECRET_MAPPINGS) {
		if (!env[mapping.envVar]?.trim() || seenProfiles.has(mapping.profileId)) continue;
		seenProfiles.add(mapping.profileId);
		const existsAlready = Boolean(store.profiles[mapping.profileId]);
		items.push(createHermesSecretItem({
			id: `secret:${mapping.provider}`,
			source: params.source.envPath,
			target: `${params.targets.agentDir}/auth-profiles.json#${mapping.profileId}`,
			includeSecrets: params.ctx.includeSecrets,
			existsAlready: existsAlready && !params.ctx.overwrite,
			details: {
				envVar: mapping.envVar,
				provider: mapping.provider,
				profileId: mapping.profileId
			}
		}));
	}
	return items;
}
async function applySecretItem(ctx, item, targets) {
	if (item.status !== "planned") return item;
	const details = readHermesSecretDetails(item);
	const source = item.source;
	if (!details || !source) return hermesItemError(item, HERMES_REASON_MISSING_SECRET_METADATA);
	const key = parseEnv(await readText(source))[details.envVar]?.trim();
	if (!key) return hermesItemSkipped(item, HERMES_REASON_SECRET_NO_LONGER_PRESENT);
	let conflicted = false;
	let wrote = false;
	const store = await updateAuthProfileStoreWithLock({
		agentDir: targets.agentDir,
		updater: (freshStore) => {
			if (!ctx.overwrite && freshStore.profiles[details.profileId]) {
				conflicted = true;
				return false;
			}
			freshStore.profiles[details.profileId] = {
				type: "api_key",
				provider: details.provider,
				key,
				displayName: "Hermes import"
			};
			wrote = true;
			return true;
		}
	});
	if (conflicted) return hermesItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
	if (!store?.profiles[details.profileId]) return hermesItemError(item, HERMES_REASON_AUTH_PROFILE_WRITE_FAILED);
	if (!wrote && !ctx.overwrite) return hermesItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
	return {
		...item,
		status: "migrated"
	};
}
//#endregion
export { buildSecretItems as n, applySecretItem as t };
