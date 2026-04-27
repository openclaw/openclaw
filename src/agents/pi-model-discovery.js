import path from "node:path";
import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import { applyProviderResolvedModelCompatWithPlugins, applyProviderResolvedTransportWithPlugin, normalizeProviderResolvedModelWithPlugin, } from "../plugins/provider-runtime.js";
import { isRecord } from "../utils.js";
import { resolvePiCredentialsForDiscovery, scrubLegacyStaticAuthJsonEntriesForDiscovery, } from "./pi-auth-discovery.js";
import { normalizeProviderId } from "./provider-id.js";
const PiAuthStorageClass = PiCodingAgent.AuthStorage;
const PiModelRegistryClass = PiCodingAgent.ModelRegistry;
export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };
function createInMemoryAuthStorageBackend(initialData) {
    let snapshot = JSON.stringify(initialData, null, 2);
    return {
        withLock(update) {
            const { result, next } = update(snapshot);
            if (typeof next === "string") {
                snapshot = next;
            }
            return result;
        },
    };
}
export function normalizeDiscoveredPiModel(value, agentDir) {
    if (!isRecord(value)) {
        return value;
    }
    if (typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.provider !== "string") {
        return value;
    }
    const model = value;
    const pluginNormalized = normalizeProviderResolvedModelWithPlugin({
        provider: model.provider,
        context: {
            provider: model.provider,
            modelId: model.id,
            model: model,
            agentDir,
        },
    }) ?? model;
    const compatNormalized = applyProviderResolvedModelCompatWithPlugins({
        provider: model.provider,
        context: {
            provider: model.provider,
            modelId: model.id,
            model: pluginNormalized,
            agentDir,
        },
    }) ?? pluginNormalized;
    const transportNormalized = applyProviderResolvedTransportWithPlugin({
        provider: model.provider,
        context: {
            provider: model.provider,
            modelId: model.id,
            model: compatNormalized,
            agentDir,
        },
    }) ?? compatNormalized;
    if (!isRecord(transportNormalized) ||
        typeof transportNormalized.id !== "string" ||
        typeof transportNormalized.name !== "string" ||
        typeof transportNormalized.provider !== "string" ||
        typeof transportNormalized.api !== "string") {
        return value;
    }
    return normalizeModelCompat(transportNormalized);
}
function instantiatePiModelRegistry(authStorage, modelsJsonPath) {
    const Registry = PiModelRegistryClass;
    if (typeof Registry.create === "function") {
        return Registry.create(authStorage, modelsJsonPath);
    }
    return new Registry(authStorage, modelsJsonPath);
}
function createOpenClawModelRegistry(authStorage, modelsJsonPath, agentDir, options) {
    const registry = instantiatePiModelRegistry(authStorage, modelsJsonPath);
    const getAll = registry.getAll.bind(registry);
    const getAvailable = registry.getAvailable.bind(registry);
    const find = registry.find.bind(registry);
    const providerFilter = options?.providerFilter ? normalizeProviderId(options.providerFilter) : "";
    const matchesProviderFilter = (entry) => !providerFilter || normalizeProviderId(entry.provider) === providerFilter;
    registry.getAll = () => getAll()
        .filter((entry) => matchesProviderFilter(entry))
        .map((entry) => normalizeDiscoveredPiModel(entry, agentDir));
    registry.getAvailable = () => getAvailable()
        .filter((entry) => matchesProviderFilter(entry))
        .map((entry) => normalizeDiscoveredPiModel(entry, agentDir));
    registry.find = (provider, modelId) => normalizeDiscoveredPiModel(find(provider, modelId), agentDir);
    return registry;
}
function createAuthStorage(AuthStorageLike, path, creds) {
    const withInMemory = AuthStorageLike;
    if (typeof withInMemory.inMemory === "function") {
        return withInMemory.inMemory(creds);
    }
    const withFromStorage = AuthStorageLike;
    if (typeof withFromStorage.fromStorage === "function") {
        const backendCtor = PiCodingAgent.InMemoryAuthStorageBackend;
        const backend = typeof backendCtor === "function"
            ? new backendCtor()
            : createInMemoryAuthStorageBackend(creds);
        backend.withLock(() => ({
            result: undefined,
            next: JSON.stringify(creds, null, 2),
        }));
        return withFromStorage.fromStorage(backend);
    }
    const withFactory = AuthStorageLike;
    const withRuntimeOverride = (typeof withFactory.create === "function"
        ? withFactory.create(path)
        : new AuthStorageLike(path));
    const hasRuntimeApiKeyOverride = typeof withRuntimeOverride.setRuntimeApiKey === "function"; // pragma: allowlist secret
    if (hasRuntimeApiKeyOverride) {
        for (const [provider, credential] of Object.entries(creds)) {
            if (credential.type === "api_key") {
                withRuntimeOverride.setRuntimeApiKey(provider, credential.key);
                continue;
            }
            withRuntimeOverride.setRuntimeApiKey(provider, credential.access);
        }
    }
    return withRuntimeOverride;
}
// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir, options) {
    const credentials = resolvePiCredentialsForDiscovery(agentDir, options);
    const authPath = path.join(agentDir, "auth.json");
    if (options?.readOnly !== true) {
        scrubLegacyStaticAuthJsonEntriesForDiscovery(authPath);
    }
    return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}
export function discoverModels(authStorage, agentDir, options) {
    return createOpenClawModelRegistry(authStorage, path.join(agentDir, "models.json"), agentDir, options);
}
export { addEnvBackedPiCredentials, resolvePiCredentialsForDiscovery, scrubLegacyStaticAuthJsonEntriesForDiscovery, } from "./pi-auth-discovery.js";
