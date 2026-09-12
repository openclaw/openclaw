import * as modelsProviderRuntime from "openclaw/plugin-sdk/models-provider-runtime";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import {
  createDiscordModelPickerRuntimeToken,
  type DiscordModelPickerState,
} from "./model-picker.state.js";

export function getDiscordModelPickerDefault(data: ModelsProviderData) {
  return data.effectiveDefault === undefined ? data.resolvedDefault : data.effectiveDefault;
}

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

export function resolveDiscordModelPickerRuntimeToken(
  choices: ReturnType<typeof getDiscordModelPickerRuntimeChoices>,
  token: string | undefined,
): string | undefined {
  if (!token) {
    return undefined;
  }
  const matches = choices?.filter(
    (choice) => createDiscordModelPickerRuntimeToken(choice.id) === token,
  );
  return matches?.length === 1 ? matches[0]?.id : undefined;
}

export function resolveDiscordModelPickerPendingRuntime(params: {
  data: ModelsProviderData;
  provider?: string;
  parsed: DiscordModelPickerState;
}): string | undefined {
  return (
    params.parsed.runtime ??
    (params.provider
      ? resolveDiscordModelPickerRuntimeToken(
          getDiscordModelPickerRuntimeChoices(params.data, params.provider),
          params.parsed.runtimeToken,
        )
      : undefined)
  );
}
