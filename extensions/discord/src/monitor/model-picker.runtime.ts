import * as modelsProviderRuntime from "openclaw/plugin-sdk/models-provider-runtime";

// The declared 2026.9.3 host lacks this reader. Keep it optional until that host is excluded.
const hostSdk: Partial<Pick<typeof modelsProviderRuntime, "getModelsRuntimeChoices">> =
  modelsProviderRuntime;

export function getDiscordModelPickerRuntimeChoices(
  ...args: Parameters<typeof modelsProviderRuntime.getModelsRuntimeChoices>
): ReturnType<typeof modelsProviderRuntime.getModelsRuntimeChoices> {
  return hostSdk.getModelsRuntimeChoices?.(...args);
}
