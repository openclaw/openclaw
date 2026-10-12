import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";

export function warnSessionPersistenceDeprecation(
  method: string,
  replacement: string,
  options?: { pluginId?: string; family?: string; compatibility?: string },
): void {
  warnPluginSdkDeprecation({
    family: options?.family ?? "session-persistence",
    method,
    replacement,
    pluginId: options?.pluginId,
    compatibility:
      options?.compatibility ??
      "Synchronous calls retain their return values and commit before returning.",
    code: "DEP_SESSION_PERSISTENCE",
  });
}
