import { OAuthProviderRegistry } from "../../llm/utils/oauth/index.js";
import type { AuthStorage } from "./auth-storage.js";

// Values belong to one AuthStorage key. The weak attachment keeps ModelRegistry
// on the same registry without adding lifecycle methods to the public SDK class.
const registries = new WeakMap<AuthStorage, OAuthProviderRegistry>();

export function getAuthStorageOAuthProviderRegistry(
  authStorage: AuthStorage,
): OAuthProviderRegistry {
  let registry = registries.get(authStorage);
  if (!registry) {
    registry = new OAuthProviderRegistry();
    registries.set(authStorage, registry);
  }
  return registry;
}
