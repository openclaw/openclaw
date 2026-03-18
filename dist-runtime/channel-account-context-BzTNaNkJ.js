import { r as formatErrorMessage } from "./errors-nCFRNLA6.js";
import { U as resolveChannelDefaultAccountId, x as inspectReadOnlyChannelAccount } from "./plugins-DC9n978g.js";
//#region src/commands/channel-account-context.ts
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function getBooleanField(value, key) {
	const record = asRecord(value);
	if (!record) return;
	return typeof record[key] === "boolean" ? record[key] : void 0;
}
function formatContextDiagnostic(params) {
	return `${params.commandName ? `${params.commandName}: ` : ""}channels.${params.pluginId}.accounts.${params.accountId}: ${params.message}`;
}
async function resolveDefaultChannelAccountContext(plugin, cfg, options) {
	const mode = options?.mode ?? "strict";
	const accountIds = plugin.config.listAccountIds(cfg);
	const defaultAccountId = resolveChannelDefaultAccountId({
		plugin,
		cfg,
		accountIds
	});
	if (mode === "strict") {
		const account = plugin.config.resolveAccount(cfg, defaultAccountId);
		return {
			accountIds,
			defaultAccountId,
			account,
			enabled: plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : true,
			configured: plugin.config.isConfigured ? await plugin.config.isConfigured(account, cfg) : true,
			diagnostics: [],
			degraded: false
		};
	}
	const diagnostics = [];
	let degraded = false;
	let account = plugin.config.inspectAccount?.(cfg, defaultAccountId) ?? await inspectReadOnlyChannelAccount({
		channelId: plugin.id,
		cfg,
		accountId: defaultAccountId
	});
	if (!account) try {
		account = plugin.config.resolveAccount(cfg, defaultAccountId);
	} catch (error) {
		degraded = true;
		diagnostics.push(formatContextDiagnostic({
			commandName: options?.commandName,
			pluginId: plugin.id,
			accountId: defaultAccountId,
			message: `failed to resolve account (${formatErrorMessage(error)}); skipping read-only checks.`
		}));
		return {
			accountIds,
			defaultAccountId,
			account: {},
			enabled: false,
			configured: false,
			diagnostics,
			degraded
		};
	}
	else degraded = true;
	const inspectEnabled = getBooleanField(account, "enabled");
	let enabled = inspectEnabled ?? true;
	if (inspectEnabled === void 0 && plugin.config.isEnabled) try {
		enabled = plugin.config.isEnabled(account, cfg);
	} catch (error) {
		degraded = true;
		enabled = false;
		diagnostics.push(formatContextDiagnostic({
			commandName: options?.commandName,
			pluginId: plugin.id,
			accountId: defaultAccountId,
			message: `failed to evaluate enabled state (${formatErrorMessage(error)}); treating as disabled.`
		}));
	}
	const inspectConfigured = getBooleanField(account, "configured");
	let configured = inspectConfigured ?? true;
	if (inspectConfigured === void 0 && plugin.config.isConfigured) try {
		configured = await plugin.config.isConfigured(account, cfg);
	} catch (error) {
		degraded = true;
		configured = false;
		diagnostics.push(formatContextDiagnostic({
			commandName: options?.commandName,
			pluginId: plugin.id,
			accountId: defaultAccountId,
			message: `failed to evaluate configured state (${formatErrorMessage(error)}); treating as unconfigured.`
		}));
	}
	return {
		accountIds,
		defaultAccountId,
		account,
		enabled,
		configured,
		diagnostics,
		degraded
	};
}
//#endregion
export { resolveDefaultChannelAccountContext as t };
