import { vi } from "vitest";

type LoadRuntimeRegistry =
  typeof import("./runtime-plugins.js").loadAgentRuntimePluginRegistryHandle;

export const loadAgentRuntimePluginRegistryHandle = vi.fn<LoadRuntimeRegistry>();

export async function loadAgentRuntimePluginRegistryHandleAsync(
  ...args: Parameters<LoadRuntimeRegistry>
) {
  return loadAgentRuntimePluginRegistryHandle(...args);
}
