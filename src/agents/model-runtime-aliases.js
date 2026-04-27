import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeProviderId } from "./provider-id.js";
const LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES = [
    { legacyProvider: "codex", provider: "openai", runtime: "codex", cli: false },
    { legacyProvider: "codex-cli", provider: "openai", runtime: "codex-cli", cli: true },
    { legacyProvider: "claude-cli", provider: "anthropic", runtime: "claude-cli", cli: true },
    {
        legacyProvider: "google-gemini-cli",
        provider: "google",
        runtime: "google-gemini-cli",
        cli: true,
    },
];
const LEGACY_ALIAS_BY_PROVIDER = new Map(LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.map((entry) => [
    normalizeProviderId(entry.legacyProvider),
    entry,
]));
const CLI_RUNTIME_BY_PROVIDER = new Map(LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) => [
    `${normalizeProviderId(entry.provider)}:${normalizeProviderId(entry.runtime)}`,
    entry,
]));
export function listLegacyRuntimeModelProviderAliases() {
    return LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES;
}
export function resolveLegacyRuntimeModelProviderAlias(provider) {
    return LEGACY_ALIAS_BY_PROVIDER.get(normalizeProviderId(provider));
}
export function migrateLegacyRuntimeModelRef(raw) {
    const trimmed = raw.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash >= trimmed.length - 1) {
        return null;
    }
    const alias = resolveLegacyRuntimeModelProviderAlias(trimmed.slice(0, slash));
    if (!alias) {
        return null;
    }
    const model = trimmed.slice(slash + 1).trim();
    if (!model) {
        return null;
    }
    return {
        ref: `${alias.provider}/${model}`,
        legacyProvider: alias.legacyProvider,
        provider: alias.provider,
        model,
        runtime: alias.runtime,
        cli: alias.cli,
    };
}
export function isLegacyRuntimeModelProvider(provider) {
    return Boolean(resolveLegacyRuntimeModelProviderAlias(provider));
}
function resolveConfiguredRuntime(params) {
    const override = params.runtimeOverride?.trim();
    if (override) {
        return normalizeProviderId(override);
    }
    if (params.agentId) {
        const agentRuntime = params.cfg?.agents?.list
            ?.find((entry) => normalizeAgentId(entry.id) === normalizeAgentId(params.agentId ?? ""))
            ?.embeddedHarness?.runtime?.trim();
        if (agentRuntime) {
            return normalizeProviderId(agentRuntime);
        }
    }
    const defaults = params.cfg?.agents?.defaults?.embeddedHarness?.runtime?.trim();
    if (defaults) {
        return normalizeProviderId(defaults);
    }
    return undefined;
}
export function resolveCliRuntimeExecutionProvider(params) {
    const provider = normalizeProviderId(params.provider);
    const runtime = resolveConfiguredRuntime(params);
    if (!runtime || runtime === "auto" || runtime === "pi") {
        return undefined;
    }
    return CLI_RUNTIME_BY_PROVIDER.get(`${provider}:${runtime}`)?.runtime;
}
