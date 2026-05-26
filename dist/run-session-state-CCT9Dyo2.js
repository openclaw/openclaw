import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { i as isCronSessionKey } from "./session-key-utils-qD-NZHCY.js";
import fs from "node:fs";
//#region src/cron/isolated-agent/channel-output-policy.ts
const channelPluginRuntimeLoader = createLazyImportLoader(() => import("./plugins-DJit8KgP.js"));
async function loadChannelPluginRuntime() {
	return await channelPluginRuntimeLoader.load();
}
async function resolveCronChannelOutputPolicy(channel) {
	const channelId = normalizeOptionalLowercaseString(channel);
	if (!channelId) return { preferFinalAssistantVisibleText: false };
	const { getChannelPlugin } = await loadChannelPluginRuntime();
	return { preferFinalAssistantVisibleText: getChannelPlugin(channelId)?.outbound?.preferFinalAssistantVisibleText === true };
}
async function resolveCurrentChannelTarget(params) {
	if (!params.to) return;
	const channelId = normalizeOptionalLowercaseString(params.channel);
	if (!channelId) return params.to;
	const { getChannelPlugin } = await loadChannelPluginRuntime();
	return getChannelPlugin(channelId)?.threading?.resolveCurrentChannelId?.({
		to: params.to,
		threadId: params.threadId
	}) ?? params.to;
}
//#endregion
//#region src/cron/isolated-agent/run-session-state.ts
function cronTranscriptExists(entry) {
	const sessionFile = entry.sessionFile?.trim();
	return Boolean(sessionFile && fs.existsSync(sessionFile));
}
function toNonResumableCronSessionEntry(entry) {
	const next = { ...entry };
	delete next.sessionId;
	delete next.sessionFile;
	delete next.sessionStartedAt;
	delete next.lastInteractionAt;
	delete next.cliSessionIds;
	delete next.cliSessionBindings;
	delete next.claudeCliSessionId;
	return next;
}
function createPersistCronSessionEntry(params) {
	return async () => {
		if (params.isFastTestEnv) return;
		const persistedEntry = isCronSessionKey(params.agentSessionKey) && params.cronSession.sessionEntry.sessionId && !cronTranscriptExists(params.cronSession.sessionEntry) ? toNonResumableCronSessionEntry(params.cronSession.sessionEntry) : params.cronSession.sessionEntry;
		params.cronSession.store[params.agentSessionKey] = persistedEntry;
		await params.updateSessionStore(params.cronSession.storePath, (store) => {
			store[params.agentSessionKey] = persistedEntry;
		});
	};
}
async function persistCronSkillsSnapshotIfChanged(params) {
	if (params.isFastTestEnv || params.skillsSnapshot === params.cronSession.sessionEntry.skillsSnapshot) return;
	params.cronSession.sessionEntry = {
		...params.cronSession.sessionEntry,
		updatedAt: params.nowMs,
		skillsSnapshot: params.skillsSnapshot
	};
	await params.persistSessionEntry();
}
function markCronSessionPreRun(params) {
	params.entry.modelProvider = params.provider;
	params.entry.model = params.model;
	params.entry.systemSent = true;
}
function syncCronSessionLiveSelection(params) {
	params.entry.modelProvider = params.liveSelection.provider;
	params.entry.model = params.liveSelection.model;
	if (params.liveSelection.authProfileId) {
		params.entry.authProfileOverride = params.liveSelection.authProfileId;
		params.entry.authProfileOverrideSource = params.liveSelection.authProfileIdSource;
		if (params.liveSelection.authProfileIdSource === "auto") params.entry.authProfileOverrideCompactionCount = params.entry.compactionCount ?? 0;
		else delete params.entry.authProfileOverrideCompactionCount;
		return;
	}
	delete params.entry.authProfileOverride;
	delete params.entry.authProfileOverrideSource;
	delete params.entry.authProfileOverrideCompactionCount;
}
//#endregion
export { resolveCronChannelOutputPolicy as a, syncCronSessionLiveSelection as i, markCronSessionPreRun as n, resolveCurrentChannelTarget as o, persistCronSkillsSnapshotIfChanged as r, createPersistCronSessionEntry as t };
