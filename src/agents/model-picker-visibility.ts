import { normalizeProviderId } from "./provider-id.js";

const HIDDEN_MODEL_PICKER_PROVIDERS = new Set(["codex"]);

export function isModelPickerVisibleProvider(provider: string): boolean {
  return !HIDDEN_MODEL_PICKER_PROVIDERS.has(normalizeProviderId(provider));
}

export function isModelPickerVisibleModelRef(ref: string): boolean {
  const separatorIndex = ref.indexOf("/");
  if (separatorIndex <= 0) {
    return true;
  }
  return isModelPickerVisibleProvider(ref.slice(0, separatorIndex));
}
