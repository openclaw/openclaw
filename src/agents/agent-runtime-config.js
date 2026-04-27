import { getAgentRuntimeCommandSecretTargetIds } from "../cli/command-secret-targets.js";
import { loadConfig, readConfigFileSnapshotForWrite } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { isSecretRef } from "../config/types.secrets.js";
export async function resolveAgentRuntimeConfig(runtime, params) {
    const loadedRaw = loadConfig();
    const sourceConfig = await (async () => {
        try {
            const { snapshot } = await readConfigFileSnapshotForWrite();
            if (snapshot.valid) {
                return snapshot.resolved;
            }
        }
        catch {
            // Fall back to runtime-loaded config when source snapshot is unavailable.
        }
        return loadedRaw;
    })();
    const includeChannelTargets = params?.runtimeTargetsChannelSecrets === true;
    const cfg = hasAgentRuntimeSecretRefs({
        config: loadedRaw,
        includeChannelTargets,
    })
        ? (await (await import("../cli/command-config-resolution.runtime.js")).resolveCommandConfigWithSecrets({
            config: loadedRaw,
            commandName: "agent",
            targetIds: getAgentRuntimeCommandSecretTargetIds({
                includeChannelTargets,
            }),
            runtime,
        })).resolvedConfig
        : loadedRaw;
    setRuntimeConfigSnapshot(cfg, sourceConfig);
    return { loadedRaw, sourceConfig, cfg };
}
function hasNestedSecretRef(value) {
    if (isSecretRef(value)) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.some((entry) => hasNestedSecretRef(entry));
    }
    if (!value || typeof value !== "object") {
        return false;
    }
    return Object.values(value).some((entry) => hasNestedSecretRef(entry));
}
function hasAgentRuntimeSecretRefs(params) {
    const { config } = params;
    if (hasNestedSecretRef(config.models?.providers)) {
        return true;
    }
    if (hasNestedSecretRef(config.agents?.defaults?.memorySearch?.remote?.apiKey)) {
        return true;
    }
    if (Array.isArray(config.agents?.list) &&
        config.agents.list.some((agent) => hasNestedSecretRef(agent?.memorySearch?.remote?.apiKey))) {
        return true;
    }
    if (hasNestedSecretRef(config.messages?.tts?.providers)) {
        return true;
    }
    if (hasNestedSecretRef(config.skills?.entries)) {
        return true;
    }
    if (hasNestedSecretRef(config.tools?.web?.search)) {
        return true;
    }
    if (config.plugins?.entries &&
        Object.values(config.plugins.entries).some((entry) => hasNestedSecretRef({
            webSearch: entry?.config?.webSearch,
            webFetch: entry?.config?.webFetch,
        }))) {
        return true;
    }
    return params.includeChannelTargets ? hasNestedSecretRef(config.channels) : false;
}
