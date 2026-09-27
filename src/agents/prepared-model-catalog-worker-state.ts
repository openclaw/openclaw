import { resolveStateDir } from "../config/state-dir.js";
import { loadAuthProfileStoreForRuntimeAsync } from "./auth-profiles/store-runtime.js";
import { withAuthProfileStoreAgentDir } from "./auth-profiles/store.js";
import type { PreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";

/** Prepare persisted auth through the host's single state lifecycle before worker cloning. */
export async function prepareCatalogWorkerAuthStore(
  input: PreparedModelCatalogWorkerInput["input"],
) {
  return await withAuthProfileStoreAgentDir(input.agentDir, resolveStateDir(input.env), () =>
    loadAuthProfileStoreForRuntimeAsync(input.agentDir, {
      allowKeychainPrompt: false,
      config: input.config,
      externalCli: { mode: "none" },
      ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
      readOnly: true,
    }),
  );
}
