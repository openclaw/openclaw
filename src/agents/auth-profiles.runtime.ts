import { ensureAuthProfileStore as ensureAuthProfileStoreImpl } from "./auth-profiles.js";

type EnsureAuthProfileStore = typeof import("./auth-profiles.js").ensureAuthProfileStore;

export function ensureAuthProfileStore(
  ...args: Parameters<EnsureAuthProfileStore>
): ReturnType<EnsureAuthProfileStore> {
  return ensureAuthProfileStoreImpl(...args);
}
