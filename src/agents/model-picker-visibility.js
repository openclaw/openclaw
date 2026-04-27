import { isLegacyRuntimeModelProvider } from "./model-runtime-aliases.js";
import { normalizeProviderId } from "./provider-id.js";
export function isModelPickerVisibleProvider(provider) {
    return !isLegacyRuntimeModelProvider(normalizeProviderId(provider));
}
export function isModelPickerVisibleModelRef(ref) {
    const separatorIndex = ref.indexOf("/");
    if (separatorIndex <= 0) {
        return true;
    }
    return isModelPickerVisibleProvider(ref.slice(0, separatorIndex));
}
