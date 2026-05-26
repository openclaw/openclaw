import { c as normalizeOptionalString, f as readStringValue } from "./string-coerce-DyL154ka.js";
import { d as resolveGatewayPort, t as CONFIG_PATH } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { g as shortenHomePath, p as resolveUserPath, x as isPlainObject } from "./utils-sBTEdeml.js";
import { c as isSecretRef, l as isValidEnvSecretRefId } from "./types.secrets-DwPik3M8.js";
import { n as buildGatewayInstallPlan, r as gatewayInstallErrorHint } from "./auth-install-policy-BV9KSYis.js";
import { n as isNonFatalSystemdInstallProbeError } from "./systemd-DsQkjgIm.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default--mMaLHGD.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { s as resolvePluginContributionOwners } from "./plugin-registry-CgH_ZSlH.js";
import { n as GATEWAY_DAEMON_RUNTIME_OPTIONS, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-C5rLdYLT.js";
import { l as resolveDefaultSecretProviderAlias } from "./ref-contract-D_h_G00C.js";
import { a as findTailscaleBinary } from "./tailscale-BvtowUdS.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { t as ConfigMutationConflictError } from "./mutate-DLC8bveh.js";
import { t as resolveGatewayInstallToken } from "./gateway-install-token-D0PJZIzI.js";
import { t as randomToken } from "./random-token-hQenuzDT.js";
import "./config-B6Oplu5W.js";
import { i as resolveGatewayService, t as describeGatewayServiceRestart } from "./service-CTzdMGsq.js";
import { o as formatPortRangeHint } from "./error-format-BfFDdqsq.js";
import { n as listChatChannels } from "./chat-meta-2H4wOcrq.js";
import { t as resolveControlUiLinks } from "./control-ui-links-BSo6xNaU.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import "./workspace-DTx8zuCN.js";
import "./auth-profiles-D6NMnufG.js";
import { t as describeCodexNativeWebSearch } from "./codex-native-web-search.shared-BOjjagpd.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { t as WizardCancelledError } from "./prompts-E0FayNjJ.js";
import { t as createClackPrompter } from "./clack-prompter-BZIQivnq.js";
import { r as logConfigUpdated } from "./logging-t-RUPR6R.js";
import { t as commitConfigWithPendingPluginInstalls } from "./plugins-install-record-commit-Cwrnavi6.js";
import { a as guardCancel, c as normalizeGatewayTokenInput, f as summarizeExistingConfig, m as waitForGatewayReachable, n as applyWizardMetadata, p as validateGatewayPasswordInput, r as ensureWorkspaceAndSessions, t as DEFAULT_WORKSPACE, u as probeGatewayReachable } from "./onboard-helpers-BaLdeEkj.js";
import { a as outro, c as text, i as intro, n as CONFIGURE_WIZARD_SECTIONS, o as parseConfigureWizardSections, r as confirm, s as select, t as CONFIGURE_SECTION_OPTIONS } from "./configure.shared-C2Fyjm61.js";
import { t as ensureControlUiAssetsBuilt } from "./control-ui-assets-W5GRTbBr.js";
import { t as promptAuthChoiceGrouped } from "./auth-choice-prompt-CdEsSTjE.js";
import { n as applyAuthChoice } from "./auth-choice-BBb-EODS.js";
import { t as resolvePreferredProviderForAuthChoice } from "./provider-auth-choice-preference-D8SR8dUs.js";
import { i as setupChannels } from "./onboard-channels-D6MPIGWb.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-CDzkHBam.js";
import { t as ensureSystemdUserLingerInteractive } from "./systemd-linger-CByQQhS3.js";
import { t as loadStaticManifestCatalogRowsForList } from "./list.manifest-catalog-CYfhguU2.js";
import { t as applyPrimaryModel } from "./provider-model-primary-Df1toqCt.js";
import { i as promptModelAllowlist, n as applyModelFallbacksFromSelection, r as promptDefaultModel, t as applyModelAllowlist } from "./model-picker-hKPBYckE.js";
import { t as promptCustomApiConfig } from "./onboard-custom-BrvirIFA.js";
import { a as maybeAddTailnetOriginToControlUiAllowedOrigins, i as TAILSCALE_MISSING_BIN_NOTE_LINES, n as TAILSCALE_DOCS_LINES, r as TAILSCALE_EXPOSURE_OPTIONS, t as validateIPv4AddressInput } from "./ipv4-CztOOH8R.js";
import { n as formatHealthCheckFailure } from "./health-format-DaSqSjzQ.js";
import { n as healthCommand } from "./health-MpLQnEZv.js";
import { t as promptRemoteGatewayConfig } from "./onboard-remote-DR5OaRwp.js";
import { t as setupSkills } from "./onboard-skills-qm0QKRhA.js";
import path from "node:path";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
//#region src/commands/configure.channels.ts
const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
const DONE_VALUE = { kind: "done" };
function listConfiguredChannelRemovalChoices(cfg) {
	const channels = cfg.channels;
	if (!channels) return [];
	const labelsById = new Map(listChatChannels().map((meta) => [meta.id, formatChannelRemovalLabel(meta.label, meta.id)]));
	return Object.keys(channels).filter((id) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id)).filter((id) => !isBlockedObjectKey(id)).map((id) => ({
		id,
		label: labelsById.get(id) ?? formatUnknownChannelRemovalLabel(id)
	})).toSorted(compareChannelRemovalChoices);
}
function formatChannelRemovalLabel(label, fallback) {
	return sanitizeTerminalText(label) || formatUnknownChannelRemovalLabel(fallback);
}
function formatUnknownChannelRemovalLabel(id) {
	return sanitizeTerminalText(id) || "<invalid channel key>";
}
function compareChannelRemovalChoices(left, right) {
	return left.label.localeCompare(right.label, void 0, {
		numeric: true,
		sensitivity: "base"
	}) || left.id.localeCompare(right.id, void 0, {
		numeric: true,
		sensitivity: "base"
	});
}
async function removeChannelConfigWizard(cfg, runtime) {
	let next = { ...cfg };
	while (true) {
		const configured = listConfiguredChannelRemovalChoices(next);
		if (configured.length === 0) {
			note(["No channel config found in openclaw.json.", `Tip: \`${formatCliCommand("openclaw channels status")}\` shows what is configured and enabled.`].join("\n"), "Remove channel");
			return next;
		}
		const channelOptions = configured.map((meta) => ({
			value: {
				kind: "channel",
				id: meta.id
			},
			label: meta.label,
			hint: "Deletes tokens + settings from config (credentials stay on disk)"
		}));
		const doneOption = {
			value: DONE_VALUE,
			label: "Done"
		};
		const choice = guardCancel(await select({
			message: "Remove which channel config?",
			options: [...channelOptions, doneOption]
		}), runtime);
		if (choice.kind === "done") return next;
		const channel = choice.id;
		const label = configured.find((entry) => entry.id === channel)?.label ?? channel;
		if (!guardCancel(await confirm({
			message: `Delete ${label} configuration from ${shortenHomePath(CONFIG_PATH)}?`,
			initialValue: false
		}), runtime)) continue;
		const nextChannels = { ...next.channels };
		delete nextChannels[channel];
		if (Object.keys(nextChannels).length) next.channels = nextChannels;
		else delete next.channels;
		note([`${label} removed from config.`, "Note: credentials/sessions on disk are unchanged."].join("\n"), "Channel removed");
	}
}
//#endregion
//#region src/commands/configure.daemon.ts
async function maybeInstallDaemon(params) {
	const service = resolveGatewayService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch (error) {
		if (!isNonFatalSystemdInstallProbeError(error)) throw error;
		loaded = false;
	}
	let shouldCheckLinger = false;
	let shouldInstall = true;
	let daemonRuntime = params.daemonRuntime ?? "node";
	if (loaded) {
		const action = guardCancel(await select({
			message: "Gateway service already installed",
			options: [
				{
					value: "restart",
					label: "Restart"
				},
				{
					value: "reinstall",
					label: "Reinstall"
				},
				{
					value: "skip",
					label: "Skip"
				}
			]
		}), params.runtime);
		if (action === "restart") {
			await withProgress({
				label: "Gateway service",
				indeterminate: true,
				delayMs: 0
			}, async (progress) => {
				progress.setLabel("Restarting Gateway service…");
				const restartResult = await service.restart({
					env: process.env,
					stdout: process.stdout
				});
				progress.setLabel(describeGatewayServiceRestart("Gateway", restartResult).progressMessage);
			});
			shouldCheckLinger = true;
			shouldInstall = false;
		}
		if (action === "skip") return;
		if (action === "reinstall") await withProgress({
			label: "Gateway service",
			indeterminate: true,
			delayMs: 0
		}, async (progress) => {
			progress.setLabel("Uninstalling Gateway service…");
			await service.uninstall({
				env: process.env,
				stdout: process.stdout
			});
			progress.setLabel("Gateway service uninstalled.");
		});
	}
	if (shouldInstall) {
		let installError = null;
		if (!params.daemonRuntime) if (GATEWAY_DAEMON_RUNTIME_OPTIONS.length === 1) daemonRuntime = GATEWAY_DAEMON_RUNTIME_OPTIONS[0]?.value ?? "node";
		else daemonRuntime = guardCancel(await select({
			message: "Gateway service runtime",
			options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
			initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME
		}), params.runtime);
		await withProgress({
			label: "Gateway service",
			indeterminate: true,
			delayMs: 0
		}, async (progress) => {
			progress.setLabel("Preparing Gateway service…");
			const cfg = getRuntimeConfig();
			const tokenResolution = await resolveGatewayInstallToken({
				config: cfg,
				env: process.env
			});
			for (const warning of tokenResolution.warnings) note(warning, "Gateway");
			if (tokenResolution.unavailableReason) {
				installError = [
					"Gateway install blocked:",
					tokenResolution.unavailableReason,
					"Fix gateway auth config/token input and rerun configure."
				].join(" ");
				progress.setLabel("Gateway service install blocked.");
				return;
			}
			const { programArguments, workingDirectory, environment, environmentValueSources } = await buildGatewayInstallPlan({
				env: process.env,
				port: params.port,
				runtime: daemonRuntime,
				warn: (message, title) => note(message, title),
				config: cfg
			});
			progress.setLabel("Installing Gateway service…");
			try {
				await service.install({
					env: process.env,
					stdout: process.stdout,
					programArguments,
					workingDirectory,
					environment,
					environmentValueSources
				});
				progress.setLabel("Gateway service installed.");
			} catch (err) {
				installError = formatErrorMessage(err);
				progress.setLabel("Gateway service install failed.");
			}
		});
		if (installError) {
			note("Gateway service install failed: " + installError, "Gateway");
			note(gatewayInstallErrorHint(), "Gateway");
			return;
		}
		shouldCheckLinger = true;
	}
	if (shouldCheckLinger) await ensureSystemdUserLingerInteractive({
		runtime: params.runtime,
		prompter: {
			confirm: async (p) => guardCancel(await confirm(p), params.runtime),
			note
		},
		reason: "Linux installs use a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
		requireConfirm: true
	});
}
//#endregion
//#region src/commands/configure.gateway-auth.ts
/** Reject undefined, empty, and common JS string-coercion artifacts for token auth. */
function sanitizeTokenValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "undefined" || trimmed === "null") return;
	return trimmed;
}
async function resolveProviderChoiceModelPrompt(params) {
	const { resolvePluginProviders, resolveProviderPluginChoice } = await import("./provider-auth-choice.runtime-Bl0CDGQM.js");
	const resolved = resolveProviderPluginChoice({
		providers: resolvePluginProviders({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			mode: "setup"
		}),
		choice: params.authChoice
	});
	const wizard = resolved?.provider.wizard?.setup;
	if (!wizard) return resolved?.provider.id ? { provider: resolved.provider.id } : void 0;
	return {
		provider: resolved.provider.id,
		...wizard.modelAllowlist,
		...wizard.modelSelection?.promptWhenAuthChoiceProvided === true ? { loadCatalog: true } : {}
	};
}
function hasConfiguredProviderModels(cfg, provider) {
	if (!provider) return false;
	if ((cfg.models?.providers?.[provider]?.models?.length ?? 0) > 0) return true;
	const providerPrefix = `${provider}/`;
	return Object.keys(cfg.agents?.defaults?.models ?? {}).some((key) => key.trim().startsWith(providerPrefix));
}
function hasStaticManifestCatalogRows(cfg, provider) {
	if (!provider) return false;
	return loadStaticManifestCatalogRowsForList({
		cfg,
		providerFilter: provider
	}).length > 0;
}
function listConfiguredModelProviders(cfg) {
	return Object.entries(cfg.models?.providers ?? {}).filter(([, provider]) => (provider.models?.length ?? 0) > 0).map(([provider]) => provider);
}
function resolveSingleConfiguredProvider(cfg) {
	const configuredProviders = listConfiguredModelProviders(cfg);
	return configuredProviders.length === 1 ? configuredProviders[0] : void 0;
}
function resolveProviderFromModelRef(model) {
	const trimmed = model?.trim();
	const slashIndex = trimmed?.indexOf("/") ?? -1;
	return slashIndex > 0 ? trimmed?.slice(0, slashIndex) : void 0;
}
function resolveConfiguredProviderFromAuthChange(params) {
	if (hasConfiguredProviderModels(params.after, params.preferredProvider)) return params.preferredProvider;
	const beforeProviders = params.before.models?.providers ?? {};
	const configuredProviders = listConfiguredModelProviders(params.after);
	const changedProviders = configuredProviders.filter((provider) => {
		const beforeCount = beforeProviders[provider]?.models?.length ?? 0;
		return (params.after.models?.providers?.[provider]?.models?.length ?? 0) > beforeCount;
	});
	if (changedProviders.length === 1) return changedProviders[0];
	return params.preferredProvider ?? (configuredProviders.length === 1 ? configuredProviders[0] : void 0);
}
function buildGatewayAuthConfig(params) {
	const allowTailscale = params.existing?.allowTailscale;
	const base = {};
	if (typeof allowTailscale === "boolean") base.allowTailscale = allowTailscale;
	if (params.mode === "token") {
		if (isSecretRef(params.token)) return {
			...base,
			mode: "token",
			token: params.token
		};
		const token = sanitizeTokenValue(params.token) ?? randomToken();
		return {
			...base,
			mode: "token",
			token
		};
	}
	if (params.mode === "password") {
		const password = params.password?.trim();
		return {
			...base,
			mode: "password",
			...password && { password }
		};
	}
	if (params.mode === "trusted-proxy") {
		if (!params.trustedProxy) throw new Error(`trustedProxy config is required when mode is trusted-proxy. Run ${formatCliCommand("openclaw configure --section gateway")} to configure Gateway auth interactively.`);
		return {
			...base,
			mode: "trusted-proxy",
			trustedProxy: params.trustedProxy
		};
	}
	return base;
}
async function promptAuthConfig(cfg, runtime, prompter) {
	let next = cfg;
	let authChoice = "skip";
	let preferredProvider;
	while (true) {
		authChoice = await promptAuthChoiceGrouped({
			prompter,
			store: ensureAuthProfileStore(void 0, { allowKeychainPrompt: false }),
			includeSkip: true,
			config: next
		});
		preferredProvider = authChoice === "skip" ? void 0 : await resolvePreferredProviderForAuthChoice({
			choice: authChoice,
			config: next
		});
		if (authChoice === "custom-api-key") {
			next = (await promptCustomApiConfig({
				prompter,
				runtime,
				config: next
			})).config;
			break;
		}
		if (authChoice === "skip") {
			const modelSelection = await promptDefaultModel({
				config: next,
				prompter,
				allowKeep: true,
				ignoreAllowlist: true,
				includeProviderPluginSetups: false,
				loadCatalog: true,
				browseCatalogOnDemand: true,
				preferredProvider,
				workspaceDir: resolveDefaultAgentWorkspaceDir(),
				runtime
			});
			if (modelSelection.config) next = modelSelection.config;
			if (modelSelection.model) {
				next = applyPrimaryModel(next, modelSelection.model);
				preferredProvider = resolveProviderFromModelRef(modelSelection.model) ?? preferredProvider;
			}
			break;
		}
		const beforeAuthConfig = next;
		const applied = await applyAuthChoice({
			authChoice,
			config: next,
			prompter,
			runtime,
			setDefaultModel: true,
			preserveExistingDefaultModel: true
		});
		next = applied.config;
		preferredProvider = resolveConfiguredProviderFromAuthChange({
			before: beforeAuthConfig,
			after: next,
			preferredProvider
		});
		if (applied.retrySelection) continue;
		break;
	}
	if (authChoice !== "custom-api-key") {
		const modelPrompt = await resolveProviderChoiceModelPrompt({
			authChoice,
			config: next,
			workspaceDir: resolveDefaultAgentWorkspaceDir(),
			env: process.env
		});
		const promptProvider = modelPrompt?.provider ?? preferredProvider ?? resolveSingleConfiguredProvider(next);
		const allowlistSelection = await promptModelAllowlist({
			config: next,
			prompter,
			workspaceDir: resolveDefaultAgentWorkspaceDir(),
			env: process.env,
			allowedKeys: modelPrompt?.allowedKeys,
			initialSelections: modelPrompt?.initialSelections,
			message: modelPrompt?.message,
			preferredProvider: promptProvider,
			loadCatalog: modelPrompt?.loadCatalog ?? (hasConfiguredProviderModels(next, promptProvider) || hasStaticManifestCatalogRows(next, promptProvider))
		});
		if (allowlistSelection.models) {
			next = applyModelFallbacksFromSelection(next, allowlistSelection.models, { scopeKeys: allowlistSelection.scopeKeys });
			next = applyModelAllowlist(next, allowlistSelection.models, { scopeKeys: allowlistSelection.scopeKeys });
		}
	}
	return next;
}
//#endregion
//#region src/commands/configure.gateway.ts
function validateGatewayPortInput$1(value) {
	const port = Number(typeof value === "string" ? value.trim() : value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return formatPortRangeHint();
}
async function promptGatewayConfig(cfg, runtime) {
	const portRaw = guardCancel(await text({
		message: "Gateway port",
		initialValue: String(resolveGatewayPort(cfg)),
		validate: validateGatewayPortInput$1
	}), runtime);
	const port = Number.parseInt(portRaw, 10);
	let bind = guardCancel(await select({
		message: "Gateway bind mode",
		options: [
			{
				value: "loopback",
				label: "Loopback (Local only)",
				hint: "Bind to 127.0.0.1 - secure, local-only access"
			},
			{
				value: "tailnet",
				label: "Tailnet (Tailscale IP)",
				hint: "Bind to your Tailscale IP only (100.x.x.x)"
			},
			{
				value: "auto",
				label: "Auto (Loopback → LAN)",
				hint: "Prefer loopback; fall back to all interfaces if unavailable"
			},
			{
				value: "lan",
				label: "LAN (All interfaces)",
				hint: "Bind to 0.0.0.0 - accessible from anywhere on your network"
			},
			{
				value: "custom",
				label: "Custom IP",
				hint: "Specify a specific IP address, with 0.0.0.0 fallback if unavailable"
			}
		]
	}), runtime);
	let customBindHost;
	if (bind === "custom") customBindHost = readStringValue(guardCancel(await text({
		message: "Custom IP address",
		placeholder: "192.168.1.100",
		validate: validateIPv4AddressInput
	}), runtime));
	let authMode = guardCancel(await select({
		message: "Gateway access protection",
		options: [
			{
				value: "token",
				label: "Token (recommended)",
				hint: "Recommended default"
			},
			{
				value: "password",
				label: "Password"
			},
			{
				value: "trusted-proxy",
				label: "Trusted Proxy",
				hint: "Behind reverse proxy (Pomerium, Caddy, Traefik, etc.)"
			}
		],
		initialValue: "token"
	}), runtime);
	let tailscaleMode = guardCancel(await select({
		message: "Tailscale exposure",
		options: [...TAILSCALE_EXPOSURE_OPTIONS]
	}), runtime);
	let tailscaleBin = null;
	if (tailscaleMode !== "off") {
		tailscaleBin = await findTailscaleBinary();
		if (!tailscaleBin) note(TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"), "Tailscale Warning");
	}
	let tailscaleResetOnExit = false;
	if (tailscaleMode !== "off") {
		note(TAILSCALE_DOCS_LINES.join("\n"), "Tailscale");
		tailscaleResetOnExit = guardCancel(await confirm({
			message: "Reset Tailscale serve/funnel on exit?",
			initialValue: false
		}), runtime);
	}
	if (tailscaleMode !== "off" && bind !== "loopback") {
		note("Tailscale requires bind=loopback. Adjusting bind to loopback.", "Note");
		bind = "loopback";
	}
	if (tailscaleMode === "funnel" && authMode !== "password") {
		note("Tailscale funnel requires password auth.", "Note");
		authMode = "password";
	}
	if (authMode === "trusted-proxy" && tailscaleMode !== "off") {
		note("Trusted proxy auth is incompatible with Tailscale serve/funnel. Disabling Tailscale.", "Note");
		tailscaleMode = "off";
		tailscaleResetOnExit = false;
	}
	let gatewayToken;
	let gatewayTokenForCalls;
	let gatewayPassword;
	let trustedProxyConfig;
	let trustedProxies;
	let next = cfg;
	if (authMode === "token") if (guardCancel(await select({
		message: "Gateway token source",
		options: [{
			value: "plaintext",
			label: "Generate/store plaintext token",
			hint: "Default"
		}, {
			value: "ref",
			label: "Use SecretRef",
			hint: "Store an env-backed reference instead of plaintext"
		}],
		initialValue: "plaintext"
	}), runtime) === "ref") {
		const envVarName = normalizeOptionalString(guardCancel(await text({
			message: "Gateway token env var",
			initialValue: "OPENCLAW_GATEWAY_TOKEN",
			placeholder: "OPENCLAW_GATEWAY_TOKEN",
			validate: (value) => {
				const candidate = normalizeOptionalString(value) ?? "";
				if (!isValidEnvSecretRefId(candidate)) return "Use an env var name like OPENCLAW_GATEWAY_TOKEN.";
				if (!process.env[candidate]?.trim()) return `Environment variable "${candidate}" is missing or empty in this session.`;
			}
		}), runtime)) ?? "";
		gatewayToken = {
			source: "env",
			provider: resolveDefaultSecretProviderAlias(cfg, "env", { preferFirstProviderForSource: true }),
			id: envVarName
		};
		note(`Validated ${envVarName}. OpenClaw will store a token SecretRef.`, "Gateway token");
	} else {
		gatewayTokenForCalls = normalizeGatewayTokenInput(guardCancel(await text({
			message: "Gateway token (blank to generate)",
			initialValue: randomToken()
		}), runtime)) || randomToken();
		gatewayToken = gatewayTokenForCalls;
	}
	if (authMode === "password") gatewayPassword = normalizeOptionalString(guardCancel(await text({
		message: "Gateway password",
		validate: validateGatewayPasswordInput
	}), runtime)) ?? "";
	if (authMode === "trusted-proxy") {
		note([
			"Trusted proxy mode: OpenClaw trusts user identity from a reverse proxy.",
			"The proxy must authenticate users and pass identity via headers.",
			"Only requests from specified proxy IPs will be trusted.",
			"",
			"Common use cases: Pomerium, Caddy + OAuth, Traefik + forward auth",
			"Docs: https://docs.openclaw.ai/gateway/trusted-proxy-auth"
		].join("\n"), "Trusted Proxy Auth");
		const userHeader = guardCancel(await text({
			message: "Header containing user identity",
			placeholder: "x-forwarded-user",
			initialValue: "x-forwarded-user",
			validate: (value) => value?.trim() ? void 0 : "User header is required"
		}), runtime);
		const requiredHeadersRaw = guardCancel(await text({
			message: "Required headers (comma-separated, optional)",
			placeholder: "x-forwarded-proto,x-forwarded-host"
		}), runtime);
		const requiredHeaders = requiredHeadersRaw ? normalizeStringEntries(requiredHeadersRaw.split(",")) : [];
		const allowUsersRaw = guardCancel(await text({
			message: "Allowed users (comma-separated, blank = all authenticated users)",
			placeholder: "nick@example.com,admin@company.com"
		}), runtime);
		const allowUsers = allowUsersRaw ? normalizeStringEntries(allowUsersRaw.split(",")) : [];
		trustedProxies = normalizeStringEntries(guardCancel(await text({
			message: "Trusted proxy IPs (comma-separated)",
			placeholder: "10.0.1.10,192.168.1.5",
			validate: (value) => {
				if (!normalizeOptionalString(value)) return "At least one trusted proxy IP is required";
			}
		}), runtime).split(","));
		trustedProxyConfig = {
			userHeader: normalizeOptionalString(userHeader) ?? "",
			requiredHeaders: requiredHeaders.length > 0 ? requiredHeaders : void 0,
			allowUsers: allowUsers.length > 0 ? allowUsers : void 0
		};
	}
	const authConfig = buildGatewayAuthConfig({
		existing: next.gateway?.auth,
		mode: authMode,
		token: gatewayToken,
		password: gatewayPassword,
		trustedProxy: trustedProxyConfig
	});
	next = {
		...next,
		gateway: {
			...next.gateway,
			mode: "local",
			port,
			bind,
			auth: authConfig,
			...customBindHost && { customBindHost },
			...trustedProxies && { trustedProxies },
			tailscale: {
				...next.gateway?.tailscale,
				mode: tailscaleMode,
				resetOnExit: tailscaleResetOnExit
			}
		}
	};
	next = await maybeAddTailnetOriginToControlUiAllowedOrigins({
		config: next,
		tailscaleMode,
		tailscaleBin
	});
	return {
		config: next,
		port,
		token: gatewayTokenForCalls
	};
}
//#endregion
//#region src/commands/configure.wizard.ts
const GATEWAY_HINT_PROBE_TIMEOUT_MS = 300;
const setupPluginConfigModuleLoader = createLazyImportLoader(() => import("./setup.plugin-config-D5efkKaF.js"));
function validateGatewayPortInput(value) {
	const port = Number(typeof value === "string" ? value.trim() : value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return formatPortRangeHint();
}
function loadSetupPluginConfigModule() {
	return setupPluginConfigModuleLoader.load();
}
function mergeWizardConfigOntoLatest(current, base, next) {
	if (isDeepStrictEqual(next, base)) return current;
	if (isPlainObject(current) && isPlainObject(base) && isPlainObject(next)) {
		const merged = { ...current };
		const keys = new Set([
			...Object.keys(current),
			...Object.keys(base),
			...Object.keys(next)
		]);
		for (const key of keys) {
			const mergedValue = mergeWizardConfigOntoLatest(current[key], base[key], next[key]);
			if (mergedValue === void 0) delete merged[key];
			else merged[key] = mergedValue;
		}
		return merged;
	}
	return structuredClone(next);
}
async function resolveGatewaySecretInputForWizard(params) {
	try {
		return await resolveSetupSecretInputString({
			config: params.cfg,
			value: params.value,
			path: params.path,
			env: process.env
		});
	} catch {
		return;
	}
}
async function runGatewayHealthCheck(params) {
	const localLinks = resolveControlUiLinks({
		bind: params.cfg.gateway?.bind ?? "loopback",
		port: params.port,
		customBindHost: params.cfg.gateway?.customBindHost,
		basePath: void 0,
		tlsEnabled: params.cfg.gateway?.tls?.enabled === true
	});
	const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
	const wsUrl = params.cfg.gateway?.mode === "remote" && remoteUrl ? remoteUrl : localLinks.wsUrl;
	const configuredToken = await resolveGatewaySecretInputForWizard({
		cfg: params.cfg,
		value: params.cfg.gateway?.auth?.token,
		path: "gateway.auth.token"
	});
	const configuredPassword = await resolveGatewaySecretInputForWizard({
		cfg: params.cfg,
		value: params.cfg.gateway?.auth?.password,
		path: "gateway.auth.password"
	});
	await waitForGatewayReachable({
		url: wsUrl,
		token: process.env.OPENCLAW_GATEWAY_TOKEN ?? configuredToken,
		password: process.env.OPENCLAW_GATEWAY_PASSWORD ?? configuredPassword,
		deadlineMs: 15e3
	});
	try {
		await healthCommand({
			json: false,
			timeoutMs: 1e4
		}, params.runtime);
	} catch (err) {
		params.runtime.error(formatHealthCheckFailure(err));
		note([
			"Docs:",
			"https://docs.openclaw.ai/gateway/health",
			"https://docs.openclaw.ai/gateway/troubleshooting"
		].join("\n"), "Health check help");
	}
}
async function promptConfigureSection(runtime, hasSelection) {
	return guardCancel(await select({
		message: "What do you want to configure?",
		options: [...CONFIGURE_SECTION_OPTIONS, {
			value: "__continue",
			label: hasSelection ? "Done" : "Skip for now"
		}],
		initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value
	}), runtime);
}
async function promptChannelMode(runtime) {
	return guardCancel(await select({
		message: "Channel setup",
		options: [{
			value: "configure",
			label: "Add or update channels",
			hint: "Configure accounts and disable unselected accounts"
		}, {
			value: "remove",
			label: "Remove channel config",
			hint: "Delete channel tokens/settings from openclaw.json"
		}],
		initialValue: "configure"
	}), runtime);
}
async function promptWebToolsConfig(nextConfig, runtime, prompter) {
	const existingSearch = nextConfig.tools?.web?.search;
	const existingFetch = nextConfig.tools?.web?.fetch;
	const { isCodexNativeWebSearchRelevant } = await import("./codex-native-web-search-BbKTdAhQ.js");
	const hasManagedSearchProviders = resolvePluginContributionOwners({
		config: nextConfig,
		contribution: "contracts",
		matches: "webSearchProviders"
	}).length > 0;
	note([
		"Web search lets your agent look things up online using the `web_search` tool.",
		"Choose a managed provider now, and Codex-capable models can also use native Codex web search.",
		"Docs: https://docs.openclaw.ai/tools/web"
	].join("\n"), "Web search");
	const enableSearch = guardCancel(await confirm({
		message: "Enable web_search?",
		initialValue: existingSearch?.enabled ?? hasManagedSearchProviders
	}), runtime);
	let nextSearch = {
		...existingSearch,
		enabled: enableSearch
	};
	let workingConfig = nextConfig;
	if (enableSearch) {
		const codexRelevant = isCodexNativeWebSearchRelevant({ config: nextConfig });
		let configureManagedProvider = true;
		if (codexRelevant) {
			note([
				"Codex-capable models can optionally use native Codex web search.",
				"Managed web_search still controls non-Codex models.",
				"If no managed provider is configured, non-Codex models still rely on provider auto-detect and may have no search available.",
				...describeCodexNativeWebSearch(nextConfig) ? [describeCodexNativeWebSearch(nextConfig)] : ["Recommended mode: cached."]
			].join("\n"), "Codex native search");
			if (guardCancel(await confirm({
				message: "Enable native Codex web search for Codex-capable models?",
				initialValue: existingSearch?.openaiCodex?.enabled === true
			}), runtime)) {
				const codexMode = guardCancel(await select({
					message: "Codex native web search mode",
					options: [{
						value: "cached",
						label: "cached (recommended)",
						hint: "Uses cached web content"
					}, {
						value: "live",
						label: "live",
						hint: "Allows live external web access"
					}],
					initialValue: existingSearch?.openaiCodex?.mode ?? "cached"
				}), runtime);
				nextSearch = {
					...nextSearch,
					openaiCodex: {
						...existingSearch?.openaiCodex,
						enabled: true,
						mode: codexMode
					}
				};
				configureManagedProvider = guardCancel(await confirm({
					message: "Configure or change a managed web search provider now?",
					initialValue: Boolean(existingSearch?.provider)
				}), runtime);
			} else nextSearch = {
				...nextSearch,
				openaiCodex: {
					...existingSearch?.openaiCodex,
					enabled: false
				}
			};
		}
		if (configureManagedProvider) {
			const { resolveSearchProviderOptions, setupSearch } = await import("./onboard-search-DQdjHj2S.js");
			if (resolveSearchProviderOptions(nextConfig).length === 0) {
				note([
					"No web search providers are currently available under this plugin policy.",
					"Enable plugins or remove deny rules, then rerun configure.",
					"Docs: https://docs.openclaw.ai/tools/web"
				].join("\n"), "Web search");
				if (nextSearch.openaiCodex?.enabled !== true) nextSearch = {
					...existingSearch,
					enabled: false
				};
			} else {
				workingConfig = await setupSearch(workingConfig, runtime, prompter);
				nextSearch = {
					...workingConfig.tools?.web?.search,
					enabled: workingConfig.tools?.web?.search?.provider ? true : existingSearch?.enabled,
					openaiCodex: {
						...existingSearch?.openaiCodex,
						...nextSearch.openaiCodex
					}
				};
			}
		}
	}
	const enableFetch = guardCancel(await confirm({
		message: "Enable web_fetch (keyless HTTP fetch)?",
		initialValue: existingFetch?.enabled ?? true
	}), runtime);
	const nextFetch = {
		...existingFetch,
		enabled: enableFetch
	};
	return {
		...workingConfig,
		tools: {
			...workingConfig.tools,
			web: {
				...workingConfig.tools?.web,
				search: nextSearch,
				fetch: nextFetch
			}
		}
	};
}
async function runConfigureWizard(opts, runtime = defaultRuntime) {
	try {
		intro(opts.command === "update" ? "OpenClaw update wizard" : "OpenClaw configure");
		const prompter = createClackPrompter();
		const snapshot = await readConfigFileSnapshot();
		let currentBaseHash = snapshot.hash;
		const baseConfig = snapshot.valid ? snapshot.sourceConfig ?? snapshot.config : {};
		if (snapshot.exists) {
			const title = snapshot.valid ? "Existing config detected" : "Invalid config";
			note(summarizeExistingConfig(baseConfig), title);
			if (!snapshot.valid && snapshot.issues.length > 0) note([
				...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
				"",
				"Docs: https://docs.openclaw.ai/gateway/configuration"
			].join("\n"), "Config issues");
			if (!snapshot.valid) {
				outro(`Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run configure.`);
				runtime.exit(1);
				return;
			}
		}
		const selectedSections = opts.sections;
		const shouldPromptGatewayRunMode = !selectedSections || selectedSections.includes("gateway") || selectedSections.includes("daemon") || selectedSections.includes("health");
		const promptGatewayRunMode = async () => {
			const localUrl = "ws://127.0.0.1:18789";
			const remoteUrl = normalizeOptionalString(baseConfig.gateway?.remote?.url) ?? "";
			const localProbePromise = (async () => {
				const [baseLocalProbeToken, baseLocalProbePassword] = await Promise.all([resolveGatewaySecretInputForWizard({
					cfg: baseConfig,
					value: baseConfig.gateway?.auth?.token,
					path: "gateway.auth.token"
				}), resolveGatewaySecretInputForWizard({
					cfg: baseConfig,
					value: baseConfig.gateway?.auth?.password,
					path: "gateway.auth.password"
				})]);
				return probeGatewayReachable({
					url: localUrl,
					token: process.env.OPENCLAW_GATEWAY_TOKEN ?? baseLocalProbeToken,
					password: process.env.OPENCLAW_GATEWAY_PASSWORD ?? baseLocalProbePassword,
					timeoutMs: GATEWAY_HINT_PROBE_TIMEOUT_MS
				});
			})();
			const remoteProbePromise = remoteUrl ? (async () => {
				return probeGatewayReachable({
					url: remoteUrl,
					token: await resolveGatewaySecretInputForWizard({
						cfg: baseConfig,
						value: baseConfig.gateway?.remote?.token,
						path: "gateway.remote.token"
					}),
					timeoutMs: GATEWAY_HINT_PROBE_TIMEOUT_MS
				});
			})() : Promise.resolve(null);
			const [localProbe, remoteProbe] = await Promise.all([localProbePromise, remoteProbePromise]);
			return guardCancel(await select({
				message: "Where will the Gateway run?",
				options: [{
					value: "local",
					label: "Local (this machine)",
					hint: localProbe.ok ? `Gateway reachable (${localUrl})` : `No gateway detected (${localUrl})`
				}, {
					value: "remote",
					label: "Remote (info-only)",
					hint: !remoteUrl ? "No remote URL configured yet" : remoteProbe?.ok ? `Gateway reachable (${remoteUrl})` : `Configured but unreachable (${remoteUrl})`
				}]
			}), runtime);
		};
		const mode = shouldPromptGatewayRunMode ? await promptGatewayRunMode() : "local";
		const metadataMode = shouldPromptGatewayRunMode || baseConfig.gateway?.mode !== "remote" ? mode : "remote";
		const shouldSkipGatewaySummary = !shouldPromptGatewayRunMode;
		if (shouldPromptGatewayRunMode && mode === "remote") {
			let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
			remoteConfig = applyWizardMetadata(remoteConfig, {
				command: opts.command,
				mode: metadataMode
			});
			remoteConfig = (await commitConfigWithPendingPluginInstalls({
				nextConfig: remoteConfig,
				...currentBaseHash !== void 0 ? { baseHash: currentBaseHash } : {}
			})).config;
			currentBaseHash = void 0;
			logConfigUpdated(runtime);
			outro("Remote gateway configured.");
			return;
		}
		let nextConfig = { ...baseConfig };
		let mergeBaseConfig = structuredClone(baseConfig);
		let didSetGatewayMode = false;
		if (shouldPromptGatewayRunMode && nextConfig.gateway?.mode !== "local") {
			nextConfig = {
				...nextConfig,
				gateway: {
					...nextConfig.gateway,
					mode: "local"
				}
			};
			didSetGatewayMode = true;
		}
		let workspaceDir = nextConfig.agents?.defaults?.workspace ?? baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
		let gatewayPort = resolveGatewayPort(baseConfig);
		const persistConfig = async () => {
			nextConfig = applyWizardMetadata(nextConfig, {
				command: opts.command,
				mode: metadataMode
			});
			const maxRetries = 3;
			for (let attempt = 0; attempt < maxRetries; attempt++) try {
				nextConfig = (await commitConfigWithPendingPluginInstalls({
					nextConfig,
					...currentBaseHash !== void 0 ? { baseHash: currentBaseHash } : {}
				})).config;
				currentBaseHash = (await readConfigFileSnapshot()).hash ?? void 0;
				mergeBaseConfig = structuredClone(nextConfig);
				logConfigUpdated(runtime);
				return;
			} catch (err) {
				if (err instanceof ConfigMutationConflictError && attempt < maxRetries - 1) {
					const freshSnapshot = await readConfigFileSnapshot();
					currentBaseHash = freshSnapshot.hash ?? void 0;
					nextConfig = mergeWizardConfigOntoLatest(freshSnapshot.valid ? freshSnapshot.sourceConfig ?? freshSnapshot.config : {}, mergeBaseConfig, nextConfig);
					continue;
				}
				throw err;
			}
		};
		const configureWorkspace = async () => {
			workspaceDir = resolveUserPath(normalizeOptionalString(guardCancel(await text({
				message: "Workspace directory",
				initialValue: workspaceDir
			}), runtime) ?? "") || DEFAULT_WORKSPACE);
			if (!snapshot.exists) {
				const indicators = [
					"MEMORY.md",
					"memory",
					".git"
				].map((name) => path.join(workspaceDir, name));
				if ((await Promise.all(indicators.map(async (candidate) => {
					try {
						await fs.access(candidate);
						return true;
					} catch {
						return false;
					}
				}))).some(Boolean)) note([`Existing workspace detected at ${workspaceDir}`, "Existing files are preserved. Missing templates may be created, never overwritten."].join("\n"), "Existing workspace");
			}
			nextConfig = {
				...nextConfig,
				agents: {
					...nextConfig.agents,
					defaults: {
						...nextConfig.agents?.defaults,
						workspace: workspaceDir
					}
				}
			};
			await ensureWorkspaceAndSessions(workspaceDir, runtime, {
				skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
				skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles
			});
		};
		const configureChannelsSection = async () => {
			if (await promptChannelMode(runtime) === "configure") nextConfig = await setupChannels(nextConfig, runtime, prompter, {
				allowDisable: true,
				allowSignalInstall: true,
				deferStatusUntilSelection: true,
				skipConfirm: true,
				skipStatusNote: true
			});
			else nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
		};
		const promptDaemonPort = async () => {
			const portInput = guardCancel(await text({
				message: "Gateway port for service install",
				initialValue: String(gatewayPort),
				validate: validateGatewayPortInput
			}), runtime);
			gatewayPort = Number.parseInt(portInput, 10);
		};
		if (selectedSections) {
			const selected = selectedSections;
			if (!selected || selected.length === 0) {
				outro("No configuration changes selected.");
				return;
			}
			if (selected.includes("workspace")) await configureWorkspace();
			if (selected.includes("model")) nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
			if (selected.includes("web")) nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter);
			if (selected.includes("gateway")) {
				const gateway = await promptGatewayConfig(nextConfig, runtime);
				nextConfig = gateway.config;
				gatewayPort = gateway.port;
			}
			if (selected.includes("channels")) await configureChannelsSection();
			if (selected.includes("plugins")) {
				const { configurePluginConfig } = await loadSetupPluginConfigModule();
				nextConfig = await configurePluginConfig({
					config: nextConfig,
					prompter,
					workspaceDir: resolveUserPath(workspaceDir)
				});
			}
			if (selected.includes("skills")) {
				const wsDir = resolveUserPath(workspaceDir);
				nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
			}
			await persistConfig();
			if (selected.includes("daemon")) {
				if (!selected.includes("gateway")) await promptDaemonPort();
				await maybeInstallDaemon({
					runtime,
					port: gatewayPort
				});
			}
			if (selected.includes("health")) await runGatewayHealthCheck({
				cfg: nextConfig,
				runtime,
				port: gatewayPort
			});
		} else {
			let ranSection = false;
			let didConfigureGateway = false;
			while (true) {
				const choice = await promptConfigureSection(runtime, ranSection);
				if (choice === "__continue") break;
				ranSection = true;
				if (choice === "workspace") {
					await configureWorkspace();
					await persistConfig();
				}
				if (choice === "model") {
					nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
					await persistConfig();
				}
				if (choice === "web") {
					nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter);
					await persistConfig();
				}
				if (choice === "gateway") {
					const gateway = await promptGatewayConfig(nextConfig, runtime);
					nextConfig = gateway.config;
					gatewayPort = gateway.port;
					didConfigureGateway = true;
					await persistConfig();
				}
				if (choice === "channels") {
					await configureChannelsSection();
					await persistConfig();
				}
				if (choice === "plugins") {
					const { configurePluginConfig } = await loadSetupPluginConfigModule();
					nextConfig = await configurePluginConfig({
						config: nextConfig,
						prompter,
						workspaceDir: resolveUserPath(workspaceDir)
					});
					await persistConfig();
				}
				if (choice === "skills") {
					const wsDir = resolveUserPath(workspaceDir);
					nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
					await persistConfig();
				}
				if (choice === "daemon") {
					if (!didConfigureGateway) await promptDaemonPort();
					await maybeInstallDaemon({
						runtime,
						port: gatewayPort
					});
				}
				if (choice === "health") await runGatewayHealthCheck({
					cfg: nextConfig,
					runtime,
					port: gatewayPort
				});
			}
			if (!ranSection) {
				if (didSetGatewayMode) {
					await persistConfig();
					outro("Gateway mode set to local.");
					return;
				}
				outro("No configuration changes selected.");
				return;
			}
		}
		if (shouldSkipGatewaySummary) {
			const remoteUrl = normalizeOptionalString(nextConfig.gateway?.remote?.url);
			if (remoteUrl) note([
				"Remote Gateway:",
				remoteUrl,
				"Docs: https://docs.openclaw.ai/gateway/remote"
			].join("\n"), "Gateway");
			outro("Configuration updated.");
			return;
		}
		const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
		if (!controlUiAssets.ok && controlUiAssets.message) runtime.error(controlUiAssets.message);
		const links = resolveControlUiLinks({
			bind: nextConfig.gateway?.bind ?? "loopback",
			port: gatewayPort,
			customBindHost: nextConfig.gateway?.customBindHost,
			basePath: nextConfig.gateway?.controlUi?.basePath,
			tlsEnabled: nextConfig.gateway?.tls?.enabled === true
		});
		const newPassword = process.env.OPENCLAW_GATEWAY_PASSWORD ?? await resolveGatewaySecretInputForWizard({
			cfg: nextConfig,
			value: nextConfig.gateway?.auth?.password,
			path: "gateway.auth.password"
		});
		const oldPassword = process.env.OPENCLAW_GATEWAY_PASSWORD ?? await resolveGatewaySecretInputForWizard({
			cfg: baseConfig,
			value: baseConfig.gateway?.auth?.password,
			path: "gateway.auth.password"
		});
		const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? await resolveGatewaySecretInputForWizard({
			cfg: nextConfig,
			value: nextConfig.gateway?.auth?.token,
			path: "gateway.auth.token"
		});
		let gatewayProbe = await probeGatewayReachable({
			url: links.wsUrl,
			token,
			password: newPassword
		});
		if (!gatewayProbe.ok && newPassword !== oldPassword && oldPassword) gatewayProbe = await probeGatewayReachable({
			url: links.wsUrl,
			token,
			password: oldPassword
		});
		const gatewayStatusLine = gatewayProbe.ok ? "Gateway: reachable" : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
		note([
			`Web UI: ${links.httpUrl}`,
			`Gateway WS: ${links.wsUrl}`,
			gatewayStatusLine,
			"Docs: https://docs.openclaw.ai/web/control-ui"
		].join("\n"), "Control UI");
		outro("Configuration updated.");
	} catch (err) {
		if (err instanceof WizardCancelledError) {
			runtime.exit(1);
			return;
		}
		throw err;
	}
}
//#endregion
//#region src/commands/configure.commands.ts
async function configureCommand(runtime = defaultRuntime) {
	await runConfigureWizard({ command: "configure" }, runtime);
}
async function configureCommandWithSections(sections, runtime = defaultRuntime) {
	await runConfigureWizard({
		command: "configure",
		sections
	}, runtime);
}
async function configureCommandFromSectionsArg(rawSections, runtime = defaultRuntime) {
	const { sections, invalid } = parseConfigureWizardSections(rawSections);
	if (sections.length === 0) {
		await configureCommand(runtime);
		return;
	}
	if (invalid.length > 0) {
		runtime.error(`Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}. Run ${formatCliCommand("openclaw configure")} without --section to use the full wizard.`);
		runtime.exit(1);
		return;
	}
	await configureCommandWithSections(sections, runtime);
}
//#endregion
export { buildGatewayAuthConfig as n, configureCommandFromSectionsArg as t };
