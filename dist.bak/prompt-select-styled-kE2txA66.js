import { $t as resolveStateDir, Jt as resolveIsNixMode, Rt as CONFIG_PATH, Zt as resolveOAuthDir, dt as sleep, jt as getResolvedLoggerSettings, qt as resolveGatewayPort, r as isTruthyEnvValue, st as resolveUserPath, ut as shortenHomePath, v as defaultRuntime, yn as resolveRequiredHomeDir } from "./entry.js";
import { $r as DEFAULT_PROVIDER, Dr as resolveApiKeyForProvider, Fn as getModelRefStatus, Gn as resolveConfiguredModelRef, L as writeConfigFile, N as readConfigFileSnapshot, Qr as DEFAULT_MODEL, bn as ensureAuthProfileStore, fn as repairOAuthProfileIdMismatch, l as resolveApiKeyForProfile, ni as CODEX_CLI_PROFILE_ID, qn as resolveHooksGmailModel, s as resolveProfileUnusableUntilForDisplay, ti as CLAUDE_CLI_PROFILE_ID, wn as updateAuthProfileStoreWithLock } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { a as resolveAgentDir, d as resolveDefaultAgentId, g as DEFAULT_AGENTS_FILENAME, u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";
import { w as parseAgentSessionKey } from "./session-key-qmb11-mH.js";
import { t as resolveOpenClawPackageRoot } from "./openclaw-root-C9tYgTzw.js";
import { n as runExec, t as runCommandWithTimeout } from "./exec-BhaMholX.js";
import { t as buildWorkspaceSkillStatus } from "./skills-status-8UINyTAE.js";
import { B as cleanStaleLockFiles, at as formatSessionArchiveTimestamp, c as loadSessionStore, ot as isPrimarySessionTranscriptFileName, tt as resolveMainSessionKey } from "./sessions-B8Y6oyPb.js";
import { n as listChannelPlugins } from "./plugins-BOmV0yTv.js";
import { Vn as resolveAgentSessionDirs, _ as loadOpenClawPlugins, en as DEFAULT_OAUTH_WARN_MS, nn as formatRemainingShort, tn as buildAuthHealthSummary } from "./subagent-registry-BrzwRDvR.js";
import { c as resolveSessionTranscriptsDirForAgent, i as resolveSessionFilePathOptions, l as resolveStorePath, r as resolveSessionFilePath } from "./paths-DWsXK0S0.js";
import { n as callGateway, t as buildGatewayConnectionDetails } from "./call-D6IYi30Z.js";
import { r as isLoopbackHost, u as resolveGatewayBindHost } from "./net-DBrsyv8q.js";
import { D as DEFAULT_SANDBOX_COMMON_IMAGE, E as DEFAULT_SANDBOX_BROWSER_IMAGE, O as DEFAULT_SANDBOX_IMAGE, p as resolveSandboxScope } from "./sandbox-COrmfGkR.js";
import { a as resolveGatewayAuth } from "./auth-ML-4Xoce.js";
import { n as inspectPortUsage, o as formatPortDiagnostics } from "./ports-B9YOEPbT.js";
import { i as resolveMemoryBackendConfig } from "./memory-cli-B3-7mJVU.js";
import { n as resolveMemorySearchConfig } from "./manager-g3ZxmKKX.js";
import { n as loadModelCatalog } from "./model-catalog-Def_bWVq.js";
import { f as resolveGatewaySystemdServiceName, h as resolveNodeLaunchAgentLabel, l as resolveGatewayLaunchAgentLabel, p as resolveGatewayWindowsTaskName } from "./constants-ChJK8ZR-.js";
import { l as resolveDmAllowState } from "./pi-tools.policy-B6ojB03j.js";
import { r as isWSLEnv, t as isWSL } from "./wsl-D9-kubbW.js";
import { h as randomToken, n as applyWizardMetadata, p as printWizardHeader, s as guardCancel } from "./onboard-helpers-CijgoJ1t.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-wsroINzm.js";
import { t as note$1 } from "./note-DQ26Rw8p.js";
import { t as collectChannelStatusIssues } from "./channels-status-issues-B7OIB1_v.js";
import { d as resolveSystemNodeInfo, l as renderSystemNodeWarning, n as gatewayInstallErrorHint, t as buildGatewayInstallPlan } from "./daemon-install-helpers-BmM-3-iQ.js";
import { n as GATEWAY_DAEMON_RUNTIME_OPTIONS, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-CeI4hRxg.js";
import { l as uninstallLegacySystemdUnits, r as isSystemdUserServiceAvailable } from "./systemd-BGQw1gQz.js";
import { a as launchAgentPlistExists, i as isLaunchAgentLoaded, o as repairLaunchAgentBootstrap, r as isLaunchAgentListed, s as resolveGatewayLogPaths, t as resolveGatewayService } from "./service-BYZQINUW.js";
import { i as auditGatewayServiceConfig, n as renderSystemdUnavailableHints, o as needsNodeRuntimeMigration, r as SERVICE_AUDIT_CODES, s as formatRuntimeStatus, t as isSystemdUnavailableDetail } from "./systemd-hints-KijFM7Yo.js";
import { t as readLastGatewayErrorLine } from "./diagnostics-BPWQAMsI.js";
import { n as renderGatewayServiceCleanupHints, t as findExtraGatewayServices } from "./inspect-CQR0rYpF.js";
import { r as healthCommand } from "./health-CXtv23mt.js";
import { n as resolveControlUiDistIndexHealth, r as resolveControlUiDistIndexPathForRoot } from "./control-ui-assets-D-OQDxpR.js";
import { t as resolveDefaultChannelAccountContext } from "./channel-account-context-CvN7490K.js";
import { t as runGatewayUpdate } from "./update-runner-pUL_71nf.js";
import { n as logConfigUpdated } from "./logging-Bi2fXy2a.js";
import { n as detectLegacyStateMigrations, r as runLegacyStateMigrations, t as loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow-COa-e58k.js";
import { t as ensureSystemdUserLingerInteractive } from "./systemd-linger-t4d3T44e.js";
import { t as formatHealthCheckFailure } from "./health-format-D9a_VD-0.js";
import { n as doctorShellCompletion } from "./doctor-completion-DvV-lvKq.js";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { promisify } from "node:util";
import fs$1 from "node:fs/promises";
import { confirm, intro, outro, select } from "@clack/prompts";

//#region src/commands/doctor-auth.ts
async function maybeRepairAnthropicOAuthProfileId(cfg, prompter) {
	const repair = repairOAuthProfileIdMismatch({
		cfg,
		store: ensureAuthProfileStore(),
		provider: "anthropic",
		legacyProfileId: "anthropic:default"
	});
	if (!repair.migrated || repair.changes.length === 0) return cfg;
	note$1(repair.changes.map((c) => `- ${c}`).join("\n"), "Auth profiles");
	if (!await prompter.confirm({
		message: "Update Anthropic OAuth profile id in config now?",
		initialValue: true
	})) return cfg;
	return repair.config;
}
function pruneAuthOrder(order, profileIds) {
	if (!order) return {
		next: order,
		changed: false
	};
	let changed = false;
	const next = {};
	for (const [provider, list] of Object.entries(order)) {
		const filtered = list.filter((id) => !profileIds.has(id));
		if (filtered.length !== list.length) changed = true;
		if (filtered.length > 0) next[provider] = filtered;
	}
	return {
		next: Object.keys(next).length > 0 ? next : void 0,
		changed
	};
}
function pruneAuthProfiles(cfg, profileIds) {
	const profiles = cfg.auth?.profiles;
	const order = cfg.auth?.order;
	const nextProfiles = profiles ? { ...profiles } : void 0;
	let changed = false;
	if (nextProfiles) {
		for (const id of profileIds) if (id in nextProfiles) {
			delete nextProfiles[id];
			changed = true;
		}
	}
	const prunedOrder = pruneAuthOrder(order, profileIds);
	if (prunedOrder.changed) changed = true;
	if (!changed) return {
		next: cfg,
		changed: false
	};
	const nextAuth = nextProfiles || prunedOrder.next ? {
		...cfg.auth,
		profiles: nextProfiles && Object.keys(nextProfiles).length > 0 ? nextProfiles : void 0,
		order: prunedOrder.next
	} : void 0;
	return {
		next: {
			...cfg,
			auth: nextAuth
		},
		changed: true
	};
}
async function maybeRemoveDeprecatedCliAuthProfiles(cfg, prompter) {
	const store = ensureAuthProfileStore(void 0, { allowKeychainPrompt: false });
	const deprecated = /* @__PURE__ */ new Set();
	if (store.profiles[CLAUDE_CLI_PROFILE_ID] || cfg.auth?.profiles?.[CLAUDE_CLI_PROFILE_ID]) deprecated.add(CLAUDE_CLI_PROFILE_ID);
	if (store.profiles[CODEX_CLI_PROFILE_ID] || cfg.auth?.profiles?.[CODEX_CLI_PROFILE_ID]) deprecated.add(CODEX_CLI_PROFILE_ID);
	if (deprecated.size === 0) return cfg;
	const lines = ["Deprecated external CLI auth profiles detected (no longer supported):"];
	if (deprecated.has(CLAUDE_CLI_PROFILE_ID)) lines.push(`- ${CLAUDE_CLI_PROFILE_ID} (Anthropic): use setup-token → ${formatCliCommand("openclaw models auth setup-token")}`);
	if (deprecated.has(CODEX_CLI_PROFILE_ID)) lines.push(`- ${CODEX_CLI_PROFILE_ID} (OpenAI Codex): use OAuth → ${formatCliCommand("openclaw models auth login --provider openai-codex")}`);
	note$1(lines.join("\n"), "Auth profiles");
	if (!await prompter.confirmRepair({
		message: "Remove deprecated CLI auth profiles now?",
		initialValue: true
	})) return cfg;
	await updateAuthProfileStoreWithLock({ updater: (nextStore) => {
		let mutated = false;
		for (const id of deprecated) {
			if (nextStore.profiles[id]) {
				delete nextStore.profiles[id];
				mutated = true;
			}
			if (nextStore.usageStats?.[id]) {
				delete nextStore.usageStats[id];
				mutated = true;
			}
		}
		if (nextStore.order) for (const [provider, list] of Object.entries(nextStore.order)) {
			const filtered = list.filter((id) => !deprecated.has(id));
			if (filtered.length !== list.length) {
				mutated = true;
				if (filtered.length > 0) nextStore.order[provider] = filtered;
				else delete nextStore.order[provider];
			}
		}
		if (nextStore.lastGood) {
			for (const [provider, profileId] of Object.entries(nextStore.lastGood)) if (deprecated.has(profileId)) {
				delete nextStore.lastGood[provider];
				mutated = true;
			}
		}
		return mutated;
	} });
	const pruned = pruneAuthProfiles(cfg, deprecated);
	if (pruned.changed) note$1(Array.from(deprecated.values()).map((id) => `- removed ${id} from config`).join("\n"), "Doctor changes");
	return pruned.next;
}
function resolveUnusableProfileHint(params) {
	if (params.kind === "disabled") {
		if (params.reason === "billing") return "Top up credits (provider billing) or switch provider.";
		if (params.reason === "auth_permanent" || params.reason === "auth") return "Refresh or replace credentials, then retry.";
	}
	return "Wait for cooldown or switch provider.";
}
function formatAuthIssueHint(issue) {
	if (issue.provider === "anthropic" && issue.profileId === CLAUDE_CLI_PROFILE_ID) return `Deprecated profile. Use ${formatCliCommand("openclaw models auth setup-token")} or ${formatCliCommand("openclaw configure")}.`;
	if (issue.provider === "openai-codex" && issue.profileId === CODEX_CLI_PROFILE_ID) return `Deprecated profile. Use ${formatCliCommand("openclaw models auth login --provider openai-codex")} or ${formatCliCommand("openclaw configure")}.`;
	return `Re-auth via \`${formatCliCommand("openclaw configure")}\` or \`${formatCliCommand("openclaw onboard")}\`.`;
}
function formatAuthIssueLine(issue) {
	const remaining = issue.remainingMs !== void 0 ? ` (${formatRemainingShort(issue.remainingMs)})` : "";
	const hint = formatAuthIssueHint(issue);
	return `- ${issue.profileId}: ${issue.status}${remaining}${hint ? ` — ${hint}` : ""}`;
}
async function noteAuthProfileHealth(params) {
	const store = ensureAuthProfileStore(void 0, { allowKeychainPrompt: params.allowKeychainPrompt });
	const unusable = (() => {
		const now = Date.now();
		const out = [];
		for (const profileId of Object.keys(store.usageStats ?? {})) {
			const until = resolveProfileUnusableUntilForDisplay(store, profileId);
			if (!until || now >= until) continue;
			const stats = store.usageStats?.[profileId];
			const remaining = formatRemainingShort(until - now);
			const disabledActive = typeof stats?.disabledUntil === "number" && now < stats.disabledUntil;
			const kind = disabledActive ? `disabled${stats.disabledReason ? `:${stats.disabledReason}` : ""}` : "cooldown";
			const hint = resolveUnusableProfileHint({
				kind: disabledActive ? "disabled" : "cooldown",
				reason: stats?.disabledReason
			});
			out.push(`- ${profileId}: ${kind} (${remaining})${hint ? ` — ${hint}` : ""}`);
		}
		return out;
	})();
	if (unusable.length > 0) note$1(unusable.join("\n"), "Auth profile cooldowns");
	let summary = buildAuthHealthSummary({
		store,
		cfg: params.cfg,
		warnAfterMs: DEFAULT_OAUTH_WARN_MS
	});
	const findIssues = () => summary.profiles.filter((profile) => (profile.type === "oauth" || profile.type === "token") && (profile.status === "expired" || profile.status === "expiring" || profile.status === "missing"));
	let issues = findIssues();
	if (issues.length === 0) return;
	if (await params.prompter.confirmRepair({
		message: "Refresh expiring OAuth tokens now? (static tokens need re-auth)",
		initialValue: true
	})) {
		const refreshTargets = issues.filter((issue) => issue.type === "oauth" && [
			"expired",
			"expiring",
			"missing"
		].includes(issue.status));
		const errors = [];
		for (const profile of refreshTargets) try {
			await resolveApiKeyForProfile({
				cfg: params.cfg,
				store,
				profileId: profile.profileId
			});
		} catch (err) {
			errors.push(`- ${profile.profileId}: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (errors.length > 0) note$1(errors.join("\n"), "OAuth refresh errors");
		summary = buildAuthHealthSummary({
			store: ensureAuthProfileStore(void 0, { allowKeychainPrompt: false }),
			cfg: params.cfg,
			warnAfterMs: DEFAULT_OAUTH_WARN_MS
		});
		issues = findIssues();
	}
	if (issues.length > 0) note$1(issues.map((issue) => formatAuthIssueLine({
		profileId: issue.profileId,
		provider: issue.provider,
		status: issue.status,
		remainingMs: issue.remainingMs
	})).join("\n"), "Model auth");
}

//#endregion
//#region src/commands/doctor-format.ts
function formatGatewayRuntimeSummary(runtime) {
	return formatRuntimeStatus(runtime);
}
function buildGatewayRuntimeHints(runtime, options = {}) {
	const hints = [];
	if (!runtime) return hints;
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const fileLog = (() => {
		try {
			return getResolvedLoggerSettings().file;
		} catch {
			return null;
		}
	})();
	if (platform === "linux" && isSystemdUnavailableDetail(runtime.detail)) {
		hints.push(...renderSystemdUnavailableHints({ wsl: isWSLEnv() }));
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		return hints;
	}
	if (runtime.cachedLabel && platform === "darwin") {
		const label = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
		hints.push(`LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${label}`);
		hints.push(`Then reinstall: ${formatCliCommand("openclaw gateway install", env)}`);
	}
	if (runtime.missingUnit) {
		hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		return hints;
	}
	if (runtime.status === "stopped") {
		hints.push("Service is loaded but not running (likely exited immediately).");
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		if (platform === "darwin") {
			const logs = resolveGatewayLogPaths(env);
			hints.push(`Launchd stdout (if installed): ${logs.stdoutPath}`);
			hints.push(`Launchd stderr (if installed): ${logs.stderrPath}`);
		} else if (platform === "linux") {
			const unit = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
			hints.push(`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`);
		} else if (platform === "win32") {
			const task = resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
			hints.push(`Logs: schtasks /Query /TN "${task}" /V /FO LIST`);
		}
	}
	return hints;
}

//#endregion
//#region src/commands/doctor-gateway-daemon-flow.ts
async function maybeRepairLaunchAgentBootstrap(params) {
	if (process.platform !== "darwin") return false;
	if (!await isLaunchAgentListed({ env: params.env })) return false;
	if (await isLaunchAgentLoaded({ env: params.env })) return false;
	if (!await launchAgentPlistExists(params.env)) return false;
	note$1("LaunchAgent is listed but not loaded in launchd.", `${params.title} LaunchAgent`);
	if (!await params.prompter.confirmSkipInNonInteractive({
		message: `Repair ${params.title} LaunchAgent bootstrap now?`,
		initialValue: true
	})) return false;
	params.runtime.log(`Bootstrapping ${params.title} LaunchAgent...`);
	const repair = await repairLaunchAgentBootstrap({ env: params.env });
	if (!repair.ok) {
		params.runtime.error(`${params.title} LaunchAgent bootstrap failed: ${repair.detail ?? "unknown error"}`);
		return false;
	}
	if (!await isLaunchAgentLoaded({ env: params.env })) {
		params.runtime.error(`${params.title} LaunchAgent still not loaded after repair.`);
		return false;
	}
	note$1(`${params.title} LaunchAgent repaired.`, `${params.title} LaunchAgent`);
	return true;
}
async function maybeRepairGatewayDaemon(params) {
	if (params.healthOk) return;
	const service = resolveGatewayService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch {
		loaded = false;
	}
	let serviceRuntime;
	if (loaded) serviceRuntime = await service.readRuntime(process.env).catch(() => void 0);
	if (process.platform === "darwin" && params.cfg.gateway?.mode !== "remote") {
		const gatewayRepaired = await maybeRepairLaunchAgentBootstrap({
			env: process.env,
			title: "Gateway",
			runtime: params.runtime,
			prompter: params.prompter
		});
		await maybeRepairLaunchAgentBootstrap({
			env: {
				...process.env,
				OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel()
			},
			title: "Node",
			runtime: params.runtime,
			prompter: params.prompter
		});
		if (gatewayRepaired) {
			loaded = await service.isLoaded({ env: process.env });
			if (loaded) serviceRuntime = await service.readRuntime(process.env).catch(() => void 0);
		}
	}
	if (params.cfg.gateway?.mode !== "remote") {
		const diagnostics = await inspectPortUsage(resolveGatewayPort(params.cfg, process.env));
		if (diagnostics.status === "busy") note$1(formatPortDiagnostics(diagnostics).join("\n"), "Gateway port");
		else if (loaded && serviceRuntime?.status === "running") {
			const lastError = await readLastGatewayErrorLine(process.env);
			if (lastError) note$1(`Last gateway error: ${lastError}`, "Gateway");
		}
	}
	if (!loaded) {
		if (process.platform === "linux") {
			if (!await isSystemdUserServiceAvailable().catch(() => false)) {
				note$1(renderSystemdUnavailableHints({ wsl: await isWSL() }).join("\n"), "Gateway");
				return;
			}
		}
		note$1("Gateway service not installed.", "Gateway");
		if (params.cfg.gateway?.mode !== "remote") {
			if (await params.prompter.confirmSkipInNonInteractive({
				message: "Install gateway service now?",
				initialValue: true
			})) {
				const daemonRuntime = await params.prompter.select({
					message: "Gateway service runtime",
					options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
					initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME
				}, DEFAULT_GATEWAY_DAEMON_RUNTIME);
				const port = resolveGatewayPort(params.cfg, process.env);
				const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
					env: process.env,
					port,
					token: params.cfg.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
					runtime: daemonRuntime,
					warn: (message, title) => note$1(message, title),
					config: params.cfg
				});
				try {
					await service.install({
						env: process.env,
						stdout: process.stdout,
						programArguments,
						workingDirectory,
						environment
					});
				} catch (err) {
					note$1(`Gateway service install failed: ${String(err)}`, "Gateway");
					note$1(gatewayInstallErrorHint(), "Gateway");
				}
			}
		}
		return;
	}
	const summary = formatGatewayRuntimeSummary(serviceRuntime);
	const hints = buildGatewayRuntimeHints(serviceRuntime, {
		platform: process.platform,
		env: process.env
	});
	if (summary || hints.length > 0) {
		const lines = [];
		if (summary) lines.push(`Runtime: ${summary}`);
		lines.push(...hints);
		note$1(lines.join("\n"), "Gateway");
	}
	if (serviceRuntime?.status !== "running") {
		if (await params.prompter.confirmSkipInNonInteractive({
			message: "Start gateway service now?",
			initialValue: true
		})) {
			await service.restart({
				env: process.env,
				stdout: process.stdout
			});
			await sleep(1500);
		}
	}
	if (process.platform === "darwin") {
		const label = resolveGatewayLaunchAgentLabel(process.env.OPENCLAW_PROFILE);
		note$1(`LaunchAgent loaded; stopping requires "${formatCliCommand("openclaw gateway stop")}" or launchctl bootout gui/$UID/${label}.`, "Gateway");
	}
	if (serviceRuntime?.status === "running") {
		if (await params.prompter.confirmSkipInNonInteractive({
			message: "Restart gateway service now?",
			initialValue: true
		})) {
			await service.restart({
				env: process.env,
				stdout: process.stdout
			});
			await sleep(1500);
			try {
				await healthCommand({
					json: false,
					timeoutMs: 1e4
				}, params.runtime);
			} catch (err) {
				if (String(err).includes("gateway closed")) {
					note$1("Gateway not running.", "Gateway");
					note$1(params.gatewayDetailsMessage, "Gateway connection");
				} else params.runtime.error(formatHealthCheckFailure(err));
			}
		}
	}
}

//#endregion
//#region src/commands/doctor-gateway-health.ts
async function checkGatewayHealth(params) {
	const gatewayDetails = buildGatewayConnectionDetails({ config: params.cfg });
	const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 1e4;
	let healthOk = false;
	try {
		await healthCommand({
			json: false,
			timeoutMs,
			config: params.cfg
		}, params.runtime);
		healthOk = true;
	} catch (err) {
		if (String(err).includes("gateway closed")) {
			note$1("Gateway not running.", "Gateway");
			note$1(gatewayDetails.message, "Gateway connection");
		} else params.runtime.error(formatHealthCheckFailure(err));
	}
	if (healthOk) try {
		const issues = collectChannelStatusIssues(await callGateway({
			method: "channels.status",
			params: {
				probe: true,
				timeoutMs: 5e3
			},
			timeoutMs: 6e3
		}));
		if (issues.length > 0) note$1(issues.map((issue) => `- ${issue.channel} ${issue.accountId}: ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`).join("\n"), "Channel warnings");
	} catch {}
	return { healthOk };
}
async function probeGatewayMemoryStatus(params) {
	const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 8e3;
	try {
		const payload = await callGateway({
			method: "doctor.memory.status",
			timeoutMs,
			config: params.cfg
		});
		return {
			checked: true,
			ready: payload.embedding.ok,
			error: payload.embedding.error
		};
	} catch (err) {
		return {
			checked: true,
			ready: false,
			error: `gateway memory probe unavailable: ${err instanceof Error ? err.message : String(err)}`
		};
	}
}

//#endregion
//#region src/commands/doctor-gateway-services.ts
const execFileAsync$1 = promisify(execFile);
function detectGatewayRuntime(programArguments) {
	const first = programArguments?.[0];
	if (first) {
		const base = path.basename(first).toLowerCase();
		if (base === "bun" || base === "bun.exe") return "bun";
		if (base === "node" || base === "node.exe") return "node";
	}
	return DEFAULT_GATEWAY_DAEMON_RUNTIME;
}
function findGatewayEntrypoint(programArguments) {
	if (!programArguments || programArguments.length === 0) return null;
	const gatewayIndex = programArguments.indexOf("gateway");
	if (gatewayIndex <= 0) return null;
	return programArguments[gatewayIndex - 1] ?? null;
}
function normalizeExecutablePath(value) {
	return path.resolve(value);
}
function resolveGatewayAuthToken(cfg, env) {
	const configToken = cfg.gateway?.auth?.token?.trim();
	if (configToken) return configToken;
	return (env.OPENCLAW_GATEWAY_TOKEN ?? env.CLAWDBOT_GATEWAY_TOKEN)?.trim() || void 0;
}
function extractDetailPath(detail, prefix) {
	if (!detail.startsWith(prefix)) return null;
	const value = detail.slice(prefix.length).trim();
	return value.length > 0 ? value : null;
}
async function cleanupLegacyLaunchdService(params) {
	await execFileAsync$1("launchctl", [
		"bootout",
		typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501",
		params.plistPath
	]).catch(() => void 0);
	await execFileAsync$1("launchctl", ["unload", params.plistPath]).catch(() => void 0);
	const trashDir = path.join(os.homedir(), ".Trash");
	try {
		await fs$1.mkdir(trashDir, { recursive: true });
	} catch {}
	try {
		await fs$1.access(params.plistPath);
	} catch {
		return null;
	}
	const dest = path.join(trashDir, `${params.label}-${Date.now()}.plist`);
	try {
		await fs$1.rename(params.plistPath, dest);
		return dest;
	} catch {
		return null;
	}
}
function classifyLegacyServices(legacyServices) {
	const darwinUserServices = [];
	const linuxUserServices = [];
	const failed = [];
	for (const svc of legacyServices) {
		if (svc.platform === "darwin") {
			if (svc.scope === "user") darwinUserServices.push(svc);
			else failed.push(`${svc.label} (${svc.scope})`);
			continue;
		}
		if (svc.platform === "linux") {
			if (svc.scope === "user") linuxUserServices.push(svc);
			else failed.push(`${svc.label} (${svc.scope})`);
			continue;
		}
		failed.push(`${svc.label} (${svc.platform})`);
	}
	return {
		darwinUserServices,
		linuxUserServices,
		failed
	};
}
async function cleanupLegacyDarwinServices(services) {
	const removed = [];
	const failed = [];
	for (const svc of services) {
		const plistPath = extractDetailPath(svc.detail, "plist:");
		if (!plistPath) {
			failed.push(`${svc.label} (missing plist path)`);
			continue;
		}
		const dest = await cleanupLegacyLaunchdService({
			label: svc.label,
			plistPath
		});
		removed.push(dest ? `${svc.label} -> ${dest}` : svc.label);
	}
	return {
		removed,
		failed
	};
}
async function cleanupLegacyLinuxUserServices(services, runtime) {
	const removed = [];
	const failed = [];
	try {
		const removedUnits = await uninstallLegacySystemdUnits({
			env: process.env,
			stdout: process.stdout
		});
		const removedByLabel = new Map(removedUnits.map((unit) => [`${unit.name}.service`, unit]));
		for (const svc of services) {
			const removedUnit = removedByLabel.get(svc.label);
			if (!removedUnit) {
				failed.push(`${svc.label} (legacy unit name not recognized)`);
				continue;
			}
			removed.push(`${svc.label} -> ${removedUnit.unitPath}`);
		}
	} catch (err) {
		runtime.error(`Legacy Linux gateway cleanup failed: ${String(err)}`);
		for (const svc of services) failed.push(`${svc.label} (linux cleanup failed)`);
	}
	return {
		removed,
		failed
	};
}
async function maybeRepairGatewayServiceConfig(cfg, mode, runtime, prompter) {
	if (resolveIsNixMode(process.env)) {
		note$1("Nix mode detected; skip service updates.", "Gateway");
		return;
	}
	if (mode === "remote") {
		note$1("Gateway mode is remote; skipped local service audit.", "Gateway");
		return;
	}
	const service = resolveGatewayService();
	let command = null;
	try {
		command = await service.readCommand(process.env);
	} catch {
		command = null;
	}
	if (!command) return;
	const expectedGatewayToken = resolveGatewayAuthToken(cfg, process.env);
	const audit = await auditGatewayServiceConfig({
		env: process.env,
		command,
		expectedGatewayToken
	});
	const needsNodeRuntime = needsNodeRuntimeMigration(audit.issues);
	const systemNodeInfo = needsNodeRuntime ? await resolveSystemNodeInfo({ env: process.env }) : null;
	const systemNodePath = systemNodeInfo?.supported ? systemNodeInfo.path : null;
	if (needsNodeRuntime && !systemNodePath) {
		const warning = renderSystemNodeWarning(systemNodeInfo);
		if (warning) note$1(warning, "Gateway runtime");
		note$1("System Node 22+ not found. Install via Homebrew/apt/choco and rerun doctor to migrate off Bun/version managers.", "Gateway runtime");
	}
	const port = resolveGatewayPort(cfg, process.env);
	const runtimeChoice = detectGatewayRuntime(command.programArguments);
	const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
		env: process.env,
		port,
		token: expectedGatewayToken,
		runtime: needsNodeRuntime && systemNodePath ? "node" : runtimeChoice,
		nodePath: systemNodePath ?? void 0,
		warn: (message, title) => note$1(message, title),
		config: cfg
	});
	const expectedEntrypoint = findGatewayEntrypoint(programArguments);
	const currentEntrypoint = findGatewayEntrypoint(command.programArguments);
	if (expectedEntrypoint && currentEntrypoint && normalizeExecutablePath(expectedEntrypoint) !== normalizeExecutablePath(currentEntrypoint)) audit.issues.push({
		code: SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
		message: "Gateway service entrypoint does not match the current install.",
		detail: `${currentEntrypoint} -> ${expectedEntrypoint}`,
		level: "recommended"
	});
	if (audit.issues.length === 0) return;
	note$1(audit.issues.map((issue) => issue.detail ? `- ${issue.message} (${issue.detail})` : `- ${issue.message}`).join("\n"), "Gateway service config");
	const needsAggressive = audit.issues.filter((issue) => issue.level === "aggressive").length > 0;
	if (needsAggressive && !prompter.shouldForce) note$1("Custom or unexpected service edits detected. Rerun with --force to overwrite.", "Gateway service config");
	if (!(needsAggressive ? await prompter.confirmAggressive({
		message: "Overwrite gateway service config with current defaults now?",
		initialValue: Boolean(prompter.shouldForce)
	}) : await prompter.confirmRepair({
		message: "Update gateway service config to the recommended defaults now?",
		initialValue: true
	}))) return;
	try {
		await service.install({
			env: process.env,
			stdout: process.stdout,
			programArguments,
			workingDirectory,
			environment
		});
	} catch (err) {
		runtime.error(`Gateway service update failed: ${String(err)}`);
	}
}
async function maybeScanExtraGatewayServices(options, runtime, prompter) {
	const extraServices = await findExtraGatewayServices(process.env, { deep: options.deep });
	if (extraServices.length === 0) return;
	note$1(extraServices.map((svc) => `- ${svc.label} (${svc.scope}, ${svc.detail})`).join("\n"), "Other gateway-like services detected");
	const legacyServices = extraServices.filter((svc) => svc.legacy === true);
	if (legacyServices.length > 0) {
		if (await prompter.confirmSkipInNonInteractive({
			message: "Remove legacy gateway services (clawdbot/moltbot) now?",
			initialValue: true
		})) {
			const removed = [];
			const { darwinUserServices, linuxUserServices, failed } = classifyLegacyServices(legacyServices);
			if (darwinUserServices.length > 0) {
				const result = await cleanupLegacyDarwinServices(darwinUserServices);
				removed.push(...result.removed);
				failed.push(...result.failed);
			}
			if (linuxUserServices.length > 0) {
				const result = await cleanupLegacyLinuxUserServices(linuxUserServices, runtime);
				removed.push(...result.removed);
				failed.push(...result.failed);
			}
			if (removed.length > 0) note$1(removed.map((line) => `- ${line}`).join("\n"), "Legacy gateway removed");
			if (failed.length > 0) note$1(failed.map((line) => `- ${line}`).join("\n"), "Legacy gateway cleanup skipped");
			if (removed.length > 0) runtime.log("Legacy gateway services removed. Installing OpenClaw gateway next.");
		}
	}
	const cleanupHints = renderGatewayServiceCleanupHints();
	if (cleanupHints.length > 0) note$1(cleanupHints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
	note$1([
		"Recommendation: run a single gateway per machine for most setups.",
		"One gateway supports multiple agents.",
		"If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host)."
	].join("\n"), "Gateway recommendation");
}

//#endregion
//#region src/commands/doctor-install.ts
function noteSourceInstallIssues(root) {
	if (!root) return;
	const workspaceMarker = path.join(root, "pnpm-workspace.yaml");
	if (!fs.existsSync(workspaceMarker)) return;
	const warnings = [];
	const nodeModules = path.join(root, "node_modules");
	const pnpmStore = path.join(nodeModules, ".pnpm");
	const tsxBin = path.join(nodeModules, ".bin", "tsx");
	const srcEntry = path.join(root, "src", "entry.ts");
	if (fs.existsSync(nodeModules) && !fs.existsSync(pnpmStore)) warnings.push("- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install");
	if (fs.existsSync(path.join(root, "package-lock.json"))) warnings.push("- package-lock.json present in a pnpm workspace. If you ran npm install, remove it and reinstall with pnpm.");
	if (fs.existsSync(srcEntry) && !fs.existsSync(tsxBin)) warnings.push("- tsx binary is missing for source runs. Run: pnpm install");
	if (warnings.length > 0) note$1(warnings.join("\n"), "Install");
}

//#endregion
//#region src/commands/doctor-memory-search.ts
/**
* Check whether memory search has a usable embedding provider.
* Runs as part of `openclaw doctor` — config-only, no network calls.
*/
async function noteMemorySearchHealth(cfg, opts) {
	const agentId = resolveDefaultAgentId(cfg);
	const agentDir = resolveAgentDir(cfg, agentId);
	const resolved = resolveMemorySearchConfig(cfg, agentId);
	const hasRemoteApiKey = Boolean(resolved?.remote?.apiKey?.trim());
	if (!resolved) {
		note$1("Memory search is explicitly disabled (enabled: false).", "Memory search");
		return;
	}
	if (resolveMemoryBackendConfig({
		cfg,
		agentId
	}).backend === "qmd") return;
	if (resolved.provider !== "auto") {
		if (resolved.provider === "local") {
			if (hasLocalEmbeddings(resolved.local)) return;
			note$1([
				"Memory search provider is set to \"local\" but no local model file was found.",
				"",
				"Fix (pick one):",
				`- Install node-llama-cpp and set a local model path in config`,
				`- Switch to a remote provider: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.provider openai")}`,
				"",
				`Verify: ${formatCliCommand("openclaw memory status --deep")}`
			].join("\n"), "Memory search");
			return;
		}
		if (hasRemoteApiKey || await hasApiKeyForProvider(resolved.provider, cfg, agentDir)) return;
		if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
			note$1([
				`Memory search provider is set to "${resolved.provider}" but the API key was not found in the CLI environment.`,
				"The running gateway reports memory embeddings are ready for the default agent.",
				`Verify: ${formatCliCommand("openclaw memory status --deep")}`
			].join("\n"), "Memory search");
			return;
		}
		const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
		const envVar = providerEnvVar(resolved.provider);
		note$1([
			`Memory search provider is set to "${resolved.provider}" but no API key was found.`,
			`Semantic recall will not work without a valid API key.`,
			gatewayProbeWarning ? gatewayProbeWarning : null,
			"",
			"Fix (pick one):",
			`- Set ${envVar} in your environment`,
			`- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
			`- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
			"",
			`Verify: ${formatCliCommand("openclaw memory status --deep")}`
		].join("\n"), "Memory search");
		return;
	}
	if (hasLocalEmbeddings(resolved.local)) return;
	for (const provider of [
		"openai",
		"gemini",
		"voyage",
		"mistral"
	]) if (hasRemoteApiKey || await hasApiKeyForProvider(provider, cfg, agentDir)) return;
	if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
		note$1([
			"Memory search provider is set to \"auto\" but the API key was not found in the CLI environment.",
			"The running gateway reports memory embeddings are ready for the default agent.",
			`Verify: ${formatCliCommand("openclaw memory status --deep")}`
		].join("\n"), "Memory search");
		return;
	}
	const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
	note$1([
		"Memory search is enabled but no embedding provider is configured.",
		"Semantic recall will not work without an embedding provider.",
		gatewayProbeWarning ? gatewayProbeWarning : null,
		"",
		"Fix (pick one):",
		"- Set OPENAI_API_KEY, GEMINI_API_KEY, VOYAGE_API_KEY, or MISTRAL_API_KEY in your environment",
		`- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
		`- For local embeddings: configure agents.defaults.memorySearch.provider and local model path`,
		`- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
		"",
		`Verify: ${formatCliCommand("openclaw memory status --deep")}`
	].join("\n"), "Memory search");
}
function hasLocalEmbeddings(local) {
	const modelPath = local.modelPath?.trim();
	if (!modelPath) return false;
	if (/^(hf:|https?:)/i.test(modelPath)) return true;
	const resolved = resolveUserPath(modelPath);
	try {
		return fs.statSync(resolved).isFile();
	} catch {
		return false;
	}
}
async function hasApiKeyForProvider(provider, cfg, agentDir) {
	const authProvider = provider === "gemini" ? "google" : provider;
	try {
		await resolveApiKeyForProvider({
			provider: authProvider,
			cfg,
			agentDir
		});
		return true;
	} catch {
		return false;
	}
}
function providerEnvVar(provider) {
	switch (provider) {
		case "openai": return "OPENAI_API_KEY";
		case "gemini": return "GEMINI_API_KEY";
		case "voyage": return "VOYAGE_API_KEY";
		default: return `${provider.toUpperCase()}_API_KEY`;
	}
}
function buildGatewayProbeWarning(probe) {
	if (!probe?.checked || probe.ready) return null;
	const detail = probe.error?.trim();
	return detail ? `Gateway memory probe for default agent is not ready: ${detail}` : "Gateway memory probe for default agent is not ready.";
}

//#endregion
//#region src/commands/doctor-platform-notes.ts
const execFileAsync = promisify(execFile);
function resolveHomeDir() {
	return process.env.HOME ?? os.homedir();
}
async function noteMacLaunchAgentOverrides() {
	if (process.platform !== "darwin") return;
	const home = resolveHomeDir();
	const markerPath = [path.join(home, ".openclaw", "disable-launchagent")].find((candidate) => fs.existsSync(candidate));
	if (!markerPath) return;
	const displayMarkerPath = shortenHomePath(markerPath);
	note$1([
		`- LaunchAgent writes are disabled via ${displayMarkerPath}.`,
		"- To restore default behavior:",
		`  rm ${displayMarkerPath}`
	].filter((line) => Boolean(line)).join("\n"), "Gateway (macOS)");
}
async function launchctlGetenv(name) {
	try {
		const result = await execFileAsync("/bin/launchctl", ["getenv", name], { encoding: "utf8" });
		const value = String(result.stdout ?? "").trim();
		return value.length > 0 ? value : void 0;
	} catch {
		return;
	}
}
function hasConfigGatewayCreds(cfg) {
	const localToken = typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway?.auth?.token.trim() : "";
	const localPassword = typeof cfg.gateway?.auth?.password === "string" ? cfg.gateway?.auth?.password.trim() : "";
	const remoteToken = typeof cfg.gateway?.remote?.token === "string" ? cfg.gateway?.remote?.token.trim() : "";
	const remotePassword = typeof cfg.gateway?.remote?.password === "string" ? cfg.gateway?.remote?.password.trim() : "";
	return Boolean(localToken || localPassword || remoteToken || remotePassword);
}
async function noteMacLaunchctlGatewayEnvOverrides(cfg, deps) {
	if ((deps?.platform ?? process.platform) !== "darwin") return;
	if (!hasConfigGatewayCreds(cfg)) return;
	const getenv = deps?.getenv ?? launchctlGetenv;
	const deprecatedLaunchctlEntries = [["CLAWDBOT_GATEWAY_TOKEN", await getenv("CLAWDBOT_GATEWAY_TOKEN")], ["CLAWDBOT_GATEWAY_PASSWORD", await getenv("CLAWDBOT_GATEWAY_PASSWORD")]].filter((entry) => Boolean(entry[1]?.trim()));
	if (deprecatedLaunchctlEntries.length > 0) {
		const lines = ["- Deprecated launchctl environment variables detected (ignored).", ...deprecatedLaunchctlEntries.map(([key]) => `- \`${key}\` is set; use \`OPENCLAW_${key.slice(key.indexOf("_") + 1)}\` instead.`)];
		(deps?.noteFn ?? note$1)(lines.join("\n"), "Gateway (macOS)");
	}
	const tokenEntries = [["OPENCLAW_GATEWAY_TOKEN", await getenv("OPENCLAW_GATEWAY_TOKEN")]];
	const passwordEntries = [["OPENCLAW_GATEWAY_PASSWORD", await getenv("OPENCLAW_GATEWAY_PASSWORD")]];
	const tokenEntry = tokenEntries.find(([, value]) => value?.trim());
	const passwordEntry = passwordEntries.find(([, value]) => value?.trim());
	const envToken = tokenEntry?.[1]?.trim() ?? "";
	const envPassword = passwordEntry?.[1]?.trim() ?? "";
	const envTokenKey = tokenEntry?.[0];
	const envPasswordKey = passwordEntry?.[0];
	if (!envToken && !envPassword) return;
	const lines = [
		"- launchctl environment overrides detected (can cause confusing unauthorized errors).",
		envToken && envTokenKey ? `- \`${envTokenKey}\` is set; it overrides config tokens.` : void 0,
		envPassword ? `- \`${envPasswordKey ?? "OPENCLAW_GATEWAY_PASSWORD"}\` is set; it overrides config passwords.` : void 0,
		"- Clear overrides and restart the app/gateway:",
		envTokenKey ? `  launchctl unsetenv ${envTokenKey}` : void 0,
		envPasswordKey ? `  launchctl unsetenv ${envPasswordKey}` : void 0
	].filter((line) => Boolean(line));
	(deps?.noteFn ?? note$1)(lines.join("\n"), "Gateway (macOS)");
}
function noteDeprecatedLegacyEnvVars(env = process.env, deps) {
	const entries = Object.entries(env).filter(([key, value]) => key.startsWith("CLAWDBOT_") && value?.trim()).map(([key]) => key);
	if (entries.length === 0) return;
	const lines = [
		"- Deprecated legacy environment variables detected (ignored).",
		"- Use OPENCLAW_* equivalents instead:",
		...entries.map((key) => {
			return `  ${key} -> OPENCLAW_${key.slice(key.indexOf("_") + 1)}`;
		})
	];
	(deps?.noteFn ?? note$1)(lines.join("\n"), "Environment");
}

//#endregion
//#region src/commands/doctor-prompter.ts
function createDoctorPrompter(params) {
	const yes = params.options.yes === true;
	const requestedNonInteractive = params.options.nonInteractive === true;
	const shouldRepair = params.options.repair === true || yes;
	const shouldForce = params.options.force === true;
	const isTty = Boolean(process.stdin.isTTY);
	const nonInteractive = requestedNonInteractive || !isTty && !yes;
	const canPrompt = isTty && !yes && !nonInteractive;
	const confirmDefault = async (p) => {
		if (nonInteractive) return false;
		if (shouldRepair) return true;
		if (!canPrompt) return Boolean(p.initialValue ?? false);
		return guardCancel(await confirm({
			...p,
			message: stylePromptMessage(p.message)
		}), params.runtime);
	};
	return {
		confirm: confirmDefault,
		confirmRepair: async (p) => {
			if (nonInteractive) return false;
			return confirmDefault(p);
		},
		confirmAggressive: async (p) => {
			if (nonInteractive) return false;
			if (shouldRepair && shouldForce) return true;
			if (shouldRepair && !shouldForce) return false;
			if (!canPrompt) return Boolean(p.initialValue ?? false);
			return guardCancel(await confirm({
				...p,
				message: stylePromptMessage(p.message)
			}), params.runtime);
		},
		confirmSkipInNonInteractive: async (p) => {
			if (nonInteractive) return false;
			if (shouldRepair) return true;
			return confirmDefault(p);
		},
		select: async (p, fallback) => {
			if (!canPrompt || shouldRepair) return fallback;
			return guardCancel(await select({
				...p,
				message: stylePromptMessage(p.message),
				options: p.options.map((opt) => opt.hint === void 0 ? opt : {
					...opt,
					hint: stylePromptHint(opt.hint)
				})
			}), params.runtime);
		},
		shouldRepair,
		shouldForce
	};
}

//#endregion
//#region src/commands/doctor-sandbox.ts
function resolveSandboxScript(scriptRel) {
	const candidates = /* @__PURE__ */ new Set();
	candidates.add(process.cwd());
	const argv1 = process.argv[1];
	if (argv1) {
		const normalized = path.resolve(argv1);
		candidates.add(path.resolve(path.dirname(normalized), ".."));
		candidates.add(path.resolve(path.dirname(normalized)));
	}
	for (const root of candidates) {
		const scriptPath = path.join(root, scriptRel);
		if (fs.existsSync(scriptPath)) return {
			scriptPath,
			cwd: root
		};
	}
	return null;
}
async function runSandboxScript(scriptRel, runtime) {
	const script = resolveSandboxScript(scriptRel);
	if (!script) {
		note$1(`Unable to locate ${scriptRel}. Run it from the repo root.`, "Sandbox");
		return false;
	}
	runtime.log(`Running ${scriptRel}...`);
	const result = await runCommandWithTimeout(["bash", script.scriptPath], {
		timeoutMs: 1200 * 1e3,
		cwd: script.cwd
	});
	if (result.code !== 0) {
		runtime.error(`Failed running ${scriptRel}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
		return false;
	}
	runtime.log(`Completed ${scriptRel}.`);
	return true;
}
async function isDockerAvailable() {
	try {
		await runExec("docker", [
			"version",
			"--format",
			"{{.Server.Version}}"
		], { timeoutMs: 5e3 });
		return true;
	} catch {
		return false;
	}
}
async function dockerImageExists(image) {
	try {
		await runExec("docker", [
			"image",
			"inspect",
			image
		], { timeoutMs: 5e3 });
		return true;
	} catch (error) {
		const stderr = error?.stderr || error?.message || "";
		if (String(stderr).includes("No such image")) return false;
		throw error;
	}
}
function resolveSandboxDockerImage(cfg) {
	const image = cfg.agents?.defaults?.sandbox?.docker?.image?.trim();
	return image ? image : DEFAULT_SANDBOX_IMAGE;
}
function resolveSandboxBrowserImage(cfg) {
	const image = cfg.agents?.defaults?.sandbox?.browser?.image?.trim();
	return image ? image : DEFAULT_SANDBOX_BROWSER_IMAGE;
}
function updateSandboxDockerImage(cfg, image) {
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				sandbox: {
					...cfg.agents?.defaults?.sandbox,
					docker: {
						...cfg.agents?.defaults?.sandbox?.docker,
						image
					}
				}
			}
		}
	};
}
function updateSandboxBrowserImage(cfg, image) {
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				sandbox: {
					...cfg.agents?.defaults?.sandbox,
					browser: {
						...cfg.agents?.defaults?.sandbox?.browser,
						image
					}
				}
			}
		}
	};
}
async function handleMissingSandboxImage(params, runtime, prompter) {
	if (await dockerImageExists(params.image)) return;
	const buildHint = params.buildScript ? `Build it with ${params.buildScript}.` : "Build or pull it first.";
	note$1(`Sandbox ${params.kind} image missing: ${params.image}. ${buildHint}`, "Sandbox");
	let built = false;
	if (params.buildScript) {
		if (await prompter.confirmSkipInNonInteractive({
			message: `Build ${params.kind} sandbox image now?`,
			initialValue: true
		})) built = await runSandboxScript(params.buildScript, runtime);
	}
	if (built) return;
}
async function maybeRepairSandboxImages(cfg, runtime, prompter) {
	const sandbox = cfg.agents?.defaults?.sandbox;
	const mode = sandbox?.mode ?? "off";
	if (!sandbox || mode === "off") return cfg;
	if (!await isDockerAvailable()) {
		note$1([
			`Sandbox mode is enabled (mode: "${mode}") but Docker is not available.`,
			"Docker is required for sandbox mode to function.",
			"Isolated sessions (cron jobs, sub-agents) will fail without Docker.",
			"",
			"Options:",
			"- Install Docker and restart the gateway",
			"- Disable sandbox mode: openclaw config set agents.defaults.sandbox.mode off"
		].join("\n"), "Sandbox");
		return cfg;
	}
	let next = cfg;
	const changes = [];
	const dockerImage = resolveSandboxDockerImage(cfg);
	await handleMissingSandboxImage({
		kind: "base",
		image: dockerImage,
		buildScript: dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE ? "scripts/sandbox-common-setup.sh" : dockerImage === DEFAULT_SANDBOX_IMAGE ? "scripts/sandbox-setup.sh" : void 0,
		updateConfig: (image) => {
			next = updateSandboxDockerImage(next, image);
			changes.push(`Updated agents.defaults.sandbox.docker.image → ${image}`);
		}
	}, runtime, prompter);
	if (sandbox.browser?.enabled) await handleMissingSandboxImage({
		kind: "browser",
		image: resolveSandboxBrowserImage(cfg),
		buildScript: "scripts/sandbox-browser-setup.sh",
		updateConfig: (image) => {
			next = updateSandboxBrowserImage(next, image);
			changes.push(`Updated agents.defaults.sandbox.browser.image → ${image}`);
		}
	}, runtime, prompter);
	if (changes.length > 0) note$1(changes.join("\n"), "Doctor changes");
	return next;
}
function noteSandboxScopeWarnings(cfg) {
	const globalSandbox = cfg.agents?.defaults?.sandbox;
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const warnings = [];
	for (const agent of agents) {
		const agentId = agent.id;
		const agentSandbox = agent.sandbox;
		if (!agentSandbox) continue;
		if (resolveSandboxScope({
			scope: agentSandbox.scope ?? globalSandbox?.scope,
			perSession: agentSandbox.perSession ?? globalSandbox?.perSession
		}) !== "shared") continue;
		const overrides = [];
		if (agentSandbox.docker && Object.keys(agentSandbox.docker).length > 0) overrides.push("docker");
		if (agentSandbox.browser && Object.keys(agentSandbox.browser).length > 0) overrides.push("browser");
		if (agentSandbox.prune && Object.keys(agentSandbox.prune).length > 0) overrides.push("prune");
		if (overrides.length === 0) continue;
		warnings.push([`- agents.list (id "${agentId}") sandbox ${overrides.join("/")} overrides ignored.`, `  scope resolves to "shared".`].join("\n"));
	}
	if (warnings.length > 0) note$1(warnings.join("\n"), "Sandbox");
}

//#endregion
//#region src/commands/doctor-security.ts
async function noteSecurityWarnings(cfg) {
	const warnings = [];
	const auditHint = `- Run: ${formatCliCommand("openclaw security audit --deep")}`;
	if (cfg.approvals?.exec?.enabled === false) warnings.push("- Note: approvals.exec.enabled=false disables approval forwarding only.", "  Host exec gating still comes from ~/.openclaw/exec-approvals.json.", `  Check local policy with: ${formatCliCommand("openclaw approvals get --gateway")}`);
	const gatewayBind = cfg.gateway?.bind ?? "loopback";
	const customBindHost = cfg.gateway?.customBindHost?.trim();
	const bindMode = [
		"auto",
		"lan",
		"loopback",
		"custom",
		"tailnet"
	].includes(gatewayBind) ? gatewayBind : void 0;
	const resolvedBindHost = bindMode ? await resolveGatewayBindHost(bindMode, customBindHost) : "0.0.0.0";
	const isExposed = !isLoopbackHost(resolvedBindHost);
	const resolvedAuth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		env: process.env,
		tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off"
	});
	const authToken = resolvedAuth.token?.trim() ?? "";
	const authPassword = resolvedAuth.password?.trim() ?? "";
	const hasToken = authToken.length > 0;
	const hasPassword = authPassword.length > 0;
	const hasSharedSecret = resolvedAuth.mode === "token" && hasToken || resolvedAuth.mode === "password" && hasPassword;
	const bindDescriptor = `"${gatewayBind}" (${resolvedBindHost})`;
	const saferRemoteAccessLines = [
		"  Safer remote access: keep bind loopback and use Tailscale Serve/Funnel or an SSH tunnel.",
		"  Example tunnel: ssh -N -L 18789:127.0.0.1:18789 user@gateway-host",
		"  Docs: https://docs.openclaw.ai/gateway/remote"
	];
	if (isExposed) if (!hasSharedSecret) {
		const authFixLines = resolvedAuth.mode === "password" ? [`  Fix: ${formatCliCommand("openclaw configure")} to set a password`, `  Or switch to token: ${formatCliCommand("openclaw config set gateway.auth.mode token")}`] : [`  Fix: ${formatCliCommand("openclaw doctor --fix")} to generate a token`, `  Or set token directly: ${formatCliCommand("openclaw config set gateway.auth.mode token")}`];
		warnings.push(`- CRITICAL: Gateway bound to ${bindDescriptor} without authentication.`, `  Anyone on your network (or internet if port-forwarded) can fully control your agent.`, `  Fix: ${formatCliCommand("openclaw config set gateway.bind loopback")}`, ...saferRemoteAccessLines, ...authFixLines);
	} else warnings.push(`- WARNING: Gateway bound to ${bindDescriptor} (network-accessible).`, `  Ensure your auth credentials are strong and not exposed.`, ...saferRemoteAccessLines);
	const warnDmPolicy = async (params) => {
		const dmPolicy = params.dmPolicy;
		const policyPath = params.policyPath ?? `${params.allowFromPath}policy`;
		const { hasWildcard, allowCount, isMultiUserDm } = await resolveDmAllowState({
			provider: params.provider,
			accountId: params.accountId,
			allowFrom: params.allowFrom,
			normalizeEntry: params.normalizeEntry
		});
		const dmScope = cfg.session?.dmScope ?? "main";
		if (dmPolicy === "open") {
			const allowFromPath = `${params.allowFromPath}allowFrom`;
			warnings.push(`- ${params.label} DMs: OPEN (${policyPath}="open"). Anyone can DM it.`);
			if (!hasWildcard) warnings.push(`- ${params.label} DMs: config invalid — "open" requires ${allowFromPath} to include "*".`);
		}
		if (dmPolicy === "disabled") {
			warnings.push(`- ${params.label} DMs: disabled (${policyPath}="disabled").`);
			return;
		}
		if (dmPolicy !== "open" && allowCount === 0) {
			warnings.push(`- ${params.label} DMs: locked (${policyPath}="${dmPolicy}") with no allowlist; unknown senders will be blocked / get a pairing code.`);
			warnings.push(`  ${params.approveHint}`);
		}
		if (dmScope === "main" && isMultiUserDm) warnings.push(`- ${params.label} DMs: multiple senders share the main session; run: ` + formatCliCommand("openclaw config set session.dmScope \"per-channel-peer\"") + " (or \"per-account-channel-peer\" for multi-account channels) to isolate sessions.");
	};
	for (const plugin of listChannelPlugins()) {
		if (!plugin.security) continue;
		const { defaultAccountId, account, enabled, configured } = await resolveDefaultChannelAccountContext(plugin, cfg);
		if (!enabled) continue;
		if (!configured) continue;
		const dmPolicy = plugin.security.resolveDmPolicy?.({
			cfg,
			accountId: defaultAccountId,
			account
		});
		if (dmPolicy) await warnDmPolicy({
			label: plugin.meta.label ?? plugin.id,
			provider: plugin.id,
			accountId: defaultAccountId,
			dmPolicy: dmPolicy.policy,
			allowFrom: dmPolicy.allowFrom,
			policyPath: dmPolicy.policyPath,
			allowFromPath: dmPolicy.allowFromPath,
			approveHint: dmPolicy.approveHint,
			normalizeEntry: dmPolicy.normalizeEntry
		});
		if (plugin.security.collectWarnings) {
			const extra = await plugin.security.collectWarnings({
				cfg,
				accountId: defaultAccountId,
				account
			});
			if (extra?.length) warnings.push(...extra);
		}
	}
	const lines = warnings.length > 0 ? warnings : ["- No channel security warnings detected."];
	lines.push(auditHint);
	note$1(lines.join("\n"), "Security");
}

//#endregion
//#region src/commands/doctor-session-locks.ts
const DEFAULT_STALE_MS = 1800 * 1e3;
function formatAge(ageMs) {
	if (ageMs === null) return "unknown";
	const seconds = Math.floor(ageMs / 1e3);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainingSeconds}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
function formatLockLine(lock) {
	const pidStatus = lock.pid === null ? "pid=missing" : `pid=${lock.pid} (${lock.pidAlive ? "alive" : "dead"})`;
	const ageStatus = `age=${formatAge(lock.ageMs)}`;
	const staleStatus = lock.stale ? `stale=yes (${lock.staleReasons.join(", ") || "unknown"})` : "stale=no";
	const removedStatus = lock.removed ? " [removed]" : "";
	return `- ${shortenHomePath(lock.lockPath)} ${pidStatus} ${ageStatus} ${staleStatus}${removedStatus}`;
}
async function noteSessionLockHealth(params) {
	const shouldRepair = params?.shouldRepair === true;
	const staleMs = params?.staleMs ?? DEFAULT_STALE_MS;
	let sessionDirs = [];
	try {
		sessionDirs = await resolveAgentSessionDirs(resolveStateDir(process.env));
	} catch (err) {
		note$1(`- Failed to inspect session lock files: ${String(err)}`, "Session locks");
		return;
	}
	if (sessionDirs.length === 0) return;
	const allLocks = [];
	for (const sessionsDir of sessionDirs) {
		const result = await cleanStaleLockFiles({
			sessionsDir,
			staleMs,
			removeStale: shouldRepair
		});
		allLocks.push(...result.locks);
	}
	if (allLocks.length === 0) return;
	const staleCount = allLocks.filter((lock) => lock.stale).length;
	const removedCount = allLocks.filter((lock) => lock.removed).length;
	const lines = [`- Found ${allLocks.length} session lock file${allLocks.length === 1 ? "" : "s"}.`, ...allLocks.toSorted((a, b) => a.lockPath.localeCompare(b.lockPath)).map(formatLockLine)];
	if (staleCount > 0 && !shouldRepair) {
		lines.push(`- ${staleCount} lock file${staleCount === 1 ? " is" : "s are"} stale.`);
		lines.push("- Run \"openclaw doctor --fix\" to remove stale lock files automatically.");
	}
	if (shouldRepair && removedCount > 0) lines.push(`- Removed ${removedCount} stale session lock file${removedCount === 1 ? "" : "s"}.`);
	note$1(lines.join("\n"), "Session locks");
}

//#endregion
//#region src/commands/doctor-state-integrity.ts
function existsDir(dir) {
	try {
		return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
function existsFile(filePath) {
	try {
		return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
function canWriteDir(dir) {
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
function ensureDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
}
function dirPermissionHint(dir) {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	const gid = typeof process.getgid === "function" ? process.getgid() : null;
	try {
		const stat = fs.statSync(dir);
		if (uid !== null && stat.uid !== uid) return `Owner mismatch (uid ${stat.uid}). Run: sudo chown -R $USER "${dir}"`;
		if (gid !== null && stat.gid !== gid) return `Group mismatch (gid ${stat.gid}). If access fails, run: sudo chown -R $USER "${dir}"`;
	} catch {
		return null;
	}
	return null;
}
function addUserRwx(mode) {
	return mode & 511 | 448;
}
function countJsonlLines(filePath) {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		if (!raw) return 0;
		let count = 0;
		for (let i = 0; i < raw.length; i += 1) if (raw[i] === "\n") count += 1;
		if (!raw.endsWith("\n")) count += 1;
		return count;
	} catch {
		return 0;
	}
}
function findOtherStateDirs(stateDir) {
	const resolvedState = path.resolve(stateDir);
	const roots = process.platform === "darwin" ? ["/Users"] : process.platform === "linux" ? ["/home"] : [];
	const found = [];
	for (const root of roots) {
		let entries = [];
		try {
			entries = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			const candidates = [".openclaw"].map((dir) => path.resolve(root, entry.name, dir));
			for (const candidate of candidates) {
				if (candidate === resolvedState) continue;
				if (existsDir(candidate)) found.push(candidate);
			}
		}
	}
	return found;
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function isPairingPolicy(value) {
	return typeof value === "string" && value.trim().toLowerCase() === "pairing";
}
function hasPairingPolicy(value) {
	if (!isRecord(value)) return false;
	if (isPairingPolicy(value.dmPolicy)) return true;
	if (isRecord(value.dm) && isPairingPolicy(value.dm.policy)) return true;
	if (!isRecord(value.accounts)) return false;
	for (const accountCfg of Object.values(value.accounts)) if (hasPairingPolicy(accountCfg)) return true;
	return false;
}
function isSlashRoutingSessionKey(sessionKey) {
	const raw = sessionKey.trim().toLowerCase();
	if (!raw) return false;
	const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
	return /^[^:]+:slash:[^:]+(?:$|:)/.test(scoped);
}
function shouldRequireOAuthDir(cfg, env) {
	if (env.OPENCLAW_OAUTH_DIR?.trim()) return true;
	const channels = cfg.channels;
	if (!isRecord(channels)) return false;
	if (isRecord(channels.whatsapp)) return true;
	for (const [channelId, channelCfg] of Object.entries(channels)) {
		if (channelId === "defaults" || channelId === "modelByChannel") continue;
		if (hasPairingPolicy(channelCfg)) return true;
	}
	return false;
}
async function noteStateIntegrity(cfg, prompter, configPath) {
	const warnings = [];
	const changes = [];
	const env = process.env;
	const homedir = () => resolveRequiredHomeDir(env, os.homedir);
	const stateDir = resolveStateDir(env, homedir);
	const defaultStateDir = path.join(homedir(), ".openclaw");
	const oauthDir = resolveOAuthDir(env, stateDir);
	const agentId = resolveDefaultAgentId(cfg);
	const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env, homedir);
	const storePath = resolveStorePath(cfg.session?.store, { agentId });
	const storeDir = path.dirname(storePath);
	const absoluteStorePath = path.resolve(storePath);
	const displayStateDir = shortenHomePath(stateDir);
	const displayOauthDir = shortenHomePath(oauthDir);
	const displaySessionsDir = shortenHomePath(sessionsDir);
	const displayStoreDir = shortenHomePath(storeDir);
	const displayConfigPath = configPath ? shortenHomePath(configPath) : void 0;
	const requireOAuthDir = shouldRequireOAuthDir(cfg, env);
	let stateDirExists = existsDir(stateDir);
	if (!stateDirExists) {
		warnings.push(`- CRITICAL: state directory missing (${displayStateDir}). Sessions, credentials, logs, and config are stored there.`);
		if (cfg.gateway?.mode === "remote") warnings.push("- Gateway is in remote mode; run doctor on the remote host where the gateway runs.");
		if (await prompter.confirmSkipInNonInteractive({
			message: `Create ${displayStateDir} now?`,
			initialValue: false
		})) {
			const created = ensureDir(stateDir);
			if (created.ok) {
				changes.push(`- Created ${displayStateDir}`);
				stateDirExists = true;
			} else warnings.push(`- Failed to create ${displayStateDir}: ${created.error}`);
		}
	}
	if (stateDirExists && !canWriteDir(stateDir)) {
		warnings.push(`- State directory not writable (${displayStateDir}).`);
		const hint = dirPermissionHint(stateDir);
		if (hint) warnings.push(`  ${hint}`);
		if (await prompter.confirmSkipInNonInteractive({
			message: `Repair permissions on ${displayStateDir}?`,
			initialValue: true
		})) try {
			const target = addUserRwx(fs.statSync(stateDir).mode);
			fs.chmodSync(stateDir, target);
			changes.push(`- Repaired permissions on ${displayStateDir}`);
		} catch (err) {
			warnings.push(`- Failed to repair ${displayStateDir}: ${String(err)}`);
		}
	}
	if (stateDirExists && process.platform !== "win32") try {
		const dirLstat = fs.lstatSync(stateDir);
		const isDirSymlink = dirLstat.isSymbolicLink();
		const stat = isDirSymlink ? fs.statSync(stateDir) : dirLstat;
		if (!(isDirSymlink ? fs.realpathSync(stateDir) : stateDir).startsWith("/nix/store/") && (stat.mode & 63) !== 0) {
			warnings.push(`- State directory permissions are too open (${displayStateDir}). Recommend chmod 700.`);
			if (await prompter.confirmSkipInNonInteractive({
				message: `Tighten permissions on ${displayStateDir} to 700?`,
				initialValue: true
			})) {
				fs.chmodSync(stateDir, 448);
				changes.push(`- Tightened permissions on ${displayStateDir} to 700`);
			}
		}
	} catch (err) {
		warnings.push(`- Failed to read ${displayStateDir} permissions: ${String(err)}`);
	}
	if (configPath && existsFile(configPath) && process.platform !== "win32") try {
		const configLstat = fs.lstatSync(configPath);
		const isSymlink = configLstat.isSymbolicLink();
		const stat = isSymlink ? fs.statSync(configPath) : configLstat;
		if (!(isSymlink ? fs.realpathSync(configPath) : configPath).startsWith("/nix/store/") && (stat.mode & 63) !== 0) {
			warnings.push(`- Config file is group/world readable (${displayConfigPath ?? configPath}). Recommend chmod 600.`);
			if (await prompter.confirmSkipInNonInteractive({
				message: `Tighten permissions on ${displayConfigPath ?? configPath} to 600?`,
				initialValue: true
			})) {
				fs.chmodSync(configPath, 384);
				changes.push(`- Tightened permissions on ${displayConfigPath ?? configPath} to 600`);
			}
		}
	} catch (err) {
		warnings.push(`- Failed to read config permissions (${displayConfigPath ?? configPath}): ${String(err)}`);
	}
	if (stateDirExists) {
		const dirCandidates = /* @__PURE__ */ new Map();
		dirCandidates.set(sessionsDir, "Sessions dir");
		dirCandidates.set(storeDir, "Session store dir");
		if (requireOAuthDir) dirCandidates.set(oauthDir, "OAuth dir");
		else if (!existsDir(oauthDir)) warnings.push(`- OAuth dir not present (${displayOauthDir}). Skipping create because no WhatsApp/pairing channel config is active.`);
		const displayDirFor = (dir) => {
			if (dir === sessionsDir) return displaySessionsDir;
			if (dir === storeDir) return displayStoreDir;
			if (dir === oauthDir) return displayOauthDir;
			return shortenHomePath(dir);
		};
		for (const [dir, label] of dirCandidates) {
			const displayDir = displayDirFor(dir);
			if (!existsDir(dir)) {
				warnings.push(`- CRITICAL: ${label} missing (${displayDir}).`);
				if (await prompter.confirmSkipInNonInteractive({
					message: `Create ${label} at ${displayDir}?`,
					initialValue: true
				})) {
					const created = ensureDir(dir);
					if (created.ok) changes.push(`- Created ${label}: ${displayDir}`);
					else warnings.push(`- Failed to create ${displayDir}: ${created.error}`);
				}
				continue;
			}
			if (!canWriteDir(dir)) {
				warnings.push(`- ${label} not writable (${displayDir}).`);
				const hint = dirPermissionHint(dir);
				if (hint) warnings.push(`  ${hint}`);
				if (await prompter.confirmSkipInNonInteractive({
					message: `Repair permissions on ${label}?`,
					initialValue: true
				})) try {
					const target = addUserRwx(fs.statSync(dir).mode);
					fs.chmodSync(dir, target);
					changes.push(`- Repaired permissions on ${label}: ${displayDir}`);
				} catch (err) {
					warnings.push(`- Failed to repair ${displayDir}: ${String(err)}`);
				}
			}
		}
	}
	const extraStateDirs = /* @__PURE__ */ new Set();
	if (path.resolve(stateDir) !== path.resolve(defaultStateDir)) {
		if (existsDir(defaultStateDir)) extraStateDirs.add(defaultStateDir);
	}
	for (const other of findOtherStateDirs(stateDir)) extraStateDirs.add(other);
	if (extraStateDirs.size > 0) warnings.push([
		"- Multiple state directories detected. This can split session history.",
		...Array.from(extraStateDirs).map((dir) => `  - ${shortenHomePath(dir)}`),
		`  Active state dir: ${displayStateDir}`
	].join("\n"));
	const store = loadSessionStore(storePath);
	const sessionPathOpts = resolveSessionFilePathOptions({
		agentId,
		storePath
	});
	const entries = Object.entries(store).filter(([, entry]) => entry && typeof entry === "object");
	if (entries.length > 0) {
		const recentTranscriptCandidates = entries.slice().toSorted((a, b) => {
			const aUpdated = typeof a[1].updatedAt === "number" ? a[1].updatedAt : 0;
			return (typeof b[1].updatedAt === "number" ? b[1].updatedAt : 0) - aUpdated;
		}).slice(0, 5).filter(([key]) => !isSlashRoutingSessionKey(key));
		const missing = recentTranscriptCandidates.filter(([, entry]) => {
			const sessionId = entry.sessionId;
			if (!sessionId) return false;
			return !existsFile(resolveSessionFilePath(sessionId, entry, sessionPathOpts));
		});
		if (missing.length > 0) warnings.push([
			`- ${missing.length}/${recentTranscriptCandidates.length} recent sessions are missing transcripts.`,
			`  Verify sessions in store: ${formatCliCommand(`openclaw sessions --store "${absoluteStorePath}"`)}`,
			`  Preview cleanup impact: ${formatCliCommand(`openclaw sessions cleanup --store "${absoluteStorePath}" --dry-run`)}`,
			`  Prune missing entries: ${formatCliCommand(`openclaw sessions cleanup --store "${absoluteStorePath}" --enforce --fix-missing`)}`
		].join("\n"));
		const mainEntry = store[resolveMainSessionKey(cfg)];
		if (mainEntry?.sessionId) {
			const transcriptPath = resolveSessionFilePath(mainEntry.sessionId, mainEntry, sessionPathOpts);
			if (!existsFile(transcriptPath)) warnings.push(`- Main session transcript missing (${shortenHomePath(transcriptPath)}). History will appear to reset.`);
			else {
				const lineCount = countJsonlLines(transcriptPath);
				if (lineCount <= 1) warnings.push(`- Main session transcript has only ${lineCount} line. Session history may not be appending.`);
			}
		}
	}
	if (existsDir(sessionsDir)) {
		const referencedTranscriptPaths = /* @__PURE__ */ new Set();
		for (const [, entry] of entries) {
			if (!entry?.sessionId) continue;
			try {
				referencedTranscriptPaths.add(path.resolve(resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts)));
			} catch {}
		}
		const orphanTranscriptPaths = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isFile() && isPrimarySessionTranscriptFileName(entry.name)).map((entry) => path.resolve(path.join(sessionsDir, entry.name))).filter((filePath) => !referencedTranscriptPaths.has(filePath));
		if (orphanTranscriptPaths.length > 0) {
			warnings.push(`- Found ${orphanTranscriptPaths.length} orphan transcript file(s) in ${displaySessionsDir}. They are not referenced by sessions.json and can consume disk over time.`);
			if (await prompter.confirmSkipInNonInteractive({
				message: `Archive ${orphanTranscriptPaths.length} orphan transcript file(s) in ${displaySessionsDir}?`,
				initialValue: false
			})) {
				let archived = 0;
				const archivedAt = formatSessionArchiveTimestamp();
				for (const orphanPath of orphanTranscriptPaths) {
					const archivedPath = `${orphanPath}.deleted.${archivedAt}`;
					try {
						fs.renameSync(orphanPath, archivedPath);
						archived += 1;
					} catch (err) {
						warnings.push(`- Failed to archive orphan transcript ${shortenHomePath(orphanPath)}: ${String(err)}`);
					}
				}
				if (archived > 0) changes.push(`- Archived ${archived} orphan transcript file(s) in ${displaySessionsDir}`);
			}
		}
	}
	if (warnings.length > 0) note$1(warnings.join("\n"), "State integrity");
	if (changes.length > 0) note$1(changes.join("\n"), "Doctor changes");
}
function noteWorkspaceBackupTip(workspaceDir) {
	if (!existsDir(workspaceDir)) return;
	const gitMarker = path.join(workspaceDir, ".git");
	if (fs.existsSync(gitMarker)) return;
	note$1([
		"- Tip: back up the workspace in a private git repo (GitHub or GitLab).",
		"- Keep ~/.openclaw out of git; it contains credentials and session history.",
		"- Details: /concepts/agent-workspace#git-backup-recommended"
	].join("\n"), "Workspace");
}

//#endregion
//#region src/commands/doctor-ui.ts
async function maybeRepairUiProtocolFreshness(_runtime, prompter) {
	const root = await resolveOpenClawPackageRoot({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	});
	if (!root) return;
	const schemaPath = path.join(root, "src/gateway/protocol/schema.ts");
	const uiIndexPath = (await resolveControlUiDistIndexHealth({
		root,
		argv1: process.argv[1]
	})).indexPath ?? resolveControlUiDistIndexPathForRoot(root);
	try {
		const [schemaStats, uiStats] = await Promise.all([fs$1.stat(schemaPath).catch(() => null), fs$1.stat(uiIndexPath).catch(() => null)]);
		if (schemaStats && !uiStats) {
			note$1(["- Control UI assets are missing.", "- Run: pnpm ui:build"].join("\n"), "UI");
			const uiSourcesPath = path.join(root, "ui/package.json");
			if (!await fs$1.stat(uiSourcesPath).catch(() => null)) {
				note$1("Skipping UI build: ui/ sources not present.", "UI");
				return;
			}
			if (await prompter.confirmRepair({
				message: "Build Control UI assets now?",
				initialValue: true
			})) {
				note$1("Building Control UI assets... (this may take a moment)", "UI");
				const uiScriptPath = path.join(root, "scripts/ui.js");
				const buildResult = await runCommandWithTimeout([
					process.execPath,
					uiScriptPath,
					"build"
				], {
					cwd: root,
					timeoutMs: 12e4,
					env: {
						...process.env,
						FORCE_COLOR: "1"
					}
				});
				if (buildResult.code === 0) note$1("UI build complete.", "UI");
				else note$1([`UI build failed (exit ${buildResult.code ?? "unknown"}).`, buildResult.stderr.trim() ? buildResult.stderr.trim() : null].filter(Boolean).join("\n"), "UI");
			}
			return;
		}
		if (!schemaStats || !uiStats) return;
		if (schemaStats.mtime > uiStats.mtime) {
			const gitLog = await runCommandWithTimeout([
				"git",
				"-C",
				root,
				"log",
				`--since=${uiStats.mtime.toISOString()}`,
				"--format=%h %s",
				"src/gateway/protocol/schema.ts"
			], { timeoutMs: 5e3 }).catch(() => null);
			if (gitLog && gitLog.code === 0 && gitLog.stdout.trim()) {
				note$1(`UI assets are older than the protocol schema.\nFunctional changes since last build:\n${gitLog.stdout.trim().split("\n").map((l) => `- ${l}`).join("\n")}`, "UI Freshness");
				if (await prompter.confirmAggressive({
					message: "Rebuild UI now? (Detected protocol mismatch requiring update)",
					initialValue: true
				})) {
					const uiSourcesPath = path.join(root, "ui/package.json");
					if (!await fs$1.stat(uiSourcesPath).catch(() => null)) {
						note$1("Skipping UI rebuild: ui/ sources not present.", "UI");
						return;
					}
					note$1("Rebuilding stale UI assets... (this may take a moment)", "UI");
					const uiScriptPath = path.join(root, "scripts/ui.js");
					const buildResult = await runCommandWithTimeout([
						process.execPath,
						uiScriptPath,
						"build"
					], {
						cwd: root,
						timeoutMs: 12e4,
						env: {
							...process.env,
							FORCE_COLOR: "1"
						}
					});
					if (buildResult.code === 0) note$1("UI rebuild complete.", "UI");
					else note$1([`UI rebuild failed (exit ${buildResult.code ?? "unknown"}).`, buildResult.stderr.trim() ? buildResult.stderr.trim() : null].filter(Boolean).join("\n"), "UI");
				}
			}
		}
	} catch {}
}

//#endregion
//#region src/commands/doctor-update.ts
async function detectOpenClawGitCheckout(root) {
	const res = await runCommandWithTimeout([
		"git",
		"-C",
		root,
		"rev-parse",
		"--show-toplevel"
	], { timeoutMs: 5e3 }).catch(() => null);
	if (!res) return "unknown";
	if (res.code !== 0) {
		if (res.stderr.toLowerCase().includes("not a git repository")) return "not-git";
		return "unknown";
	}
	return res.stdout.trim() === root ? "git" : "not-git";
}
async function maybeOfferUpdateBeforeDoctor(params) {
	if (!(!isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS) && params.options.nonInteractive !== true && params.options.yes !== true && params.options.repair !== true && Boolean(process.stdin.isTTY)) || !params.root) return { updated: false };
	const git = await detectOpenClawGitCheckout(params.root);
	if (git === "git") {
		if (!await params.confirm({
			message: "Update OpenClaw from git before running doctor?",
			initialValue: true
		})) return { updated: false };
		note$1("Running update (fetch/rebase/build/ui:build/doctor)…", "Update");
		const result = await runGatewayUpdate({
			cwd: params.root,
			argv1: process.argv[1]
		});
		note$1([
			`Status: ${result.status}`,
			`Mode: ${result.mode}`,
			result.root ? `Root: ${result.root}` : null,
			result.reason ? `Reason: ${result.reason}` : null
		].filter(Boolean).join("\n"), "Update result");
		if (result.status === "ok") {
			params.outro("Update completed (doctor already ran as part of the update).");
			return {
				updated: true,
				handled: true
			};
		}
		return {
			updated: true,
			handled: false
		};
	}
	if (git === "not-git") note$1(["This install is not a git checkout.", `Run \`${formatCliCommand("openclaw update")}\` to update via your package manager (npm/pnpm), then rerun doctor.`].join("\n"), "Update");
	return { updated: false };
}

//#endregion
//#region src/commands/doctor-workspace.ts
const MEMORY_SYSTEM_PROMPT = [
	"Memory system not found in workspace.",
	"Paste this into your agent:",
	"",
	"Install the memory system by applying:",
	"https://github.com/openclaw/openclaw/commit/9ffea23f31ca1df5183b25668f8f814bee0fb34e",
	"https://github.com/openclaw/openclaw/commit/7d1fee70e76f2f634f1b41fca927ee663914183a"
].join("\n");
async function shouldSuggestMemorySystem(workspaceDir) {
	const memoryPaths = [path.join(workspaceDir, "MEMORY.md"), path.join(workspaceDir, "memory.md")];
	for (const memoryPath of memoryPaths) try {
		await fs.promises.access(memoryPath);
		return false;
	} catch {}
	const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
	try {
		const content = await fs.promises.readFile(agentsPath, "utf-8");
		if (/memory\.md/i.test(content)) return false;
	} catch {}
	return true;
}
function detectLegacyWorkspaceDirs(params) {
	return {
		activeWorkspace: path.resolve(params.workspaceDir),
		legacyDirs: []
	};
}
function formatLegacyWorkspaceWarning(detection) {
	return [
		"Extra workspace directories detected (may contain old agent files):",
		...detection.legacyDirs.map((dir) => `- ${shortenHomePath(dir)}`),
		`Active workspace: ${shortenHomePath(detection.activeWorkspace)}`,
		"If unused, archive or move to Trash."
	].join("\n");
}

//#endregion
//#region src/commands/doctor-workspace-status.ts
function noteWorkspaceStatus(cfg) {
	const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
	const legacyWorkspace = detectLegacyWorkspaceDirs({ workspaceDir });
	if (legacyWorkspace.legacyDirs.length > 0) note$1(formatLegacyWorkspaceWarning(legacyWorkspace), "Extra workspace");
	const skillsReport = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
	note$1([
		`Eligible: ${skillsReport.skills.filter((s) => s.eligible).length}`,
		`Missing requirements: ${skillsReport.skills.filter((s) => !s.eligible && !s.disabled && !s.blockedByAllowlist).length}`,
		`Blocked by allowlist: ${skillsReport.skills.filter((s) => s.blockedByAllowlist).length}`
	].join("\n"), "Skills status");
	const pluginRegistry = loadOpenClawPlugins({
		config: cfg,
		workspaceDir,
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {}
		}
	});
	if (pluginRegistry.plugins.length > 0) {
		const loaded = pluginRegistry.plugins.filter((p) => p.status === "loaded");
		const disabled = pluginRegistry.plugins.filter((p) => p.status === "disabled");
		const errored = pluginRegistry.plugins.filter((p) => p.status === "error");
		note$1([
			`Loaded: ${loaded.length}`,
			`Disabled: ${disabled.length}`,
			`Errors: ${errored.length}`,
			errored.length > 0 ? `- ${errored.slice(0, 10).map((p) => p.id).join("\n- ")}${errored.length > 10 ? "\n- ..." : ""}` : null
		].filter((line) => Boolean(line)).join("\n"), "Plugins");
	}
	if (pluginRegistry.diagnostics.length > 0) note$1(pluginRegistry.diagnostics.map((diag) => {
		const prefix = diag.level.toUpperCase();
		const plugin = diag.pluginId ? ` ${diag.pluginId}` : "";
		const source = diag.source ? ` (${diag.source})` : "";
		return `- ${prefix}${plugin}: ${diag.message}${source}`;
	}).join("\n"), "Plugin diagnostics");
	return { workspaceDir };
}

//#endregion
//#region src/commands/doctor.ts
const intro$1 = (message) => intro(stylePromptTitle(message) ?? message);
const outro$1 = (message) => outro(stylePromptTitle(message) ?? message);
function resolveMode(cfg) {
	return cfg.gateway?.mode === "remote" ? "remote" : "local";
}
async function doctorCommand(runtime = defaultRuntime, options = {}) {
	const prompter = createDoctorPrompter({
		runtime,
		options
	});
	printWizardHeader(runtime);
	intro$1("OpenClaw doctor");
	const root = await resolveOpenClawPackageRoot({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	});
	if ((await maybeOfferUpdateBeforeDoctor({
		runtime,
		options,
		root,
		confirm: (p) => prompter.confirm(p),
		outro: outro$1
	})).handled) return;
	await maybeRepairUiProtocolFreshness(runtime, prompter);
	noteSourceInstallIssues(root);
	noteDeprecatedLegacyEnvVars();
	const configResult = await loadAndMaybeMigrateDoctorConfig({
		options,
		confirm: (p) => prompter.confirm(p)
	});
	let cfg = configResult.cfg;
	const cfgForPersistence = structuredClone(cfg);
	const sourceConfigValid = configResult.sourceConfigValid ?? true;
	const configPath = configResult.path ?? CONFIG_PATH;
	if (!cfg.gateway?.mode) {
		const lines = [
			"gateway.mode is unset; gateway start will be blocked.",
			`Fix: run ${formatCliCommand("openclaw configure")} and set Gateway mode (local/remote).`,
			`Or set directly: ${formatCliCommand("openclaw config set gateway.mode local")}`
		];
		if (!fs.existsSync(configPath)) lines.push(`Missing config: run ${formatCliCommand("openclaw setup")} first.`);
		note$1(lines.join("\n"), "Gateway");
	}
	cfg = await maybeRepairAnthropicOAuthProfileId(cfg, prompter);
	cfg = await maybeRemoveDeprecatedCliAuthProfiles(cfg, prompter);
	await noteAuthProfileHealth({
		cfg,
		prompter,
		allowKeychainPrompt: options.nonInteractive !== true && Boolean(process.stdin.isTTY)
	});
	const gatewayDetails = buildGatewayConnectionDetails({ config: cfg });
	if (gatewayDetails.remoteFallbackNote) note$1(gatewayDetails.remoteFallbackNote, "Gateway");
	if (resolveMode(cfg) === "local" && sourceConfigValid) {
		const auth = resolveGatewayAuth({
			authConfig: cfg.gateway?.auth,
			tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off"
		});
		if (auth.mode !== "password" && (auth.mode !== "token" || !auth.token)) {
			note$1("Gateway auth is off or missing a token. Token auth is now the recommended default (including loopback).", "Gateway auth");
			if (options.generateGatewayToken === true ? true : options.nonInteractive === true ? false : await prompter.confirmRepair({
				message: "Generate and configure a gateway token now?",
				initialValue: true
			})) {
				const nextToken = randomToken();
				cfg = {
					...cfg,
					gateway: {
						...cfg.gateway,
						auth: {
							...cfg.gateway?.auth,
							mode: "token",
							token: nextToken
						}
					}
				};
				note$1("Gateway token configured.", "Gateway auth");
			}
		}
	}
	const legacyState = await detectLegacyStateMigrations({ cfg });
	if (legacyState.preview.length > 0) {
		note$1(legacyState.preview.join("\n"), "Legacy state detected");
		if (options.nonInteractive === true ? true : await prompter.confirm({
			message: "Migrate legacy state (sessions/agent/WhatsApp auth) now?",
			initialValue: true
		})) {
			const migrated = await runLegacyStateMigrations({ detected: legacyState });
			if (migrated.changes.length > 0) note$1(migrated.changes.join("\n"), "Doctor changes");
			if (migrated.warnings.length > 0) note$1(migrated.warnings.join("\n"), "Doctor warnings");
		}
	}
	await noteStateIntegrity(cfg, prompter, configResult.path ?? CONFIG_PATH);
	await noteSessionLockHealth({ shouldRepair: prompter.shouldRepair });
	cfg = await maybeRepairSandboxImages(cfg, runtime, prompter);
	noteSandboxScopeWarnings(cfg);
	await maybeScanExtraGatewayServices(options, runtime, prompter);
	await maybeRepairGatewayServiceConfig(cfg, resolveMode(cfg), runtime, prompter);
	await noteMacLaunchAgentOverrides();
	await noteMacLaunchctlGatewayEnvOverrides(cfg);
	await noteSecurityWarnings(cfg);
	if (cfg.hooks?.gmail?.model?.trim()) {
		const hooksModelRef = resolveHooksGmailModel({
			cfg,
			defaultProvider: DEFAULT_PROVIDER
		});
		if (!hooksModelRef) note$1(`- hooks.gmail.model "${cfg.hooks.gmail.model}" could not be resolved`, "Hooks");
		else {
			const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
				cfg,
				defaultProvider: DEFAULT_PROVIDER,
				defaultModel: DEFAULT_MODEL
			});
			const catalog = await loadModelCatalog({ config: cfg });
			const status = getModelRefStatus({
				cfg,
				catalog,
				ref: hooksModelRef,
				defaultProvider,
				defaultModel
			});
			const warnings = [];
			if (!status.allowed) warnings.push(`- hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`);
			if (!status.inCatalog) warnings.push(`- hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`);
			if (warnings.length > 0) note$1(warnings.join("\n"), "Hooks");
		}
	}
	if (options.nonInteractive !== true && process.platform === "linux" && resolveMode(cfg) === "local") {
		const service = resolveGatewayService();
		let loaded = false;
		try {
			loaded = await service.isLoaded({ env: process.env });
		} catch {
			loaded = false;
		}
		if (loaded) await ensureSystemdUserLingerInteractive({
			runtime,
			prompter: {
				confirm: async (p) => prompter.confirm(p),
				note: note$1
			},
			reason: "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
			requireConfirm: true
		});
	}
	noteWorkspaceStatus(cfg);
	await doctorShellCompletion(runtime, prompter, { nonInteractive: options.nonInteractive });
	const { healthOk } = await checkGatewayHealth({
		runtime,
		cfg,
		timeoutMs: options.nonInteractive === true ? 3e3 : 1e4
	});
	const gatewayMemoryProbe = healthOk ? await probeGatewayMemoryStatus({
		cfg,
		timeoutMs: options.nonInteractive === true ? 3e3 : 1e4
	}) : {
		checked: false,
		ready: false
	};
	await noteMemorySearchHealth(cfg, { gatewayMemoryProbe });
	await maybeRepairGatewayDaemon({
		cfg,
		runtime,
		prompter,
		options,
		gatewayDetailsMessage: gatewayDetails.message,
		healthOk
	});
	if (configResult.shouldWriteConfig || JSON.stringify(cfg) !== JSON.stringify(cfgForPersistence)) {
		cfg = applyWizardMetadata(cfg, {
			command: "doctor",
			mode: resolveMode(cfg)
		});
		await writeConfigFile(cfg);
		logConfigUpdated(runtime);
		const backupPath = `${CONFIG_PATH}.bak`;
		if (fs.existsSync(backupPath)) runtime.log(`Backup: ${shortenHomePath(backupPath)}`);
	} else if (!prompter.shouldRepair) runtime.log(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply changes.`);
	if (options.workspaceSuggestions !== false) {
		const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
		noteWorkspaceBackupTip(workspaceDir);
		if (await shouldSuggestMemorySystem(workspaceDir)) note$1(MEMORY_SYSTEM_PROMPT, "Workspace");
	}
	const finalSnapshot = await readConfigFileSnapshot();
	if (finalSnapshot.exists && !finalSnapshot.valid) {
		runtime.error("Invalid config:");
		for (const issue of finalSnapshot.issues) {
			const path = issue.path || "<root>";
			runtime.error(`- ${path}: ${issue.message}`);
		}
	}
	outro$1("Doctor complete.");
}

//#endregion
//#region src/terminal/prompt-select-styled.ts
function selectStyled(params) {
	return select({
		...params,
		message: stylePromptMessage(params.message),
		options: params.options.map((opt) => opt.hint === void 0 ? opt : {
			...opt,
			hint: stylePromptHint(opt.hint)
		})
	});
}

//#endregion
export { doctorCommand as n, selectStyled as t };