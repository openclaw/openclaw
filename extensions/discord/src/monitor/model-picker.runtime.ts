import * as modelsProviderRuntime from "openclaw/plugin-sdk/models-provider-runtime";

// The shipped 2026.9.3 host supports model-only selection without this reader.
const hostSdk: Partial<
  Pick<typeof modelsProviderRuntime, "getModelsRuntimeChoices" | "MODEL_PICKER_CHANGED_MESSAGE">
> = modelsProviderRuntime;

// The shipped 2026.9.4 minimum host omits this export; retire the fallback when that minimum advances.
export const MODEL_PICKER_CHANGED_MESSAGE =
  hostSdk.MODEL_PICKER_CHANGED_MESSAGE ??
  "Available models changed. Open /models and choose again.";

export function supportsDiscordModelPickerRuntimeChoices(): boolean {
  return hostSdk.getModelsRuntimeChoices !== undefined;
}

export function getDiscordModelPickerRuntimeChoices(
  ...args: Parameters<typeof modelsProviderRuntime.getModelsRuntimeChoices>
): ReturnType<typeof modelsProviderRuntime.getModelsRuntimeChoices> {
  return hostSdk.getModelsRuntimeChoices?.(...args);
}
