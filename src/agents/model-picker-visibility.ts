import { isCliRuntimeProvider } from "./model-runtime-aliases.js";
import { normalizeProviderId } from "./provider-id.js";

const RETIRED_MODEL_PICKER_PROVIDERS = new Set(["codex", "codex-cli"]);

export function isModelPickerVisibleProvider(provider: string): boolean {
  const normalized = normalizeProviderId(provider);
  return (
    !RETIRED_MODEL_PICKER_PROVIDERS.has(normalized) &&
    !isCliRuntimeProvider(normalized, { includeSetupRegistry: true })
  );
}

export function isModelPickerVisibleModelRef(ref: string): boolean {
  const separatorIndex = ref.indexOf("/");
  if (separatorIndex <= 0) {
    return true;
  }
  return isModelPickerVisibleProvider(ref.slice(0, separatorIndex));
}
