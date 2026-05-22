import "./agent-scope-DXGTDSD0.js";
import { c as resolveDefaultAgentId, r as resolveAgentConfig } from "./agent-scope-config-DdZBnV-N.js";
import { o as getResolvedLoggerSettings } from "./logger-CdnoaNwY.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-D0p0lnLM.js";
import "./logging-DEMPYKjw.js";
import { _ as resolveConfiguredModelRef, r as buildConfiguredModelCatalog } from "./model-selection-shared-Dhs7ZDUG.js";
import { n as modelKey, t as legacyModelKey } from "./model-selection-normalize-Dh_E0SEQ.js";
import { m as resolveThinkingDefault } from "./model-selection-BxUseaAH.js";
import { t as collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags-Mx9sfv8K.js";
import { t as resolveFastModeState } from "./fast-mode-B_AXQKz6.js";
import chalk from "chalk";
//#region src/gateway/server-startup-log.ts
function logGatewayStartup(params) {
	const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const modelRef = `${agentProvider}/${agentModel}`;
	const modelDetails = formatAgentModelStartupDetails({
		cfg: params.cfg,
		provider: agentProvider,
		model: agentModel
	});
	params.log.info(`agent model: ${modelRef} (${modelDetails})`, { consoleMessage: `agent model: ${chalk.whiteBright(modelRef)} (${modelDetails})` });
	const startupDurationMs = typeof params.startupStartedAt === "number" ? Date.now() - params.startupStartedAt : null;
	const startupDurationLabel = startupDurationMs == null ? null : `${(startupDurationMs / 1e3).toFixed(1)}s`;
	params.log.info(`http server listening (${formatReadyDetails(params.loadedPluginIds, startupDurationLabel)})`);
	params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
	if (params.isNixMode) params.log.info("gateway: running in Nix mode (config managed externally)");
	const enabledDangerousFlags = collectEnabledInsecureOrDangerousFlags(params.cfg);
	if (enabledDangerousFlags.length > 0) {
		const warning = `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. Run \`openclaw security audit\`.`;
		params.log.warn(warning);
	}
}
function normalizeStartupThinkLevel(value) {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "adaptive" || value === "max" ? value : void 0;
}
function resolveExplicitStartupThinking(params) {
	const models = params.cfg.agents?.defaults?.models;
	const canonicalKey = modelKey(params.provider, params.model);
	const legacyKey = legacyModelKey(params.provider, params.model);
	return normalizeStartupThinkLevel(params.defaultAgentThinking) ?? normalizeStartupThinkLevel(models?.[canonicalKey]?.params?.thinking) ?? normalizeStartupThinkLevel(legacyKey ? models?.[legacyKey]?.params?.thinking : void 0) ?? normalizeStartupThinkLevel(params.cfg.agents?.defaults?.thinkingDefault);
}
function isConfiguredReasoningDisabled(params) {
	return buildConfiguredModelCatalog({ cfg: params.cfg }).some((entry) => entry.provider === params.provider && entry.id === params.model && entry.reasoning === false);
}
function formatAgentModelStartupDetails(params) {
	const defaultAgentId = resolveDefaultAgentId(params.cfg);
	const defaultAgentConfig = resolveAgentConfig(params.cfg, defaultAgentId);
	const explicitThinking = resolveExplicitStartupThinking({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		defaultAgentThinking: defaultAgentConfig?.thinkingDefault
	});
	const resolvedThinking = explicitThinking ?? resolveThinkingDefault({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model
	});
	return `thinking=${explicitThinking ?? (isConfiguredReasoningDisabled(params) ? "off" : resolvedThinking === "off" ? "medium" : resolvedThinking)}, fast=${resolveFastModeState({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		agentId: defaultAgentId
	}).enabled ? "on" : "off"}`;
}
function formatReadyDetails(loadedPluginIds, startupDurationLabel) {
	const pluginIds = [...new Set(loadedPluginIds.map((id) => id.trim()).filter(Boolean))].toSorted((a, b) => a.localeCompare(b));
	const pluginSummary = pluginIds.length === 0 ? "0 plugins" : `${pluginIds.length} ${pluginIds.length === 1 ? "plugin" : "plugins"}: ${pluginIds.join(", ")}`;
	if (!startupDurationLabel) return pluginSummary;
	return pluginIds.length === 0 ? `${pluginSummary}, ${startupDurationLabel}` : `${pluginSummary}; ${startupDurationLabel}`;
}
//#endregion
export { logGatewayStartup };
