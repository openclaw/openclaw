import { getApiProvider, registerApiProvider, } from "@mariozechner/pi-ai";
const CUSTOM_API_SOURCE_PREFIX = "openclaw-custom-api:";
export function getCustomApiRegistrySourceId(api) {
    return `${CUSTOM_API_SOURCE_PREFIX}${api}`;
}
export function ensureCustomApiRegistered(api, streamFn) {
    if (getApiProvider(api)) {
        return false;
    }
    registerApiProvider({
        api,
        stream: (model, context, options) => streamFn(model, context, options),
        streamSimple: (model, context, options) => streamFn(model, context, options),
    }, getCustomApiRegistrySourceId(api));
    return true;
}
