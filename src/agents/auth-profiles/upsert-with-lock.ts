import { withFileLock } from "../../infra/file-lock.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_LOCK_OPTIONS, AUTH_STORE_VERSION } from "./constants.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "./paths.js";
import type {
	AuthProfileCredential,
	AuthProfileStore,
	ProfileUsageStats,
} from "./types.js";

function coerceAuthProfileStore(raw: unknown): AuthProfileStore {
	const record =
		raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const profiles =
		record.profiles &&
		typeof record.profiles === "object" &&
		!Array.isArray(record.profiles)
			? { ...(record.profiles as Record<string, AuthProfileCredential>) }
			: {};
	const order =
		record.order &&
		typeof record.order === "object" &&
		!Array.isArray(record.order)
			? (record.order as Record<string, string[]>)
			: undefined;
	const lastGood =
		record.lastGood &&
		typeof record.lastGood === "object" &&
		!Array.isArray(record.lastGood)
			? (record.lastGood as Record<string, string>)
			: undefined;
	const usageStats =
		record.usageStats &&
		typeof record.usageStats === "object" &&
		!Array.isArray(record.usageStats)
			? (record.usageStats as Record<string, ProfileUsageStats>)
			: undefined;

	return {
		version:
			typeof record.version === "number" && Number.isFinite(record.version)
				? record.version
				: AUTH_STORE_VERSION,
		profiles,
		...(order ? { order } : {}),
		...(lastGood ? { lastGood } : {}),
		...(usageStats ? { usageStats } : {}),
	};
}

export async function upsertAuthProfileWithLock(params: {
	profileId: string;
	credential: AuthProfileCredential;
	agentDir?: string;
}): Promise<AuthProfileStore | null> {
	const authPath = resolveAuthStorePath(params.agentDir);
	ensureAuthStoreFile(authPath);

	try {
		return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
			const store = coerceAuthProfileStore(loadJsonFile(authPath));
			store.profiles[params.profileId] = params.credential;
			saveJsonFile(authPath, store);
			return store;
		});
	} catch {
		return null;
	}
}
