import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveGatewayPort, p as resolveIsNixMode } from "./paths-Cw7f9XhU.js";
import { m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import { a as OPENCLAW_WRAPPER_ENV_KEY } from "./daemon-install-plan.shared-6_gPBjOK.js";
import { n as buildGatewayInstallPlan } from "./auth-install-policy-BV9KSYis.js";
import { f as uninstallLegacySystemdUnits, i as isSystemdUnitActive, x as readManagedServiceEnvKeysFromEnvironment } from "./systemd-DsQkjgIm.js";
import { a as resolveSystemNodeInfo, r as renderSystemNodeWarning } from "./runtime-paths-DHAgI0A5.js";
import { t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-C5rLdYLT.js";
import { t as resolveGatewayAuthToken } from "./auth-token-resolution-BXDTKdSY.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import { a as readEmbeddedGatewayToken, i as needsNodeRuntimeMigration, n as auditGatewayServiceConfig, t as SERVICE_AUDIT_CODES } from "./service-audit-DwiTvjdX.js";
import "./config-B6Oplu5W.js";
import { i as resolveGatewayService } from "./service-CTzdMGsq.js";
import { i as renderGatewayServiceCleanupHints, n as findExtraGatewayServices } from "./inspect-z8z06zzv.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { t as summarizeGatewayServiceLayout } from "./service-layout-B6U4GQmd.js";
import { a as resolveServiceRepairPolicy, i as isServiceRepairExternallyManaged, r as confirmDoctorServiceRepair, t as EXTERNAL_SERVICE_REPAIR_NOTE } from "./doctor-service-repair-policy-LxeeO6r9.js";
import { t as isDoctorUpdateRepairMode } from "./doctor-repair-mode-BP5nXXgX.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/commands/doctor-gateway-auth-token.ts
async function resolveGatewayAuthTokenForService(cfg, env) {
	const resolved = await resolveGatewayAuthToken({
		cfg,
		env,
		unresolvedReasonStyle: "detailed",
		envFallback: "always"
	});
	if (resolved.token) return { token: resolved.token };
	if (!resolved.secretRefConfigured) return {};
	if (resolved.unresolvedRefReason?.includes("resolved to an empty value")) return { unavailableReason: resolved.unresolvedRefReason };
	return { unavailableReason: `gateway.auth.token SecretRef is configured but unresolved (${resolved.unresolvedRefReason ?? "unknown reason"}).` };
}
//#endregion
//#region src/commands/doctor-gateway-services.ts
const execFileAsync = promisify(execFile);
const EXECSTART_REPAIR_CODES = new Set([SERVICE_AUDIT_CODES.gatewayCommandMissing, SERVICE_AUDIT_CODES.gatewayEntrypointMismatch]);
function detectGatewayRuntime(programArguments) {
	const first = programArguments?.[0];
	if (first) {
		const base = normalizeLowercaseStringOrEmpty(path.basename(first));
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
function buildGatewayServiceRepairEnv(command) {
	const wrapperPath = command?.environment?.[OPENCLAW_WRAPPER_ENV_KEY]?.trim();
	if (!wrapperPath || Object.hasOwn(process.env, "OPENCLAW_WRAPPER")) return process.env;
	return {
		...process.env,
		[OPENCLAW_WRAPPER_ENV_KEY]: wrapperPath
	};
}
function resolveGatewayServiceWrapperPath(command) {
	return normalizeOptionalString(command?.environment?.["OPENCLAW_WRAPPER"]) ?? null;
}
async function buildExpectedGatewayServicePlan(params) {
	return buildGatewayInstallPlan({
		env: params.serviceInstallEnv,
		port: params.port,
		runtime: params.runtime,
		nodePath: params.nodePath,
		existingEnvironment: params.command.environment,
		existingEnvironmentValueSources: params.command.environmentValueSources,
		warn: (message, title) => note(message, title),
		config: params.cfg
	});
}
async function buildGatewayServiceAuditInputs(params) {
	const port = resolveGatewayPort(params.cfg, process.env);
	const runtimeChoice = detectGatewayRuntime(params.command.programArguments);
	const expectedPlan = await buildExpectedGatewayServicePlan({
		cfg: params.cfg,
		command: params.command,
		serviceInstallEnv: params.serviceInstallEnv,
		port,
		runtime: runtimeChoice
	});
	return {
		expectedManagedServiceEnvKeys: readManagedServiceEnvKeysFromEnvironment(expectedPlan.environment),
		expectedPlan,
		port,
		runtimeChoice
	};
}
async function normalizeExecutablePath(value) {
	const resolvedPath = path.resolve(value);
	try {
		return await fs.realpath(resolvedPath);
	} catch {
		return resolvedPath;
	}
}
function extractDetailPath(detail, prefix) {
	if (!detail.startsWith(prefix)) return null;
	const value = detail.slice(prefix.length).trim();
	return value.length > 0 ? value : null;
}
function isExecStartRepairIssue(issue) {
	return EXECSTART_REPAIR_CODES.has(issue.code);
}
function resolveSystemdScopeFromServicePath(sourcePath) {
	const normalized = sourcePath?.replaceAll("\\", "/") ?? "";
	return normalized.startsWith("/etc/systemd/") || normalized.startsWith("/usr/lib/systemd/") || normalized.startsWith("/lib/systemd/") ? "system" : "user";
}
function resolveSystemdUnitNameFromServicePath(sourcePath) {
	const base = sourcePath ? path.posix.basename(sourcePath.replaceAll("\\", "/")) : "";
	return base.endsWith(".service") ? base : "openclaw-gateway.service";
}
function shouldDeferUpdateModeSystemdServiceRepair(params) {
	return process.platform === "linux" && isDoctorUpdateRepairMode(params.repairMode) && !params.shouldForce;
}
async function suppressRunningSystemdExecStartRepairs(params) {
	if (process.platform !== "linux") return false;
	if (!params.issues.some(isExecStartRepairIssue)) return false;
	const unitName = resolveSystemdUnitNameFromServicePath(params.command.sourcePath);
	const scope = resolveSystemdScopeFromServicePath(params.command.sourcePath);
	if (!await isSystemdUnitActive(process.env, unitName, scope)) return false;
	const before = params.issues.length;
	params.issues.splice(0, params.issues.length, ...params.issues.filter((issue) => !isExecStartRepairIssue(issue)));
	if (params.issues.length !== before) note(`Gateway service ${unitName} is running; skipped command/entrypoint rewrites for this doctor pass.`, "Gateway service config");
	return true;
}
async function filterInactiveExtraGatewayServices(services) {
	if (process.platform !== "linux") return services;
	const activeOrLegacy = [];
	for (const svc of services) {
		if (svc.platform !== "linux" || svc.legacy === true) {
			activeOrLegacy.push(svc);
			continue;
		}
		if (await isSystemdUnitActive(process.env, svc.label, svc.scope)) activeOrLegacy.push(svc);
	}
	return activeOrLegacy;
}
async function cleanupLegacyLaunchdService(params) {
	await execFileAsync("launchctl", [
		"bootout",
		typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501",
		params.plistPath
	]).catch(() => void 0);
	await execFileAsync("launchctl", ["unload", params.plistPath]).catch(() => void 0);
	const trashDir = path.join(os.homedir(), ".Trash");
	try {
		await fs.mkdir(trashDir, { recursive: true });
	} catch {}
	try {
		await fs.access(params.plistPath);
	} catch {
		return null;
	}
	const dest = path.join(trashDir, `${params.label}-${Date.now()}.plist`);
	try {
		await fs.rename(params.plistPath, dest);
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
		note("Nix mode detected; skip service updates.", "Gateway");
		return;
	}
	if (mode === "remote") {
		note("Gateway mode is remote; skipped local service audit.", "Gateway");
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
	const serviceInstallEnv = buildGatewayServiceRepairEnv(command);
	const serviceWrapperPath = resolveGatewayServiceWrapperPath(command);
	if (serviceWrapperPath) note(`Gateway service invokes ${OPENCLAW_WRAPPER_ENV_KEY}: ${serviceWrapperPath}`, "Gateway");
	const serviceLayout = await summarizeGatewayServiceLayout(command);
	const sourceCheckoutWarning = serviceLayout?.entrypointSourceCheckout ? [`Gateway service entrypoint resolves to a source checkout: ${serviceLayout.packageRootReal ?? serviceLayout.packageRoot ?? serviceLayout.entrypointReal ?? serviceLayout.entrypoint}.`, "Run `openclaw doctor --fix` from the intended package install, or reinstall the gateway service with `openclaw gateway install --force`."].join("\n") : null;
	const tokenRefConfigured = Boolean(resolveSecretInputRef({
		value: cfg.gateway?.auth?.token,
		defaults: cfg.secrets?.defaults
	}).ref);
	const gatewayTokenResolution = await resolveGatewayAuthTokenForService(cfg, process.env);
	if (gatewayTokenResolution.unavailableReason) note(`Unable to verify gateway service token drift: ${gatewayTokenResolution.unavailableReason}`, "Gateway service config");
	const expectedGatewayToken = tokenRefConfigured ? void 0 : gatewayTokenResolution.token;
	const { expectedManagedServiceEnvKeys, expectedPlan, port, runtimeChoice } = await buildGatewayServiceAuditInputs({
		cfg,
		command,
		serviceInstallEnv
	});
	const audit = await auditGatewayServiceConfig({
		env: process.env,
		command,
		expectedGatewayToken,
		expectedManagedServiceEnvKeys,
		expectedServicePath: expectedPlan.environment.PATH,
		expectedPort: port
	});
	const serviceToken = readEmbeddedGatewayToken(command);
	if (tokenRefConfigured && serviceToken) audit.issues.push({
		code: SERVICE_AUDIT_CODES.gatewayTokenMismatch,
		message: "Gateway service OPENCLAW_GATEWAY_TOKEN should be unset when gateway.auth.token is SecretRef-managed",
		detail: "service token is stale",
		level: "recommended"
	});
	const needsNodeRuntime = needsNodeRuntimeMigration(audit.issues);
	const systemNodeInfo = needsNodeRuntime ? await resolveSystemNodeInfo({ env: process.env }) : null;
	const systemNodePath = systemNodeInfo?.supported ? systemNodeInfo.path : null;
	if (needsNodeRuntime && !systemNodePath && runtimeChoice !== "node") {
		const warning = renderSystemNodeWarning(systemNodeInfo);
		if (warning) note(warning, "Gateway runtime");
		else note("System Node 22 LTS (22.19+) or Node 24 not found. Install via Homebrew/apt/choco and rerun doctor to migrate off Bun/version managers.", "Gateway runtime");
	}
	const { programArguments } = needsNodeRuntime && systemNodePath ? await buildExpectedGatewayServicePlan({
		cfg,
		command,
		serviceInstallEnv,
		port,
		runtime: "node",
		nodePath: systemNodePath
	}) : expectedPlan;
	const expectedEntrypoint = findGatewayEntrypoint(programArguments);
	const currentEntrypoint = findGatewayEntrypoint(command.programArguments);
	const normalizedExpectedEntrypoint = expectedEntrypoint ? await normalizeExecutablePath(expectedEntrypoint) : null;
	const normalizedCurrentEntrypoint = currentEntrypoint ? await normalizeExecutablePath(currentEntrypoint) : null;
	if (normalizedExpectedEntrypoint && normalizedCurrentEntrypoint && normalizedExpectedEntrypoint !== normalizedCurrentEntrypoint) audit.issues.push({
		code: SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
		message: "Gateway service entrypoint does not match the current install.",
		detail: `${currentEntrypoint} -> ${expectedEntrypoint}`,
		level: "recommended"
	});
	const serviceRewriteBlocked = await suppressRunningSystemdExecStartRepairs({
		command,
		issues: audit.issues
	});
	const hasEntrypointMismatch = audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayEntrypointMismatch);
	const showSourceCheckoutWarning = sourceCheckoutWarning !== null && !hasEntrypointMismatch;
	if (audit.issues.length === 0) {
		if (sourceCheckoutWarning !== null && !hasEntrypointMismatch) note(sourceCheckoutWarning, "Gateway service config");
		return;
	}
	const serviceRepairExternal = isServiceRepairExternallyManaged(resolveServiceRepairPolicy());
	const consolidatedLines = [];
	let emittedSourceCheckoutWarning = false;
	if (sourceCheckoutWarning !== null && showSourceCheckoutWarning) {
		consolidatedLines.push(sourceCheckoutWarning);
		consolidatedLines.push("");
		emittedSourceCheckoutWarning = true;
	}
	consolidatedLines.push(...audit.issues.map((issue) => issue.detail ? `- ${issue.message} (${issue.detail})` : `- ${issue.message}`));
	note(consolidatedLines.join("\n"), "Gateway service config");
	const needsAggressive = audit.issues.filter((issue) => issue.level === "aggressive").length > 0;
	if (needsAggressive && !prompter.shouldForce) note("Custom or unexpected service edits detected. Rerun with --force to overwrite.", "Gateway service config");
	if (serviceRepairExternal) {
		note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway service config");
		return;
	}
	if (serviceRewriteBlocked) {
		note("Gateway service is running; leaving supervisor metadata unchanged. Stop the service first or use `openclaw gateway install --force` when you want to replace the active launcher.", "Gateway service config");
		return;
	}
	const updateRepairMode = isDoctorUpdateRepairMode(prompter.repairMode);
	if (shouldDeferUpdateModeSystemdServiceRepair({
		repairMode: prompter.repairMode,
		shouldForce: prompter.shouldForce
	})) {
		note("Update-mode doctor detected gateway service drift but left the live systemd unit unchanged. Review the service file and run `openclaw gateway install --force` when you want OpenClaw to replace operator-owned systemd directives.", "Gateway service config");
		return;
	}
	const repairMessage = needsAggressive ? "Overwrite gateway service config with current defaults now?" : "Update gateway service config to the recommended defaults now?";
	if (!(updateRepairMode ? needsAggressive ? await prompter.confirmAggressiveAutoFix({
		message: repairMessage,
		initialValue: prompter.shouldForce
	}) : await prompter.confirmAutoFix({
		message: repairMessage,
		initialValue: true
	}) : await prompter.confirmRuntimeRepair({
		message: repairMessage,
		initialValue: needsAggressive ? prompter.shouldForce : true,
		requiresInteractiveConfirmation: true
	}))) {
		if (!emittedSourceCheckoutWarning) note("Run `openclaw gateway install --force` when you want to replace the gateway service definition.", "Gateway service config");
		return;
	}
	const serviceEmbeddedToken = readEmbeddedGatewayToken(command);
	const gatewayTokenForRepair = expectedGatewayToken ?? serviceEmbeddedToken;
	const configuredGatewayToken = typeof cfg.gateway?.auth?.token === "string" ? normalizeOptionalString(cfg.gateway.auth.token) : void 0;
	let cfgForServiceInstall = cfg;
	if (!updateRepairMode && !tokenRefConfigured && !configuredGatewayToken && gatewayTokenForRepair) {
		const nextCfg = {
			...cfg,
			gateway: {
				...cfg.gateway,
				auth: {
					...cfg.gateway?.auth,
					mode: cfg.gateway?.auth?.mode ?? "token",
					token: gatewayTokenForRepair
				}
			}
		};
		try {
			await replaceConfigFile({
				nextConfig: nextCfg,
				afterWrite: { mode: "auto" }
			});
			cfgForServiceInstall = nextCfg;
			note(expectedGatewayToken ? "Persisted gateway.auth.token from environment before reinstalling service." : "Persisted gateway.auth.token from existing service definition before reinstalling service.", "Gateway");
		} catch (err) {
			runtime.error(`Failed to persist gateway.auth.token before service repair: ${String(err)}`);
			return;
		}
	}
	const updatedPort = resolveGatewayPort(cfgForServiceInstall, process.env);
	const updatedPlan = await buildExpectedGatewayServicePlan({
		cfg: cfgForServiceInstall,
		command,
		serviceInstallEnv,
		port: updatedPort,
		runtime: needsNodeRuntime && systemNodePath ? "node" : runtimeChoice,
		nodePath: systemNodePath ?? void 0
	});
	try {
		await (updateRepairMode ? service.stage : service.install)({
			env: serviceInstallEnv,
			stdout: process.stdout,
			programArguments: updatedPlan.programArguments,
			workingDirectory: updatedPlan.workingDirectory,
			environment: updatedPlan.environment,
			environmentValueSources: updatedPlan.environmentValueSources
		});
	} catch (err) {
		runtime.error(`Gateway service update failed: ${String(err)}`);
	}
}
async function maybeScanExtraGatewayServices(options, runtime, prompter) {
	const extraServices = await filterInactiveExtraGatewayServices(await findExtraGatewayServices(process.env, { deep: options.deep }));
	if (extraServices.length === 0) return;
	note(extraServices.map((svc) => `- ${svc.label} (${svc.scope}, ${svc.detail})`).join("\n"), "Other gateway-like services detected");
	const legacyServices = extraServices.filter((svc) => svc.legacy === true);
	if (legacyServices.length > 0) {
		const serviceRepairPolicy = resolveServiceRepairPolicy();
		const serviceRepairExternal = isServiceRepairExternallyManaged(serviceRepairPolicy);
		if (serviceRepairExternal) note(EXTERNAL_SERVICE_REPAIR_NOTE, "Legacy gateway cleanup skipped");
		if (serviceRepairExternal ? false : await confirmDoctorServiceRepair(prompter, {
			message: "Remove legacy gateway services now?",
			initialValue: true
		}, serviceRepairPolicy)) {
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
			if (removed.length > 0) note(removed.map((line) => `- ${line}`).join("\n"), "Legacy gateway removed");
			if (failed.length > 0) note(failed.map((line) => `- ${line}`).join("\n"), "Legacy gateway cleanup skipped");
			if (removed.length > 0) runtime.log("Legacy gateway services removed. Installing OpenClaw gateway next.");
		}
	}
	const cleanupHints = renderGatewayServiceCleanupHints();
	if (cleanupHints.length > 0) note(cleanupHints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
	note([
		"Recommendation: run a single gateway per machine for most setups.",
		"One gateway supports multiple agents.",
		"If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host)."
	].join("\n"), "Gateway recommendation");
}
//#endregion
export { maybeRepairGatewayServiceConfig, maybeScanExtraGatewayServices };
