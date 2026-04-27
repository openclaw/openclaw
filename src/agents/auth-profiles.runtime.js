import { ensureAuthProfileStore as ensureAuthProfileStoreImpl } from "./auth-profiles/store.js";
export function ensureAuthProfileStore(...args) {
    return ensureAuthProfileStoreImpl(...args);
}
