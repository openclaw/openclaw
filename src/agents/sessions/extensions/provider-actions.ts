import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type { ModelRegistry } from "../model-registry.js";
import type { ExtensionError, ExtensionRuntime, ProviderConfig } from "./types.js";

export function bindExtensionProviderActions(
  runtime: ExtensionRuntime,
  modelRegistry: ModelRegistry,
  emitError: (error: ExtensionError) => void,
  providerActions?: {
    registerProvider?: (name: string, config: ProviderConfig) => void;
    unregisterProvider?: (name: string) => void;
  },
): void {
  // Flush provider registrations queued during extension loading
  for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations) {
    try {
      if (providerActions?.registerProvider) {
        providerActions.registerProvider(name, config);
      } else {
        modelRegistry.registerProvider(name, config);
      }
    } catch (err) {
      emitError({
        extensionPath,
        event: "register_provider",
        error: coerceErrorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
  runtime.pendingProviderRegistrations = [];

  // From this point on, provider registration/unregistration takes effect immediately
  // without requiring a /reload.
  runtime.registerProvider = (name, config) => {
    if (providerActions?.registerProvider) {
      providerActions.registerProvider(name, config);
      return;
    }
    modelRegistry.registerProvider(name, config);
  };
  runtime.unregisterProvider = (name) => {
    if (providerActions?.unregisterProvider) {
      providerActions.unregisterProvider(name);
      return;
    }
    modelRegistry.unregisterProvider(name);
  };
}
