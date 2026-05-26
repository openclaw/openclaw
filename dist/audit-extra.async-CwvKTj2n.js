import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { _ as resolveOAuthDir } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { n as MANIFEST_KEY } from "./legacy-names-CuutNmLC.js";
import { t as extensionUsesSkippedScannerPath } from "./scan-paths-BJFKmVji.js";
import { t as collectIncludePathsRecursive } from "./includes-scan-BhUwImvk.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/security/installed-plugin-dirs.ts
const IGNORED_INSTALLED_PLUGIN_DIR_NAMES = new Set(["node_modules", ".openclaw-install-backups"]);
function shouldIgnoreInstalledPluginDirName(name) {
	const normalized = normalizeOptionalLowercaseString(name);
	if (!normalized) return true;
	if (IGNORED_INSTALLED_PLUGIN_DIR_NAMES.has(normalized)) return true;
	if (normalized.startsWith(".")) return true;
	if (normalized.endsWith(".bak")) return true;
	if (normalized.includes(".backup-")) return true;
	if (normalized.includes(".disabled")) return true;
	return false;
}
//#endregion
//#region src/security/audit-extra.async.ts
/**
* Asynchronous security audit collector functions.
*
* These functions perform I/O (filesystem, config reads) to detect security issues.
*/
let skillsModulePromise;
let configModulePromise;
let agentScopeModulePromise;
let agentWorkspaceDirsModulePromise;
let skillSourceModulePromise;
let sandboxDockerModulePromise;
let sandboxConstantsModulePromise;
let auditFsModulePromise;
let skillScannerModulePromise;
function loadSkillsModule() {
	skillsModulePromise ??= import("./skills-Bcm7ote3.js");
	return skillsModulePromise;
}
function loadConfigModule() {
	configModulePromise ??= import("./config/config.js");
	return configModulePromise;
}
function loadAuditFsModule() {
	auditFsModulePromise ??= import("./audit-fs-CEGYtID4.js");
	return auditFsModulePromise;
}
function loadAgentScopeModule() {
	agentScopeModulePromise ??= import("./agent-scope-CwTibfHH.js");
	return agentScopeModulePromise;
}
function loadAgentWorkspaceDirsModule() {
	agentWorkspaceDirsModulePromise ??= import("./workspace-dirs-BwPBp2cx.js");
	return agentWorkspaceDirsModulePromise;
}
function loadSkillSourceModule() {
	skillSourceModulePromise ??= import("./source-BATVidNN.js");
	return skillSourceModulePromise;
}
function loadSkillScannerModule() {
	skillScannerModulePromise ??= import("./skill-scanner-CHLDudER.js");
	return skillScannerModulePromise;
}
async function loadExecDockerRaw() {
	sandboxDockerModulePromise ??= import("./docker-mJm7xzj5.js");
	const { execDockerRaw } = await sandboxDockerModulePromise;
	return execDockerRaw;
}
async function loadSandboxBrowserSecurityHashEpoch() {
	sandboxConstantsModulePromise ??= import("./constants-BO5UBxlr.js");
	const { SANDBOX_BROWSER_SECURITY_HASH_EPOCH } = await sandboxConstantsModulePromise;
	return SANDBOX_BROWSER_SECURITY_HASH_EPOCH;
}
async function safeStat(targetPath) {
	try {
		const lst = await fs.lstat(targetPath);
		return {
			ok: true,
			isSymlink: lst.isSymbolicLink(),
			isDir: lst.isDirectory(),
			mode: typeof lst.mode === "number" ? lst.mode : null,
			uid: typeof lst.uid === "number" ? lst.uid : null,
			gid: typeof lst.gid === "number" ? lst.gid : null
		};
	} catch (err) {
		return {
			ok: false,
			isSymlink: false,
			isDir: false,
			mode: null,
			uid: null,
			gid: null,
			error: String(err)
		};
	}
}
function expandTilde(p, env) {
	if (!p.startsWith("~")) return p;
	const home = normalizeOptionalString(env.HOME) ?? null;
	if (!home) return null;
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
	return null;
}
async function readPluginManifestExtensions(pluginPath) {
	const manifestPath = path.join(pluginPath, "package.json");
	const raw = await fs.readFile(manifestPath, "utf-8").catch(() => "");
	if (!raw.trim()) return [];
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Failed to parse plugin manifest at ${manifestPath}: ${String(err)}`, { cause: err });
	}
	const extensions = parsed?.[MANIFEST_KEY]?.extensions;
	if (!Array.isArray(extensions)) return [];
	return extensions.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
}
function formatCodeSafetyDetails(findings, rootDir) {
	return findings.map((finding) => {
		const relPath = path.relative(rootDir, finding.file);
		const normalizedPath = (relPath && relPath !== "." && !relPath.startsWith("..") ? relPath : path.basename(finding.file)).replaceAll("\\", "/");
		return `  - [${finding.ruleId}] ${finding.message} (${normalizedPath}:${finding.line})`;
	}).join("\n");
}
async function listInstalledPluginDirs(params) {
	const extensionsDir = path.join(params.stateDir, "extensions");
	const st = await safeStat(extensionsDir);
	if (!st.ok || !st.isDir) return {
		extensionsDir,
		pluginDirs: []
	};
	return {
		extensionsDir,
		pluginDirs: (await fs.readdir(extensionsDir, { withFileTypes: true }).catch((err) => {
			params.onReadError?.(err);
			return [];
		})).filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((name) => !shouldIgnoreInstalledPluginDirName(name)).filter(Boolean)
	};
}
function buildCodeSafetySummaryCacheKey(params) {
	const includeFiles = (params.includeFiles ?? []).map((entry) => entry.trim()).filter(Boolean);
	const includeKey = includeFiles.length > 0 ? includeFiles.toSorted().join("\0") : "";
	return `${params.dirPath}\u0000${includeKey}`;
}
async function getCodeSafetySummary(params) {
	const cacheKey = buildCodeSafetySummaryCacheKey({
		dirPath: params.dirPath,
		includeFiles: params.includeFiles
	});
	const cache = params.summaryCache;
	if (cache) {
		const hit = cache.get(cacheKey);
		if (hit) return await hit;
		const pending = (await loadSkillScannerModule()).scanDirectoryWithSummary(params.dirPath, { includeFiles: params.includeFiles });
		cache.set(cacheKey, pending);
		return await pending;
	}
	return await (await loadSkillScannerModule()).scanDirectoryWithSummary(params.dirPath, { includeFiles: params.includeFiles });
}
function normalizeDockerLabelValue(raw) {
	const trimmed = normalizeOptionalString(raw) ?? "";
	if (!trimmed || trimmed === "<no value>") return null;
	return trimmed;
}
async function listSandboxBrowserContainers(execDockerRawFn) {
	try {
		const result = await execDockerRawFn([
			"ps",
			"-a",
			"--filter",
			"label=openclaw.sandboxBrowser=1",
			"--format",
			"{{.Names}}"
		], { allowFailure: true });
		if (result.code !== 0) return null;
		return result.stdout.toString("utf8").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
	} catch {
		return null;
	}
}
async function readSandboxBrowserHashLabels(params) {
	try {
		const result = await params.execDockerRawFn([
			"inspect",
			"-f",
			"{{ index .Config.Labels \"openclaw.configHash\" }}	{{ index .Config.Labels \"openclaw.browserConfigEpoch\" }}",
			params.containerName
		], { allowFailure: true });
		if (result.code !== 0) return null;
		const [hashRaw, epochRaw] = result.stdout.toString("utf8").split("	");
		return {
			configHash: normalizeDockerLabelValue(hashRaw),
			epoch: normalizeDockerLabelValue(epochRaw)
		};
	} catch {
		return null;
	}
}
function parsePublishedHostFromDockerPortLine(line) {
	const trimmed = normalizeOptionalString(line) ?? "";
	const rhs = trimmed.includes("->") ? normalizeOptionalString(trimmed.split("->").at(-1)) ?? "" : trimmed;
	if (!rhs) return null;
	const bracketHost = rhs.match(/^\[([^\]]+)\]:\d+$/);
	if (bracketHost?.[1]) return bracketHost[1];
	const hostPort = rhs.match(/^([^:]+):\d+$/);
	if (hostPort?.[1]) return hostPort[1];
	return null;
}
function isLoopbackPublishHost(host) {
	const normalized = normalizeOptionalLowercaseString(host);
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
async function readSandboxBrowserPortMappings(params) {
	try {
		const result = await params.execDockerRawFn(["port", params.containerName], { allowFailure: true });
		if (result.code !== 0) return null;
		return result.stdout.toString("utf8").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
	} catch {
		return null;
	}
}
async function collectSandboxBrowserHashLabelFindings(params) {
	const findings = [];
	const [execFn, browserHashEpoch] = await Promise.all([params?.execDockerRawFn ? Promise.resolve(params.execDockerRawFn) : loadExecDockerRaw(), loadSandboxBrowserSecurityHashEpoch()]);
	const containers = await listSandboxBrowserContainers(execFn);
	if (!containers || containers.length === 0) return findings;
	const missingHash = [];
	const staleEpoch = [];
	const nonLoopbackPublished = [];
	for (const containerName of containers) {
		const labels = await readSandboxBrowserHashLabels({
			containerName,
			execDockerRawFn: execFn
		});
		if (!labels) continue;
		if (!labels.configHash) missingHash.push(containerName);
		if (labels.epoch !== browserHashEpoch) staleEpoch.push(containerName);
		const portMappings = await readSandboxBrowserPortMappings({
			containerName,
			execDockerRawFn: execFn
		});
		if (!portMappings?.length) continue;
		const exposedMappings = portMappings.filter((line) => {
			const host = parsePublishedHostFromDockerPortLine(line);
			return Boolean(host && !isLoopbackPublishHost(host));
		});
		if (exposedMappings.length > 0) nonLoopbackPublished.push(`${containerName} (${exposedMappings.join("; ")})`);
	}
	if (missingHash.length > 0) findings.push({
		checkId: "sandbox.browser_container.hash_label_missing",
		severity: "warn",
		title: "Sandbox browser container missing config hash label",
		detail: `Containers: ${missingHash.join(", ")}. These browser containers predate hash-based drift checks and may miss security remediations until recreated.`,
		remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`
	});
	if (staleEpoch.length > 0) findings.push({
		checkId: "sandbox.browser_container.hash_epoch_stale",
		severity: "warn",
		title: "Sandbox browser container hash epoch is stale",
		detail: `Containers: ${staleEpoch.join(", ")}. Expected openclaw.browserConfigEpoch=${browserHashEpoch}.`,
		remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`
	});
	if (nonLoopbackPublished.length > 0) findings.push({
		checkId: "sandbox.browser_container.non_loopback_publish",
		severity: "critical",
		title: "Sandbox browser container publishes ports on non-loopback interfaces",
		detail: `Containers: ${nonLoopbackPublished.join(", ")}. Sandbox browser observer/control ports should stay loopback-only to avoid unintended remote access.`,
		remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt), then verify published ports are bound to 127.0.0.1.`
	});
	return findings;
}
async function collectIncludeFilePermFindings(params) {
	const findings = [];
	if (!params.configSnapshot.exists) return findings;
	const configPath = params.configSnapshot.path;
	const includePaths = await collectIncludePathsRecursive({
		configPath,
		parsed: params.configSnapshot.parsed
	});
	if (includePaths.length === 0) return findings;
	const { formatPermissionDetail, formatPermissionRemediation, inspectPathPermissions } = await loadAuditFsModule();
	for (const p of includePaths) {
		const perms = await inspectPathPermissions(p, {
			env: params.env,
			platform: params.platform,
			exec: params.execIcacls
		});
		if (!perms.ok) continue;
		if (perms.worldWritable || perms.groupWritable) findings.push({
			checkId: "fs.config_include.perms_writable",
			severity: "critical",
			title: "Config include file is writable by others",
			detail: `${formatPermissionDetail(p, perms)}; another user could influence your effective config.`,
			remediation: formatPermissionRemediation({
				targetPath: p,
				perms,
				isDir: false,
				posixMode: 384,
				env: params.env
			})
		});
		else if (perms.worldReadable) findings.push({
			checkId: "fs.config_include.perms_world_readable",
			severity: "critical",
			title: "Config include file is world-readable",
			detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
			remediation: formatPermissionRemediation({
				targetPath: p,
				perms,
				isDir: false,
				posixMode: 384,
				env: params.env
			})
		});
		else if (perms.groupReadable) findings.push({
			checkId: "fs.config_include.perms_group_readable",
			severity: "warn",
			title: "Config include file is group-readable",
			detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
			remediation: formatPermissionRemediation({
				targetPath: p,
				perms,
				isDir: false,
				posixMode: 384,
				env: params.env
			})
		});
	}
	return findings;
}
async function collectStateDeepFilesystemFindings(params) {
	const findings = [];
	const oauthDir = resolveOAuthDir(params.env, params.stateDir);
	const { formatPermissionDetail, formatPermissionRemediation, inspectPathPermissions } = await loadAuditFsModule();
	const oauthPerms = await inspectPathPermissions(oauthDir, {
		env: params.env,
		platform: params.platform,
		exec: params.execIcacls
	});
	if (oauthPerms.ok && oauthPerms.isDir) {
		if (oauthPerms.worldWritable || oauthPerms.groupWritable) findings.push({
			checkId: "fs.credentials_dir.perms_writable",
			severity: "critical",
			title: "Credentials dir is writable by others",
			detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; another user could drop/modify credential files.`,
			remediation: formatPermissionRemediation({
				targetPath: oauthDir,
				perms: oauthPerms,
				isDir: true,
				posixMode: 448,
				env: params.env
			})
		});
		else if (oauthPerms.groupReadable || oauthPerms.worldReadable) findings.push({
			checkId: "fs.credentials_dir.perms_readable",
			severity: "warn",
			title: "Credentials dir is readable by others",
			detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; credentials and allowlists can be sensitive.`,
			remediation: formatPermissionRemediation({
				targetPath: oauthDir,
				perms: oauthPerms,
				isDir: true,
				posixMode: 448,
				env: params.env
			})
		});
	}
	const agentIds = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents?.list.map((a) => normalizeOptionalString(a && typeof a === "object" ? a.id : void 0) ?? "").filter(Boolean) : [];
	const { resolveDefaultAgentId } = await loadAgentScopeModule();
	const defaultAgentId = resolveDefaultAgentId(params.cfg);
	const ids = Array.from(new Set([defaultAgentId, ...agentIds])).map((id) => normalizeAgentId(id));
	for (const agentId of ids) {
		const agentDir = path.join(params.stateDir, "agents", agentId, "agent");
		const authPath = path.join(agentDir, "auth-profiles.json");
		const authPerms = await inspectPathPermissions(authPath, {
			env: params.env,
			platform: params.platform,
			exec: params.execIcacls
		});
		if (authPerms.ok) {
			if (authPerms.worldWritable || authPerms.groupWritable) findings.push({
				checkId: "fs.auth_profiles.perms_writable",
				severity: "critical",
				title: "auth-profiles.json is writable by others",
				detail: `${formatPermissionDetail(authPath, authPerms)}; another user could inject credentials.`,
				remediation: formatPermissionRemediation({
					targetPath: authPath,
					perms: authPerms,
					isDir: false,
					posixMode: 384,
					env: params.env
				})
			});
			else if (authPerms.worldReadable || authPerms.groupReadable) findings.push({
				checkId: "fs.auth_profiles.perms_readable",
				severity: "warn",
				title: "auth-profiles.json is readable by others",
				detail: `${formatPermissionDetail(authPath, authPerms)}; auth-profiles.json contains API keys and OAuth tokens.`,
				remediation: formatPermissionRemediation({
					targetPath: authPath,
					perms: authPerms,
					isDir: false,
					posixMode: 384,
					env: params.env
				})
			});
		}
		const storePath = path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
		const storePerms = await inspectPathPermissions(storePath, {
			env: params.env,
			platform: params.platform,
			exec: params.execIcacls
		});
		if (storePerms.ok) {
			if (storePerms.worldReadable || storePerms.groupReadable) findings.push({
				checkId: "fs.sessions_store.perms_readable",
				severity: "warn",
				title: "sessions.json is readable by others",
				detail: `${formatPermissionDetail(storePath, storePerms)}; routing and transcript metadata can be sensitive.`,
				remediation: formatPermissionRemediation({
					targetPath: storePath,
					perms: storePerms,
					isDir: false,
					posixMode: 384,
					env: params.env
				})
			});
		}
	}
	const logFile = normalizeOptionalString(params.cfg.logging?.file) ?? "";
	if (logFile) {
		const expanded = logFile.startsWith("~") ? expandTilde(logFile, params.env) : logFile;
		if (expanded) {
			const logPath = path.resolve(expanded);
			const logPerms = await inspectPathPermissions(logPath, {
				env: params.env,
				platform: params.platform,
				exec: params.execIcacls
			});
			if (logPerms.ok) {
				if (logPerms.worldReadable || logPerms.groupReadable) findings.push({
					checkId: "fs.log_file.perms_readable",
					severity: "warn",
					title: "Log file is readable by others",
					detail: `${formatPermissionDetail(logPath, logPerms)}; logs can contain private messages and tool output.`,
					remediation: formatPermissionRemediation({
						targetPath: logPath,
						perms: logPerms,
						isDir: false,
						posixMode: 384,
						env: params.env
					})
				});
			}
		}
	}
	return findings;
}
async function readConfigSnapshotForAudit(params) {
	const { createConfigIO } = await loadConfigModule();
	return await createConfigIO({
		env: params.env,
		configPath: params.configPath
	}).readConfigFileSnapshot();
}
async function collectPluginsCodeSafetyFindings(params) {
	const findings = [];
	const { extensionsDir, pluginDirs } = await listInstalledPluginDirs({
		stateDir: params.stateDir,
		onReadError: (err) => {
			findings.push({
				checkId: "plugins.code_safety.scan_failed",
				severity: "warn",
				title: "Plugin extensions directory scan failed",
				detail: `Static code scan could not list extensions directory: ${String(err)}`,
				remediation: "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`."
			});
		}
	});
	for (const pluginName of pluginDirs) {
		const pluginPath = path.join(extensionsDir, pluginName);
		let extensionEntries = [];
		try {
			extensionEntries = await readPluginManifestExtensions(pluginPath);
		} catch (manifestErr) {
			findings.push({
				checkId: "plugins.code_safety.manifest_parse_error",
				severity: "warn",
				title: `Plugin "${pluginName}" has a malformed package.json`,
				detail: `Could not parse plugin manifest: ${String(manifestErr)}.\nThe extension entrypoint list is unavailable. Deep scan will cover the plugin directory but may miss entries declared via \`openclaw.extensions\`.`,
				remediation: "Inspect the plugin package.json for syntax errors. If the plugin is untrusted, remove it from your OpenClaw extensions state directory."
			});
		}
		const forcedScanEntries = [];
		const escapedEntries = [];
		for (const entry of extensionEntries) {
			const resolvedEntry = path.resolve(pluginPath, entry);
			if (!isPathInside(pluginPath, resolvedEntry)) {
				escapedEntries.push(entry);
				continue;
			}
			if (extensionUsesSkippedScannerPath(entry)) findings.push({
				checkId: "plugins.code_safety.entry_path",
				severity: "warn",
				title: `Plugin "${pluginName}" entry path is hidden or node_modules`,
				detail: `Extension entry "${entry}" points to a hidden or node_modules path. Deep code scan will cover this entry explicitly, but review this path choice carefully.`,
				remediation: "Prefer extension entrypoints under normal source paths like dist/ or src/."
			});
			forcedScanEntries.push(resolvedEntry);
		}
		if (escapedEntries.length > 0) findings.push({
			checkId: "plugins.code_safety.entry_escape",
			severity: "critical",
			title: `Plugin "${pluginName}" has extension entry path traversal`,
			detail: `Found extension entries that escape the plugin directory:\n${escapedEntries.map((entry) => `  - ${entry}`).join("\n")}`,
			remediation: "Update the plugin manifest so all openclaw.extensions entries stay inside the plugin directory."
		});
		const summary = await getCodeSafetySummary({
			dirPath: pluginPath,
			includeFiles: forcedScanEntries,
			summaryCache: params.summaryCache
		}).catch((err) => {
			findings.push({
				checkId: "plugins.code_safety.scan_failed",
				severity: "warn",
				title: `Plugin "${pluginName}" code scan failed`,
				detail: `Static code scan could not complete: ${String(err)}`,
				remediation: "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`."
			});
			return null;
		});
		if (!summary) continue;
		if (summary.critical > 0) {
			const details = formatCodeSafetyDetails(summary.findings.filter((f) => f.severity === "critical"), pluginPath);
			findings.push({
				checkId: "plugins.code_safety",
				severity: "critical",
				title: `Plugin "${pluginName}" contains dangerous code patterns`,
				detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
				remediation: "Review the plugin source code carefully before use. If untrusted, remove the plugin from your OpenClaw extensions state directory."
			});
		} else if (summary.warn > 0) {
			const details = formatCodeSafetyDetails(summary.findings.filter((f) => f.severity === "warn"), pluginPath);
			findings.push({
				checkId: "plugins.code_safety",
				severity: "warn",
				title: `Plugin "${pluginName}" contains suspicious code patterns`,
				detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
				remediation: `Review the flagged code to ensure it is intentional and safe.`
			});
		}
	}
	return findings;
}
async function collectInstalledSkillsCodeSafetyFindings(params) {
	const findings = [];
	const pluginExtensionsDir = path.join(params.stateDir, "extensions");
	const scannedSkillDirs = /* @__PURE__ */ new Set();
	const [{ listAgentWorkspaceDirs }, { resolveSkillSource }] = await Promise.all([loadAgentWorkspaceDirsModule(), loadSkillSourceModule()]);
	const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
	const { loadWorkspaceSkillEntries } = await loadSkillsModule();
	for (const workspaceDir of workspaceDirs) {
		const entries = loadWorkspaceSkillEntries(workspaceDir, { config: params.cfg });
		for (const entry of entries) {
			if (resolveSkillSource(entry.skill) === "openclaw-bundled") continue;
			const skillDir = path.resolve(entry.skill.baseDir);
			if (isPathInside(pluginExtensionsDir, skillDir)) continue;
			if (scannedSkillDirs.has(skillDir)) continue;
			scannedSkillDirs.add(skillDir);
			const skillName = entry.skill.name;
			const summary = await getCodeSafetySummary({
				dirPath: skillDir,
				summaryCache: params.summaryCache
			}).catch((err) => {
				findings.push({
					checkId: "skills.code_safety.scan_failed",
					severity: "warn",
					title: `Skill "${skillName}" code scan failed`,
					detail: `Static code scan could not complete for ${skillDir}: ${String(err)}`,
					remediation: "Check file permissions and skill layout, then rerun `openclaw security audit --deep`."
				});
				return null;
			});
			if (!summary) continue;
			if (summary.critical > 0) {
				const details = formatCodeSafetyDetails(summary.findings.filter((finding) => finding.severity === "critical"), skillDir);
				findings.push({
					checkId: "skills.code_safety",
					severity: "critical",
					title: `Skill "${skillName}" contains dangerous code patterns`,
					detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
					remediation: `Review the skill source code before use. If untrusted, remove "${skillDir}".`
				});
			} else if (summary.warn > 0) {
				const details = formatCodeSafetyDetails(summary.findings.filter((finding) => finding.severity === "warn"), skillDir);
				findings.push({
					checkId: "skills.code_safety",
					severity: "warn",
					title: `Skill "${skillName}" contains suspicious code patterns`,
					detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
					remediation: "Review flagged lines to ensure the behavior is intentional and safe."
				});
			}
		}
	}
	return findings;
}
//#endregion
export { collectStateDeepFilesystemFindings as a, collectSandboxBrowserHashLabelFindings as i, collectInstalledSkillsCodeSafetyFindings as n, readConfigSnapshotForAudit as o, collectPluginsCodeSafetyFindings as r, shouldIgnoreInstalledPluginDirName as s, collectIncludeFilePermFindings as t };
