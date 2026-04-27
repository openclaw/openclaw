import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackendRuntime } from "../plugins/setup-registry.runtime.js";
import { normalizeProviderId } from "./model-selection-normalize.js";
export function isCliProvider(provider, cfg) {
    const normalized = normalizeProviderId(provider);
    const backends = cfg?.agents?.defaults?.cliBackends ?? {};
    if (Object.keys(backends).some((key) => normalizeProviderId(key) === normalized)) {
        return true;
    }
    const cliBackends = resolveRuntimeCliBackends();
    if (cliBackends.some((backend) => normalizeProviderId(backend.id) === normalized)) {
        return true;
    }
    if (resolvePluginSetupCliBackendRuntime({ backend: normalized })) {
        return true;
    }
    return false;
}
