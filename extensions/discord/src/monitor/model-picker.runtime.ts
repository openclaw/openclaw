import * as modelsProviderRuntime from "openclaw/plugin-sdk/models-provider-runtime";

// The shipped 2026.9.3 host supports model-only selection without this reader.
const hostSdk: Partial<Pick<typeof modelsProviderRuntime, "getModelsRuntimeChoices">> =
  modelsProviderRuntime;

export function supportsDiscordModelPickerRuntimeChoices(): boolean {
  return hostSdk.getModelsRuntimeChoices !== undefined;
}

export function getDiscordModelPickerRuntimeChoices(
  ...args: Parameters<typeof modelsProviderRuntime.getModelsRuntimeChoices>
): ReturnType<typeof modelsProviderRuntime.getModelsRuntimeChoices> {
  return hostSdk.getModelsRuntimeChoices?.(...args);
}
