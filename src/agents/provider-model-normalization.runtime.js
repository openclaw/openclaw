import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PROVIDER_RUNTIME_CANDIDATES = [
    "../plugins/provider-runtime.js",
    "../plugins/provider-runtime.ts",
];
let providerRuntimeModule;
function loadProviderRuntime() {
    if (providerRuntimeModule) {
        return providerRuntimeModule;
    }
    for (const candidate of PROVIDER_RUNTIME_CANDIDATES) {
        try {
            providerRuntimeModule = require(candidate);
            return providerRuntimeModule;
        }
        catch {
            // Try source/runtime candidates in order.
        }
    }
    return null;
}
export function normalizeProviderModelIdWithRuntime(params) {
    return loadProviderRuntime()?.normalizeProviderModelIdWithPlugin(params);
}
