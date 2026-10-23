// v2026.7.1 stored legacy-crypto status at key "current" in this account namespace.
export function julyLegacyCryptoStoreOptions(storageRootDir: string) {
  return {
    namespace: "legacy-crypto-migration",
    maxEntries: 10,
    env: { OPENCLAW_STATE_DIR: storageRootDir },
  };
}
