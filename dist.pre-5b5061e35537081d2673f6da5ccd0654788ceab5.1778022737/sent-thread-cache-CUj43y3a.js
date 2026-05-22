import { n as resolveGlobalDedupeCache } from "./dedupe-sHm32Eje.js";
import { t as getOptionalSlackRuntime } from "./runtime-C_wnv0x8.js";
//#region extensions/slack/src/sent-thread-cache.ts
/**
* In-memory cache of Slack threads the bot has participated in.
* Used to auto-respond in threads without requiring @mention after the first reply.
* Follows a similar TTL pattern to the MS Teams and Telegram sent-message caches.
*/
const TTL_MS = 1440 * 60 * 1e3;
const MAX_ENTRIES = 5e3;
const PERSISTENT_MAX_ENTRIES = 1e3;
const PERSISTENT_NAMESPACE = "slack.thread-participation";
const threadParticipation = resolveGlobalDedupeCache(Symbol.for("openclaw.slackThreadParticipation"), {
	ttlMs: TTL_MS,
	maxSize: MAX_ENTRIES
});
let persistentStore;
let persistentStoreDisabled = false;
function makeKey(accountId, channelId, threadTs) {
	return `${accountId}:${channelId}:${threadTs}`;
}
function reportPersistentThreadParticipationError(error) {
	try {
		getOptionalSlackRuntime()?.logging.getChildLogger({
			plugin: "slack",
			feature: "thread-participation-state"
		}).warn("Slack persistent thread participation state failed", { error: String(error) });
	} catch {}
}
function disablePersistentThreadParticipation(error) {
	persistentStoreDisabled = true;
	persistentStore = void 0;
	reportPersistentThreadParticipationError(error);
}
function getPersistentThreadParticipationStore() {
	if (persistentStoreDisabled) return;
	if (persistentStore) return persistentStore;
	const runtime = getOptionalSlackRuntime();
	if (!runtime) return;
	try {
		persistentStore = runtime.state.openKeyedStore({
			namespace: PERSISTENT_NAMESPACE,
			maxEntries: PERSISTENT_MAX_ENTRIES,
			defaultTtlMs: TTL_MS
		});
		return persistentStore;
	} catch (error) {
		disablePersistentThreadParticipation(error);
		return;
	}
}
function rememberPersistentThreadParticipation(params) {
	const store = getPersistentThreadParticipationStore();
	if (!store) return;
	store.register(params.key, {
		...params.agentId ? { agentId: params.agentId } : {},
		repliedAt: Date.now()
	}).catch(disablePersistentThreadParticipation);
}
async function lookupPersistentThreadParticipation(key) {
	const store = getPersistentThreadParticipationStore();
	if (!store) return false;
	try {
		return Boolean(await store.lookup(key));
	} catch (error) {
		disablePersistentThreadParticipation(error);
		return false;
	}
}
function recordSlackThreadParticipation(accountId, channelId, threadTs, opts) {
	if (!accountId || !channelId || !threadTs) return;
	const key = makeKey(accountId, channelId, threadTs);
	threadParticipation.check(key);
	rememberPersistentThreadParticipation({
		key,
		agentId: opts?.agentId
	});
}
function hasSlackThreadParticipation(accountId, channelId, threadTs) {
	if (!accountId || !channelId || !threadTs) return false;
	return threadParticipation.peek(makeKey(accountId, channelId, threadTs));
}
async function hasSlackThreadParticipationWithPersistence(params) {
	if (!params.accountId || !params.channelId || !params.threadTs) return false;
	const key = makeKey(params.accountId, params.channelId, params.threadTs);
	if (threadParticipation.peek(key)) return true;
	const found = await lookupPersistentThreadParticipation(key);
	if (found) threadParticipation.check(key);
	return found;
}
function clearSlackThreadParticipationCache() {
	threadParticipation.clear();
	persistentStore = void 0;
	persistentStoreDisabled = false;
}
//#endregion
export { recordSlackThreadParticipation as i, hasSlackThreadParticipation as n, hasSlackThreadParticipationWithPersistence as r, clearSlackThreadParticipationCache as t };
