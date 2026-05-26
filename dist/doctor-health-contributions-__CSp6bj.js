import fs from "node:fs";
//#region src/flows/doctor-health-contributions.ts
function isUpdateDoctorRun(env) {
	const value = env.OPENCLAW_UPDATE_IN_PROGRESS;
	return value === "1" || value === "true";
}
function resolveDoctorMode(cfg) {
	return cfg.gateway?.mode === "remote" ? "remote" : "local";
}
const UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV = "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE";
function isTruthyEnvValue(value) {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}
function shouldSkipLegacyUpdateDoctorConfigWrite(params) {
	if (!isTruthyEnvValue(params.env.OPENCLAW_UPDATE_IN_PROGRESS)) return false;
	if (isTruthyEnvValue(params.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV])) return false;
	return true;
}
function createDoctorHealthContribution(params) {
	return {
		id: params.id,
		kind: "core",
		surface: "health",
		option: {
			value: params.id,
			label: params.label,
			...params.hint ? { hint: params.hint } : {}
		},
		source: "doctor",
		run: params.run
	};
}
async function runGatewayConfigHealth(ctx) {
	const { formatCliCommand } = await import("./command-format-oW9EVHvc.js");
	const { hasAmbiguousGatewayAuthModeConfig } = await import("./auth-mode-policy-CMtGOINA.js");
	const { note } = await import("./note-DaLSCwEc.js");
	if (!ctx.cfg.gateway?.mode) {
		const lines = [
			"gateway.mode is unset; gateway start will be blocked.",
			`Fix: run ${formatCliCommand("openclaw configure")} and set Gateway mode (local/remote).`,
			`Or set directly: ${formatCliCommand("openclaw config set gateway.mode local")}`
		];
		if (!fs.existsSync(ctx.configPath)) lines.push(`Missing config: run ${formatCliCommand("openclaw setup")} first.`);
		note(lines.join("\n"), "Gateway");
	}
	if (resolveDoctorMode(ctx.cfg) === "local" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) note([
		"gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset.",
		"Set an explicit mode to avoid ambiguous auth selection and startup/runtime failures.",
		`Set token mode: ${formatCliCommand("openclaw config set gateway.auth.mode token")}`,
		`Set password mode: ${formatCliCommand("openclaw config set gateway.auth.mode password")}`
	].join("\n"), "Gateway auth");
}
async function runAuthProfileHealth(ctx) {
	const { maybeRepairLegacyFlatAuthProfileStores } = await import("./doctor-auth-flat-profiles-DzTFlPe6.js");
	const { maybeRepairLegacyOAuthProfileIds } = await import("./doctor-auth-legacy-oauth-Td7yq0w3.js");
	const { noteAuthProfileHealth, noteLegacyCodexProviderOverride } = await import("./doctor-auth-DykXIJCV.js");
	const { buildGatewayConnectionDetails } = await import("./call-CuKQnsm3.js");
	const { note } = await import("./note-DaLSCwEc.js");
	await maybeRepairLegacyFlatAuthProfileStores({
		cfg: ctx.cfg,
		prompter: ctx.prompter
	});
	ctx.cfg = await maybeRepairLegacyOAuthProfileIds(ctx.cfg, ctx.prompter);
	await noteAuthProfileHealth({
		cfg: ctx.cfg,
		prompter: ctx.prompter,
		allowKeychainPrompt: ctx.options.nonInteractive !== true && process.stdin.isTTY
	});
	noteLegacyCodexProviderOverride(ctx.cfg);
	ctx.gatewayDetails = buildGatewayConnectionDetails({ config: ctx.cfg });
	if (ctx.gatewayDetails.remoteFallbackNote) note(ctx.gatewayDetails.remoteFallbackNote, "Gateway");
}
async function runGatewayAuthHealth(ctx) {
	const { resolveSecretInputRef } = await import("./types.secrets-BaLWVoeB.js");
	const { resolveGatewayAuth } = await import("./auth-pE1F41z6.js");
	const { note } = await import("./note-DaLSCwEc.js");
	const { randomToken } = await import("./onboard-helpers-BvAA6Q5p.js");
	if (resolveDoctorMode(ctx.cfg) !== "local" || !ctx.sourceConfigValid) return;
	const gatewayTokenRef = resolveSecretInputRef({
		value: ctx.cfg.gateway?.auth?.token,
		defaults: ctx.cfg.secrets?.defaults
	}).ref;
	const auth = resolveGatewayAuth({
		authConfig: ctx.cfg.gateway?.auth,
		tailscaleMode: ctx.cfg.gateway?.tailscale?.mode ?? "off"
	});
	if (!(auth.mode !== "password" && auth.mode !== "none" && auth.mode !== "trusted-proxy" && (auth.mode !== "token" || !auth.token))) return;
	if (gatewayTokenRef) {
		note([
			"Gateway token is managed via SecretRef and is currently unavailable.",
			"Doctor will not overwrite gateway.auth.token with a plaintext value.",
			"Resolve/rotate the external secret source, then rerun doctor."
		].join("\n"), "Gateway auth");
		return;
	}
	note("Gateway auth is off or missing a token. Token auth is now the recommended default (including loopback).", "Gateway auth");
	if (!(ctx.options.generateGatewayToken === true ? true : ctx.options.nonInteractive === true ? false : await ctx.prompter.confirmAutoFix({
		message: "Generate and configure a gateway token now?",
		initialValue: true
	}))) return;
	const nextToken = randomToken();
	ctx.cfg = {
		...ctx.cfg,
		gateway: {
			...ctx.cfg.gateway,
			auth: {
				...ctx.cfg.gateway?.auth,
				mode: "token",
				token: nextToken
			}
		}
	};
	note("Gateway token configured.", "Gateway auth");
}
async function runCommandOwnerHealth(ctx) {
	const { noteCommandOwnerHealth } = await import("./doctor-command-owner-_8HIiFF3.js");
	noteCommandOwnerHealth(ctx.cfg);
}
async function runClaudeCliHealth(ctx) {
	const { noteClaudeCliHealth } = await import("./doctor-claude-cli-DKSf6pNG.js");
	noteClaudeCliHealth(ctx.cfg);
}
async function runLegacyStateHealth(ctx) {
	const { detectLegacyStateMigrations, runLegacyStateMigrations } = await import("./doctor-state-migrations-B9TF7Ybk.js");
	const { note } = await import("./note-DaLSCwEc.js");
	const legacyState = await detectLegacyStateMigrations({ cfg: ctx.cfg });
	if (legacyState.preview.length === 0) return;
	note(legacyState.preview.join("\n"), "Legacy state detected");
	if (!(ctx.options.nonInteractive === true ? true : await ctx.prompter.confirm({
		message: "Migrate legacy state (sessions/agent/WhatsApp auth) now?",
		initialValue: true
	}))) return;
	const migrated = await runLegacyStateMigrations({ detected: legacyState });
	if (migrated.changes.length > 0) note(migrated.changes.join("\n"), "Doctor changes");
	if (migrated.warnings.length > 0) note(migrated.warnings.join("\n"), "Doctor warnings");
}
async function runLegacyPluginManifestHealth(ctx) {
	const { maybeRepairLegacyPluginManifestContracts } = await import("./doctor-plugin-manifests-oq3qvCqV.js");
	await maybeRepairLegacyPluginManifestContracts({
		config: ctx.cfg,
		env: process.env,
		runtime: ctx.runtime,
		prompter: ctx.prompter
	});
}
async function runPluginRegistryHealth(ctx) {
	const { maybeRepairPluginRegistryState } = await import("./doctor-plugin-registry-6abjaXH2.js");
	ctx.cfg = await maybeRepairPluginRegistryState({
		config: ctx.cfg,
		env: process.env,
		prompter: ctx.prompter
	});
}
async function runReleaseConfiguredPluginInstallsHealth(ctx) {
	if (!ctx.sourceConfigValid) return;
	if (!ctx.prompter.shouldRepair) return;
	const { maybeRunConfiguredPluginInstallReleaseStep } = await import("./release-configured-plugin-installs-DqpmRyu1.js");
	const { note } = await import("./note-DaLSCwEc.js");
	const { VERSION } = await import("./version-C1-6jjhw.js");
	const result = await maybeRunConfiguredPluginInstallReleaseStep({
		cfg: ctx.cfg,
		env: ctx.env ?? process.env,
		touchedVersion: ctx.configResult.sourceLastTouchedVersion ?? ctx.cfg.meta?.lastTouchedVersion
	});
	if (result.changes.length > 0) note(result.changes.join("\n"), "Doctor changes");
	if (result.warnings.length > 0) note(result.warnings.join("\n"), "Doctor warnings");
	if (!result.touchedConfig) return;
	ctx.cfg = {
		...ctx.cfg,
		meta: {
			...ctx.cfg.meta,
			lastTouchedVersion: VERSION,
			lastTouchedAt: (/* @__PURE__ */ new Date()).toISOString()
		}
	};
}
async function runStateIntegrityHealth(ctx) {
	const { noteStateIntegrity } = await import("./doctor-state-integrity-CntV4M-L.js");
	await noteStateIntegrity(ctx.cfg, ctx.prompter, ctx.configPath);
}
async function runCodexSessionRouteHealth(ctx) {
	const { maybeRepairCodexSessionRoutes } = await import("./codex-route-warnings-CIH7snlE.js");
	const { note } = await import("./note-DaLSCwEc.js");
	const result = await maybeRepairCodexSessionRoutes({
		cfg: ctx.cfg,
		env: ctx.env ?? process.env,
		shouldRepair: ctx.prompter.shouldRepair
	});
	if (result.changes.length > 0) note(result.changes.join("\n"), "Doctor changes");
	if (result.warnings.length > 0) note(result.warnings.join("\n"), "Doctor warnings");
}
async function runSessionLocksHealth(ctx) {
	const { noteSessionLockHealth } = await import("./doctor-session-locks-q31_0iaH.js");
	await noteSessionLockHealth({ shouldRepair: ctx.prompter.shouldRepair });
}
async function runSessionTranscriptsHealth(ctx) {
	const { noteSessionTranscriptHealth } = await import("./doctor-session-transcripts-FP0RrM2v.js");
	await noteSessionTranscriptHealth({ shouldRepair: ctx.prompter.shouldRepair });
}
async function runLegacyCronHealth(ctx) {
	const { maybeRepairLegacyCronStore, noteLegacyWhatsAppCrontabHealthCheck } = await import("./doctor-cron-D1AzExAU.js");
	await noteLegacyWhatsAppCrontabHealthCheck();
	await maybeRepairLegacyCronStore({
		cfg: ctx.cfg,
		options: ctx.options,
		prompter: ctx.prompter
	});
}
async function runSandboxHealth(ctx) {
	const { maybeRepairSandboxImages, maybeRepairSandboxRegistryFiles, noteSandboxScopeWarnings } = await import("./doctor-sandbox-Cja9z3-A.js");
	await maybeRepairSandboxRegistryFiles(ctx.prompter);
	ctx.cfg = await maybeRepairSandboxImages(ctx.cfg, ctx.runtime, ctx.prompter);
	noteSandboxScopeWarnings(ctx.cfg);
}
async function runGatewayServicesHealth(ctx) {
	const { maybeRepairGatewayServiceConfig, maybeScanExtraGatewayServices } = await import("./doctor-gateway-services-nbt145gl.js");
	const { noteMacLaunchAgentOverrides, noteMacLaunchctlGatewayEnvOverrides } = await import("./doctor-platform-notes-CkvhSSth.js");
	await maybeScanExtraGatewayServices(ctx.options, ctx.runtime, ctx.prompter);
	await maybeRepairGatewayServiceConfig(ctx.cfg, resolveDoctorMode(ctx.cfg), ctx.runtime, ctx.prompter);
	await noteMacLaunchAgentOverrides();
	await noteMacLaunchctlGatewayEnvOverrides(ctx.cfg);
}
async function runStartupChannelMaintenanceHealth(ctx) {
	const { maybeRunDoctorStartupChannelMaintenance } = await import("./doctor-startup-channel-maintenance-CFf1w4Ml.js");
	await maybeRunDoctorStartupChannelMaintenance({
		cfg: ctx.cfg,
		env: process.env,
		runtime: ctx.runtime,
		shouldRepair: ctx.prompter.shouldRepair
	});
}
async function runSecurityHealth(ctx) {
	const { noteSecurityWarnings } = await import("./doctor-security-5pIW8p3D.js");
	await noteSecurityWarnings(ctx.cfg);
}
async function runBrowserHealth(ctx) {
	const { noteChromeMcpBrowserReadiness } = await import("./doctor-browser-DONnjsa_.js");
	await noteChromeMcpBrowserReadiness(ctx.cfg);
}
async function runOpenAIOAuthTlsHealth(ctx) {
	const { noteOpenAIOAuthTlsPrerequisites } = await import("./oauth-tls-preflight-CLMT0HnD.js");
	await noteOpenAIOAuthTlsPrerequisites({
		cfg: ctx.cfg,
		deep: ctx.options.deep === true
	});
}
async function runHooksModelHealth(ctx) {
	if (!ctx.cfg.hooks?.gmail?.model?.trim()) return;
	const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await import("./defaults-Cw6d9pik.js");
	const { loadModelCatalog } = await import("./model-catalog-83tjGQaL.js");
	const { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel } = await import("./model-selection-CQDkL4on.js");
	const { note } = await import("./note-DaLSCwEc.js");
	const hooksModelRef = resolveHooksGmailModel({
		cfg: ctx.cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	if (!hooksModelRef) {
		note(`- hooks.gmail.model "${ctx.cfg.hooks.gmail.model}" could not be resolved`, "Hooks");
		return;
	}
	const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
		cfg: ctx.cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const catalog = await loadModelCatalog({ config: ctx.cfg });
	const status = getModelRefStatus({
		cfg: ctx.cfg,
		catalog,
		ref: hooksModelRef,
		defaultProvider,
		defaultModel
	});
	const warnings = [];
	if (!status.allowed) warnings.push(`- hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`);
	if (!status.inCatalog) warnings.push(`- hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`);
	if (warnings.length > 0) note(warnings.join("\n"), "Hooks");
}
async function runSystemdLingerHealth(ctx) {
	if (ctx.options.nonInteractive === true || process.platform !== "linux" || resolveDoctorMode(ctx.cfg) !== "local") return;
	const { resolveGatewayService } = await import("./service-B-s40Yp5.js");
	const { ensureSystemdUserLingerInteractive } = await import("./systemd-linger-wNfr--fO.js");
	const { note } = await import("./note-DaLSCwEc.js");
	const service = resolveGatewayService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch {
		loaded = false;
	}
	if (!loaded) return;
	await ensureSystemdUserLingerInteractive({
		runtime: ctx.runtime,
		prompter: {
			confirm: async (p) => ctx.prompter.confirm(p),
			note
		},
		reason: "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
		requireConfirm: true
	});
}
async function runWorkspaceStatusHealth(ctx) {
	const { noteWorkspaceStatus } = await import("./doctor-workspace-status-CZZXtYta.js");
	noteWorkspaceStatus(ctx.cfg);
}
async function runSkillsHealth(ctx) {
	const { maybeRepairSkillReadiness } = await import("./doctor-skills-DQ8UTM7P.js");
	ctx.cfg = await maybeRepairSkillReadiness({
		cfg: ctx.cfg,
		prompter: ctx.prompter
	});
}
async function runBootstrapSizeHealth(ctx) {
	const { noteBootstrapFileSize } = await import("./doctor-bootstrap-size-GeS-HLOQ.js");
	await noteBootstrapFileSize(ctx.cfg);
}
async function runShellCompletionHealth(ctx) {
	const { doctorShellCompletion } = await import("./doctor-completion-okZad2Q9.js");
	await doctorShellCompletion(ctx.runtime, ctx.prompter, { nonInteractive: ctx.options.nonInteractive });
}
async function runGatewayHealthChecks(ctx) {
	const { checkGatewayHealth, probeGatewayMemoryStatus } = await import("./doctor-gateway-health-PMaWEYuP.js");
	const { healthOk, status } = await checkGatewayHealth({
		runtime: ctx.runtime,
		cfg: ctx.cfg,
		timeoutMs: ctx.options.nonInteractive === true ? 3e3 : 1e4
	});
	ctx.healthOk = healthOk;
	ctx.gatewayStatus = status;
	ctx.gatewayMemoryProbe = healthOk ? await probeGatewayMemoryStatus({
		cfg: ctx.cfg,
		timeoutMs: ctx.options.nonInteractive === true ? 3e3 : 1e4
	}) : {
		checked: false,
		ready: false,
		skipped: false
	};
}
async function runWhatsappResponsivenessHealth(ctx) {
	const { noteWhatsappResponsivenessHealth } = await import("./doctor-whatsapp-responsiveness-D3a96pOe.js");
	await noteWhatsappResponsivenessHealth({
		cfg: ctx.cfg,
		status: ctx.gatewayStatus,
		shouldRepair: ctx.prompter.shouldRepair
	});
}
async function runMemorySearchHealthContribution(ctx) {
	const { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth, noteMemorySearchHealth } = await import("./doctor-memory-search-97_fMWdl.js");
	if (ctx.prompter.shouldRepair) await maybeRepairMemoryRecallHealth({
		cfg: ctx.cfg,
		prompter: ctx.prompter
	});
	await noteMemorySearchHealth(ctx.cfg, { gatewayMemoryProbe: ctx.gatewayMemoryProbe ?? {
		checked: false,
		ready: false,
		skipped: false
	} });
	if (ctx.options.deep === true) await noteMemoryRecallHealth(ctx.cfg);
}
async function runDevicePairingHealth(ctx) {
	const { noteDevicePairingHealth } = await import("./doctor-device-pairing-BASwdQ87.js");
	await noteDevicePairingHealth({
		cfg: ctx.cfg,
		healthOk: ctx.healthOk ?? false
	});
}
async function runGatewayDaemonHealth(ctx) {
	const { maybeRepairGatewayDaemon } = await import("./doctor-gateway-daemon-flow-CTcwT-8m.js");
	await maybeRepairGatewayDaemon({
		cfg: ctx.cfg,
		runtime: ctx.runtime,
		prompter: ctx.prompter,
		options: ctx.options,
		gatewayDetailsMessage: ctx.gatewayDetails?.message ?? "",
		healthOk: ctx.healthOk ?? false
	});
}
async function runWriteConfigHealth(ctx) {
	const { formatCliCommand } = await import("./command-format-oW9EVHvc.js");
	const { applyWizardMetadata } = await import("./onboard-helpers-BvAA6Q5p.js");
	const { replaceConfigFile } = await import("./config/config.js");
	const { logConfigUpdated } = await import("./logging-Dsi2ZWYP.js");
	const { shortenHomePath } = await import("./utils-Dhe1Vaw_.js");
	if (ctx.configResult.shouldWriteConfig || JSON.stringify(ctx.cfg) !== JSON.stringify(ctx.cfgForPersistence)) {
		const updateDoctorRun = isUpdateDoctorRun(ctx.env ?? process.env);
		ctx.cfg = applyWizardMetadata(ctx.cfg, {
			command: "doctor",
			mode: resolveDoctorMode(ctx.cfg)
		});
		if (shouldSkipLegacyUpdateDoctorConfigWrite({ env: ctx.env ?? process.env })) {
			ctx.runtime.log("Skipping doctor config write during legacy update handoff.");
			return;
		}
		await replaceConfigFile({
			nextConfig: ctx.cfg,
			afterWrite: { mode: "auto" },
			writeOptions: {
				allowConfigSizeDrop: ctx.configResult.shouldWriteConfig === true || updateDoctorRun,
				skipPluginValidation: ctx.configResult.skipPluginValidationOnWrite === true
			}
		});
		logConfigUpdated(ctx.runtime);
		const preUpdateSnapshotPath = `${ctx.configPath}.pre-update`;
		if (updateDoctorRun && fs.existsSync(preUpdateSnapshotPath)) ctx.runtime.log(`Update changed config; pre-update backup: ${shortenHomePath(preUpdateSnapshotPath)}`);
		const backupPath = `${ctx.configPath}.bak`;
		if (fs.existsSync(backupPath)) ctx.runtime.log(`Backup: ${shortenHomePath(backupPath)}`);
		return;
	}
	if (!ctx.prompter.shouldRepair) ctx.runtime.log(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply changes.`);
}
async function runWorkspaceSuggestionsHealth(ctx) {
	if (ctx.options.workspaceSuggestions === false) return;
	const { resolveAgentWorkspaceDir, resolveDefaultAgentId } = await import("./agent-scope-DMAwaA81.js");
	const { noteWorkspaceBackupTip } = await import("./doctor-state-integrity-CntV4M-L.js");
	const { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } = await import("./doctor-workspace-BjlI1EqJ.js");
	const { note } = await import("./note-DaLSCwEc.js");
	const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
	noteWorkspaceBackupTip(workspaceDir);
	if (await shouldSuggestMemorySystem(workspaceDir)) note(MEMORY_SYSTEM_PROMPT, "Workspace");
}
async function runFinalConfigValidationHealth(_ctx) {
	const { readConfigFileSnapshot } = await import("./config/config.js");
	const finalSnapshot = await readConfigFileSnapshot();
	if (finalSnapshot.exists && !finalSnapshot.valid) {
		_ctx.runtime.error("Invalid config:");
		for (const issue of finalSnapshot.issues) {
			const path = issue.path || "<root>";
			_ctx.runtime.error(`- ${path}: ${issue.message}`);
		}
	}
}
function resolveDoctorHealthContributions() {
	return [
		createDoctorHealthContribution({
			id: "doctor:gateway-config",
			label: "Gateway config",
			run: runGatewayConfigHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:auth-profiles",
			label: "Auth profiles",
			run: runAuthProfileHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:claude-cli",
			label: "Claude CLI",
			run: runClaudeCliHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:gateway-auth",
			label: "Gateway auth",
			run: runGatewayAuthHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:command-owner",
			label: "Command owner",
			run: runCommandOwnerHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:legacy-state",
			label: "Legacy state",
			run: runLegacyStateHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:legacy-plugin-manifests",
			label: "Legacy plugin manifests",
			run: runLegacyPluginManifestHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:release-configured-plugin-installs",
			label: "Configured plugin repair",
			run: runReleaseConfiguredPluginInstallsHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:plugin-registry",
			label: "Plugin registry",
			run: runPluginRegistryHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:state-integrity",
			label: "State integrity",
			run: runStateIntegrityHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:codex-session-routes",
			label: "Codex session routes",
			run: runCodexSessionRouteHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:session-locks",
			label: "Session locks",
			run: runSessionLocksHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:session-transcripts",
			label: "Session transcripts",
			run: runSessionTranscriptsHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:legacy-cron",
			label: "Legacy cron",
			run: runLegacyCronHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:sandbox",
			label: "Sandbox",
			run: runSandboxHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:gateway-services",
			label: "Gateway services",
			run: runGatewayServicesHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:startup-channel-maintenance",
			label: "Startup channel maintenance",
			run: runStartupChannelMaintenanceHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:security",
			label: "Security",
			run: runSecurityHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:browser",
			label: "Browser",
			run: runBrowserHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:oauth-tls",
			label: "OAuth TLS",
			run: runOpenAIOAuthTlsHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:hooks-model",
			label: "Hooks model",
			run: runHooksModelHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:systemd-linger",
			label: "systemd linger",
			run: runSystemdLingerHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:workspace-status",
			label: "Workspace status",
			run: runWorkspaceStatusHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:skills",
			label: "Skills",
			run: runSkillsHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:bootstrap-size",
			label: "Bootstrap size",
			run: runBootstrapSizeHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:shell-completion",
			label: "Shell completion",
			run: runShellCompletionHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:gateway-health",
			label: "Gateway health",
			run: runGatewayHealthChecks
		}),
		createDoctorHealthContribution({
			id: "doctor:whatsapp-responsiveness",
			label: "WhatsApp responsiveness",
			run: runWhatsappResponsivenessHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:memory-search",
			label: "Memory search",
			run: runMemorySearchHealthContribution
		}),
		createDoctorHealthContribution({
			id: "doctor:device-pairing",
			label: "Device pairing",
			run: runDevicePairingHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:gateway-daemon",
			label: "Gateway daemon",
			run: runGatewayDaemonHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:write-config",
			label: "Write config",
			run: runWriteConfigHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:workspace-suggestions",
			label: "Workspace suggestions",
			run: runWorkspaceSuggestionsHealth
		}),
		createDoctorHealthContribution({
			id: "doctor:final-config-validation",
			label: "Final config validation",
			run: runFinalConfigValidationHealth
		})
	];
}
async function runDoctorHealthContributions(ctx) {
	for (const contribution of resolveDoctorHealthContributions()) await contribution.run(ctx);
}
//#endregion
export { runDoctorHealthContributions };
