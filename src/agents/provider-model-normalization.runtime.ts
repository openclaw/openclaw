/** Provider-owned model normalization, using the retained generation before cold discovery. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getCachedPluginModuleLoader } from "../plugins/plugin-module-loader-cache.js";
import { resolveProviderRuntimeOwnerRefs } from "../plugins/provider-config-owner.js";
import {
  normalizeProviderModelIdWithResolvedPlugin,
  type ProviderModelIdNormalizationParams,
} from "../plugins/provider-model-normalization.js";
import { findProviderRuntimePluginInRegistry } from "../plugins/provider-registry-shared.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";

type ProviderNormalizationRuntime =
  typeof import("../plugins/provider-model-normalization.runtime.js");

const require = createRequire(import.meta.url);
let runtime: ProviderNormalizationRuntime | undefined;

function loadProviderNormalizationRuntime(): ProviderNormalizationRuntime {
  if (!runtime) {
    const filename = fileURLToPath(import.meta.url);
    if (filename.endsWith(".ts")) {
      // The canonical source loader supports import-only transitive dependencies;
      // loading the facade itself through a TS require hook forces CJS resolution.
      const modulePath = fileURLToPath(
        new URL("../plugins/provider-model-normalization.runtime.ts", import.meta.url),
      );
      runtime = getCachedPluginModuleLoader({ modulePath, importerUrl: import.meta.url })(
        modulePath,
      ) as ProviderNormalizationRuntime; // SAFETY: The fixed source facade implements this runtime contract.
    } else {
      // Bundled chunks use the stable dist entry. Failures must not become cached hook misses.
      const modulePath = fileURLToPath(
        new URL("./plugins/provider-model-normalization.runtime.js", import.meta.url),
      );
      // SAFETY: The stable build entry exports the same source facade contract.
      runtime = require(modulePath) as ProviderNormalizationRuntime;
    }
  }
  return runtime;
}

/** Normalizes provider model ids through the owning plugin hook and manifest policy. */
export function normalizeProviderModelIdWithRuntime(
  params: ProviderModelIdNormalizationParams,
): string | undefined {
  const registry = getPluginRuntimeGenerationRegistry();
  if (registry) {
    // An empty retained generation is authoritative; ambient plugins cannot fill its misses.
    return normalizeProviderModelIdWithResolvedPlugin(
      params,
      findProviderRuntimePluginInRegistry({
        registry,
        provider: params.provider,
        ownerRefs: resolveProviderRuntimeOwnerRefs(params),
      }),
    );
  }
  return loadProviderNormalizationRuntime().normalizeProviderModelIdWithPlugin(params);
}
