import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { normalizeProviderId } from "./model-selection.js";

export type ResolvedCliBackend = {
	id: string;
	config: CliBackendConfig;
	bundleMcp: boolean;
	pluginId?: string;
};

function normalizeBackendKey(key: string): string {
	return normalizeProviderId(key);
}

function pickBackendConfig(
	config: Record<string, CliBackendConfig>,
	normalizedId: string,
): CliBackendConfig | undefined {
	const directKey = Object.keys(config).find(
		(key) => key.trim().toLowerCase() === normalizedId,
	);
	if (directKey) {
		return config[directKey];
	}
	for (const [key, entry] of Object.entries(config)) {
		if (normalizeBackendKey(key) === normalizedId) {
			return entry;
		}
	}
	return undefined;
}

function resolveRegisteredBackend(provider: string) {
	const normalized = normalizeBackendKey(provider);
	return resolveRuntimeCliBackends().find(
		(entry) => normalizeBackendKey(entry.id) === normalized,
	);
}

function mergeBackendConfig(
	base: CliBackendConfig,
	override?: CliBackendConfig,
): CliBackendConfig {
	if (!override) {
		return { ...base };
	}
	const baseFresh = base.reliability?.watchdog?.fresh ?? {};
	const baseResume = base.reliability?.watchdog?.resume ?? {};
	const overrideFresh = override.reliability?.watchdog?.fresh ?? {};
	const overrideResume = override.reliability?.watchdog?.resume ?? {};
	return {
		...base,
		...override,
		args: override.args ?? base.args,
		env: { ...base.env, ...override.env },
		modelAliases: { ...base.modelAliases, ...override.modelAliases },
		clearEnv: Array.from(
			new Set([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])]),
		),
		sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
		sessionArgs: override.sessionArgs ?? base.sessionArgs,
		resumeArgs: override.resumeArgs ?? base.resumeArgs,
		reliability: {
			...base.reliability,
			...override.reliability,
			watchdog: {
				...base.reliability?.watchdog,
				...override.reliability?.watchdog,
				fresh: {
					...baseFresh,
					...overrideFresh,
				},
				resume: {
					...baseResume,
					...overrideResume,
				},
			},
		},
	};
}

export function resolveCliBackendIds(cfg?: OpenClawConfig): Set<string> {
	const ids = new Set<string>();
	for (const backend of resolveRuntimeCliBackends()) {
		ids.add(normalizeBackendKey(backend.id));
	}
	const configured = cfg?.agents?.defaults?.cliBackends ?? {};
	for (const key of Object.keys(configured)) {
		ids.add(normalizeBackendKey(key));
	}
	return ids;
}

export function resolveCliBackendConfig(
	provider: string,
	cfg?: OpenClawConfig,
): ResolvedCliBackend | null {
	const normalized = normalizeBackendKey(provider);
	const configured = cfg?.agents?.defaults?.cliBackends ?? {};
	const override = pickBackendConfig(configured, normalized);
	const registered = resolveRegisteredBackend(normalized);
	if (registered) {
		const merged = mergeBackendConfig(registered.config, override);
		const config = registered.normalizeConfig
			? registered.normalizeConfig(merged)
			: merged;
		const command = config.command?.trim();
		if (!command) {
			return null;
		}
		return {
			id: normalized,
			config: { ...config, command },
			bundleMcp: registered.bundleMcp === true,
			pluginId: registered.pluginId,
		};
	}

	if (!override) {
		return null;
	}
	const command = override.command?.trim();
	if (!command) {
		return null;
	}
	return { id: normalized, config: { ...override, command }, bundleMcp: false };
}
