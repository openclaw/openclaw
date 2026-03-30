import { ensureAuthProfileStore as ensureAuthProfileStoreImpl } from "./auth-profiles/store.js";

type EnsureAuthProfileStore =
	typeof import("./auth-profiles/store.js").ensureAuthProfileStore;

export function ensureAuthProfileStore(
	...args: Parameters<EnsureAuthProfileStore>
): ReturnType<EnsureAuthProfileStore> {
	return ensureAuthProfileStoreImpl(...args);
}
