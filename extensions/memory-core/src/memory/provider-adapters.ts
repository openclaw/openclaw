// Memory Core provider module implements model/runtime integration.
import {
  DEFAULT_LOCAL_MODEL,
  listMemoryEmbeddingProviders,
<<<<<<< HEAD
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-embedding-registry";
import { getProviderEnvVars } from "openclaw/plugin-sdk/provider-env-vars";
=======
  listRegisteredMemoryEmbeddingProviderAdapters,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-embedding-registry";
import { getProviderEnvVars } from "openclaw/plugin-sdk/provider-env-vars";
import { filterUnregisteredMemoryEmbeddingProviderAdapters } from "./provider-adapter-registration.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

export type BuiltinMemoryEmbeddingProviderDoctorMetadata = {
  providerId: string;
  authProviderId: string;
  envVars: string[];
  transport: "local" | "remote";
  autoSelectPriority?: number;
};

<<<<<<< HEAD
=======
const builtinMemoryEmbeddingProviderAdapters = [] as const;

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export { DEFAULT_LOCAL_MODEL };

function getBuiltinMemoryEmbeddingProviderAdapter(
  id: string,
): MemoryEmbeddingProviderAdapter | undefined {
  return listMemoryEmbeddingProviders().find((adapter) => adapter.id === id);
}

<<<<<<< HEAD
=======
export function registerBuiltInMemoryEmbeddingProviders(register: {
  registerMemoryEmbeddingProvider: (adapter: MemoryEmbeddingProviderAdapter) => void;
}): void {
  // Only inspect providers already registered in the current load. Falling back
  // to capability discovery here can recursively trigger plugin loading while
  // memory-core itself is still registering.
  for (const adapter of filterUnregisteredMemoryEmbeddingProviderAdapters({
    builtinAdapters: builtinMemoryEmbeddingProviderAdapters,
    registeredAdapters: listRegisteredMemoryEmbeddingProviderAdapters(),
  })) {
    register.registerMemoryEmbeddingProvider(adapter);
  }
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function getBuiltinMemoryEmbeddingProviderDoctorMetadata(
  providerId: string,
): BuiltinMemoryEmbeddingProviderDoctorMetadata | null {
  const adapter = getBuiltinMemoryEmbeddingProviderAdapter(providerId);
  if (!adapter) {
    return null;
  }
  const authProviderId = adapter.authProviderId ?? adapter.id;
  return {
    providerId: adapter.id,
    authProviderId,
    envVars: getProviderEnvVars(authProviderId),
    transport: adapter.transport === "local" ? "local" : "remote",
    autoSelectPriority: adapter.autoSelectPriority,
  };
}

export function listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata(): Array<BuiltinMemoryEmbeddingProviderDoctorMetadata> {
  return listMemoryEmbeddingProviders()
    .filter((adapter) => typeof adapter.autoSelectPriority === "number")
    .toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0))
    .map((adapter) => {
      const authProviderId = adapter.authProviderId ?? adapter.id;
      return {
        providerId: adapter.id,
        authProviderId,
        envVars: getProviderEnvVars(authProviderId),
        transport: adapter.transport === "local" ? "local" : "remote",
        autoSelectPriority: adapter.autoSelectPriority,
      };
    });
}
