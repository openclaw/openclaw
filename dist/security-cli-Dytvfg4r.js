import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { _ as resolveOAuthDir, s as resolveConfigPath, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { n as isRich, r as theme } from "./theme-D58JpUfy.js";
import { n as formatIcaclsResetCommand, t as createIcaclsResetCommand } from "./permissions-ya3cPkFH.js";
import { g as shortenHomePath, h as shortenHomeInString } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import "./audit-fs-CBe_wA_B.js";
import { i as runExec } from "./exec-D4bhAbbv.js";
import { i as getRuntimeConfig, r as createConfigIO } from "./io-DoswVvYe.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { t as resolveCommandSecretRefsViaGateway } from "./command-secret-gateway-BpOVXOFV.js";
import { f as getSecurityAuditCommandSecretTargetIds } from "./command-secret-targets-UUlaHEu2.js";
import { t as formatHelpExamples } from "./help-format-DXVAk021.js";
import { t as runSecurityAudit } from "./audit-B6PWbC3Y.js";
import { t as collectIncludePathsRecursive } from "./includes-scan-BhUwImvk.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/security/fix.ts
async function safeChmod(params) {
	try {
		const st = await fs.lstat(params.path);
		if (st.isSymbolicLink()) return {
			kind: "chmod",
			path: params.path,
			mode: params.mode,
			ok: false,
			skipped: "symlink"
		};
		if (params.require === "dir" && !st.isDirectory()) return {
			kind: "chmod",
			path: params.path,
			mode: params.mode,
			ok: false,
			skipped: "not-a-directory"
		};
		if (params.require === "file" && !st.isFile()) return {
			kind: "chmod",
			path: params.path,
			mode: params.mode,
			ok: false,
			skipped: "not-a-file"
		};
		if ((st.mode & 511) === params.mode) return {
			kind: "chmod",
			path: params.path,
			mode: params.mode,
			ok: false,
			skipped: "already"
		};
		await fs.chmod(params.path, params.mode);
		return {
			kind: "chmod",
			path: params.path,
			mode: params.mode,
			ok: true
		};
	} catch (err) {
		if (err.code === "ENOENT") return {
			kind: "chmod",
			path: params.path,
			mode: params.mode,
			ok: false,
			skipped: "missing"
		};
		return {
			kind: "chmod",
			path: params.path,
			mode: params.mode,
			ok: false,
			error: String(err)
		};
	}
}
async function safeAclReset(params) {
	const display = formatIcaclsResetCommand(params.path, {
		isDir: params.require === "dir",
		env: params.env
	});
	try {
		const st = await fs.lstat(params.path);
		if (st.isSymbolicLink()) return {
			kind: "icacls",
			path: params.path,
			command: display,
			ok: false,
			skipped: "symlink"
		};
		if (params.require === "dir" && !st.isDirectory()) return {
			kind: "icacls",
			path: params.path,
			command: display,
			ok: false,
			skipped: "not-a-directory"
		};
		if (params.require === "file" && !st.isFile()) return {
			kind: "icacls",
			path: params.path,
			command: display,
			ok: false,
			skipped: "not-a-file"
		};
		const cmd = createIcaclsResetCommand(params.path, {
			isDir: st.isDirectory(),
			env: params.env
		});
		if (!cmd) return {
			kind: "icacls",
			path: params.path,
			command: display,
			ok: false,
			skipped: "missing-user"
		};
		await (params.exec ?? runExec)(cmd.command, cmd.args);
		return {
			kind: "icacls",
			path: params.path,
			command: cmd.display,
			ok: true
		};
	} catch (err) {
		if (err.code === "ENOENT") return {
			kind: "icacls",
			path: params.path,
			command: display,
			ok: false,
			skipped: "missing"
		};
		return {
			kind: "icacls",
			path: params.path,
			command: display,
			ok: false,
			error: String(err)
		};
	}
}
function setGroupPolicyAllowlist(params) {
	if (!params.cfg.channels) return;
	const section = params.cfg.channels[params.channel];
	if (!section || typeof section !== "object") return;
	if (section.groupPolicy === "open") {
		section.groupPolicy = "allowlist";
		params.changes.push(`channels.${params.channel}.groupPolicy=open -> allowlist`);
	}
	const accounts = section.accounts;
	if (!accounts || typeof accounts !== "object") return;
	for (const [accountId, accountValue] of Object.entries(accounts)) {
		if (!accountId) continue;
		if (!accountValue || typeof accountValue !== "object") continue;
		const account = accountValue;
		if (account.groupPolicy === "open") {
			account.groupPolicy = "allowlist";
			params.changes.push(`channels.${params.channel}.accounts.${accountId}.groupPolicy=open -> allowlist`);
		}
	}
}
function applyConfigFixes(params) {
	const next = structuredClone(params.cfg ?? {});
	const changes = [];
	if (next.logging?.redactSensitive === "off") {
		next.logging = {
			...next.logging,
			redactSensitive: "tools"
		};
		changes.push("logging.redactSensitive=off -> \"tools\"");
	}
	for (const channel of Object.keys(next.channels ?? {})) setGroupPolicyAllowlist({
		cfg: next,
		channel,
		changes
	});
	return {
		cfg: next,
		changes
	};
}
async function applySecurityFixConfigMutations(params) {
	const fixed = applyConfigFixes({
		cfg: params.cfg,
		env: params.env
	});
	const channelFixes = await collectChannelSecurityConfigFixMutation({
		cfg: fixed.cfg,
		env: params.env,
		channelPlugins: params.channelPlugins
	});
	return {
		cfg: channelFixes.cfg,
		changes: [...fixed.changes, ...channelFixes.changes]
	};
}
async function collectChannelSecurityConfigFixMutation(params) {
	let nextCfg = params.cfg;
	const changes = [];
	const collectPlugins = async () => {
		if (params.channelPlugins) return params.channelPlugins;
		try {
			const pluginIds = Object.keys(params.cfg.channels ?? {}).filter(Boolean);
			if (pluginIds.length === 0) return [];
			const wanted = new Set(pluginIds);
			const { listBundledChannelPlugins } = await import("./bundled-BNUNDqMU.js");
			return listBundledChannelPlugins().filter((plugin) => wanted.has(plugin.id));
		} catch {
			return [];
		}
	};
	for (const plugin of await collectPlugins()) {
		const mutation = await plugin.security?.applyConfigFixes?.({
			cfg: nextCfg,
			env: params.env
		});
		if (!mutation || mutation.changes.length === 0) continue;
		nextCfg = mutation.config;
		changes.push(...mutation.changes);
	}
	return {
		cfg: nextCfg,
		changes
	};
}
async function collectSecurityPermissionTargets(params) {
	const targets = [
		{
			path: params.stateDir,
			mode: 448,
			require: "dir"
		},
		{
			path: params.configPath,
			mode: 384,
			require: "file"
		},
		...(params.includePaths ?? []).map((targetPath) => ({
			path: targetPath,
			mode: 384,
			require: "file"
		}))
	];
	const credsDir = resolveOAuthDir(params.env, params.stateDir);
	targets.push({
		path: credsDir,
		mode: 448,
		require: "dir"
	});
	const credsEntries = await fs.readdir(credsDir, { withFileTypes: true }).catch(() => []);
	for (const entry of credsEntries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".json")) continue;
		const p = path.join(credsDir, entry.name);
		targets.push({
			path: p,
			mode: 384,
			require: "file"
		});
	}
	const ids = /* @__PURE__ */ new Set();
	ids.add(resolveDefaultAgentId(params.cfg));
	const list = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
	for (const agent of list ?? []) {
		if (!agent || typeof agent !== "object") continue;
		const id = typeof agent.id === "string" ? agent.id.trim() : "";
		if (id) ids.add(id);
	}
	for (const agentId of ids) {
		const normalizedAgentId = normalizeAgentId(agentId);
		const agentRoot = path.join(params.stateDir, "agents", normalizedAgentId);
		const agentDir = path.join(agentRoot, "agent");
		const sessionsDir = path.join(agentRoot, "sessions");
		targets.push({
			path: agentRoot,
			mode: 448,
			require: "dir"
		});
		targets.push({
			path: agentDir,
			mode: 448,
			require: "dir"
		});
		const authPath = path.join(agentDir, "auth-profiles.json");
		targets.push({
			path: authPath,
			mode: 384,
			require: "file"
		});
		targets.push({
			path: sessionsDir,
			mode: 448,
			require: "dir"
		});
		const storePath = path.join(sessionsDir, "sessions.json");
		targets.push({
			path: storePath,
			mode: 384,
			require: "file"
		});
		const sessionEntries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
		for (const entry of sessionEntries) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".jsonl")) continue;
			const p = path.join(sessionsDir, entry.name);
			targets.push({
				path: p,
				mode: 384,
				require: "file"
			});
		}
	}
	return targets;
}
async function fixSecurityFootguns(opts) {
	const env = opts?.env ?? process.env;
	const platform = opts?.platform ?? process.platform;
	const exec = opts?.exec ?? runExec;
	const isWindows = platform === "win32";
	const stateDir = opts?.stateDir ?? resolveStateDir(env);
	const configPath = opts?.configPath ?? resolveConfigPath(env, stateDir);
	const actions = [];
	const errors = [];
	const io = createConfigIO({
		env,
		configPath
	});
	const { snapshot: snap, writeOptions } = await io.readConfigFileSnapshotForWrite();
	if (!snap.valid) errors.push(...snap.issues.map((i) => `${i.path}: ${i.message}`));
	let configWritten = false;
	let changes = [];
	if (snap.valid) {
		const fixed = await applySecurityFixConfigMutations({
			cfg: snap.config,
			env,
			channelPlugins: opts?.channelPlugins
		});
		changes = fixed.changes;
		if (changes.length > 0) try {
			await replaceConfigFile({
				nextConfig: fixed.cfg,
				snapshot: snap,
				writeOptions,
				io,
				afterWrite: { mode: "auto" }
			});
			configWritten = true;
		} catch (err) {
			errors.push(`replaceConfigFile failed: ${String(err)}`);
		}
	}
	const applyPerms = (params) => isWindows ? safeAclReset({
		path: params.path,
		require: params.require,
		env,
		exec
	}) : safeChmod({
		path: params.path,
		mode: params.mode,
		require: params.require
	});
	let includePaths = [];
	if (snap.exists) includePaths = await collectIncludePathsRecursive({
		configPath: snap.path,
		parsed: snap.parsed
	}).catch(() => []);
	const permissionTargets = await collectSecurityPermissionTargets({
		env,
		stateDir,
		configPath,
		cfg: snap.config ?? {},
		includePaths
	}).catch((err) => {
		errors.push(`collectSecurityPermissionTargets failed: ${String(err)}`);
		return [];
	});
	for (const target of permissionTargets) actions.push(await applyPerms(target));
	return {
		ok: errors.length === 0,
		stateDir,
		configPath,
		configWritten,
		changes,
		actions,
		errors
	};
}
//#endregion
//#region src/cli/security-cli.ts
function formatSummary(summary) {
	const rich = isRich();
	const c = summary.critical;
	const w = summary.warn;
	const i = summary.info;
	const parts = [];
	parts.push(rich ? theme.error(`${c} critical`) : `${c} critical`);
	parts.push(rich ? theme.warn(`${w} warn`) : `${w} warn`);
	parts.push(rich ? theme.muted(`${i} info`) : `${i} info`);
	return parts.join(" · ");
}
function registerSecurityCli(program) {
	program.command("security").description("Audit local config and state for common security foot-guns").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw security audit", "Run a local security audit."],
		["openclaw security audit --deep", "Include best-effort live Gateway probes and plugin-owned security audit collectors."],
		["openclaw security audit --deep --token <token>", "Use explicit token for deep probe."],
		["openclaw security audit --deep --password <password>", "Use explicit password for deep probe."],
		["openclaw security audit --fix", "Apply safe remediations and file-permission fixes."],
		["openclaw security audit --json", "Output machine-readable JSON."]
	])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/security", "docs.openclaw.ai/cli/security")}\n`).command("audit").description("Audit config + local state for common security foot-guns").option("--deep", "Attempt live Gateway probes and plugin-owned collector checks", false).option("--token <token>", "Use explicit gateway token for deep probe auth").option("--password <password>", "Use explicit gateway password for deep probe auth").option("--fix", "Apply safe fixes (tighten defaults + chmod state/config)", false).option("--json", "Print JSON", false).action(async (opts) => {
		const token = normalizeOptionalString(opts.token);
		const password = normalizeOptionalString(opts.password);
		const fixResult = opts.fix ? await fixSecurityFootguns().catch((_err) => null) : null;
		const sourceConfig = getRuntimeConfig();
		const { resolvedConfig: cfg, diagnostics: secretDiagnostics } = await resolveCommandSecretRefsViaGateway({
			config: sourceConfig,
			commandName: "security audit",
			targetIds: getSecurityAuditCommandSecretTargetIds(),
			mode: "read_only_status"
		});
		const report = await runSecurityAudit({
			config: cfg,
			sourceConfig,
			deep: Boolean(opts.deep),
			includeFilesystem: true,
			includeChannelSecurity: true,
			deepProbeAuth: token || password ? {
				...token ? { token } : {},
				...password ? { password } : {}
			} : void 0
		});
		if (opts.json) {
			defaultRuntime.writeJson(fixResult ? {
				fix: fixResult,
				report,
				secretDiagnostics
			} : {
				...report,
				secretDiagnostics
			});
			return;
		}
		const rich = isRich();
		const heading = (text) => rich ? theme.heading(text) : text;
		const muted = (text) => rich ? theme.muted(text) : text;
		const lines = [];
		lines.push(heading("OpenClaw security audit"));
		lines.push(muted(`Summary: ${formatSummary(report.summary)}`));
		if ((report.suppressedFindings?.length ?? 0) > 0) lines.push(muted(`Suppressed: ${report.suppressedFindings?.length ?? 0} configured`));
		lines.push(muted(`Run deeper: ${formatCliCommand("openclaw security audit --deep")}`));
		for (const diagnostic of secretDiagnostics) lines.push(muted(`[secrets] ${diagnostic}`));
		if (opts.fix) {
			lines.push(muted(`Fix: ${formatCliCommand("openclaw security audit --fix")}`));
			if (!fixResult) lines.push(muted("Fixes: failed to apply (unexpected error)"));
			else if (fixResult.errors.length === 0 && fixResult.changes.length === 0 && fixResult.actions.every((a) => !a.ok)) lines.push(muted("Fixes: no changes applied"));
			else {
				lines.push("");
				lines.push(heading("FIX"));
				for (const change of fixResult.changes) lines.push(muted(`  ${shortenHomeInString(change)}`));
				for (const action of fixResult.actions) {
					if (action.kind === "chmod") {
						const mode = action.mode.toString(8).padStart(3, "0");
						if (action.ok) lines.push(muted(`  chmod ${mode} ${shortenHomePath(action.path)}`));
						else if (action.skipped) lines.push(muted(`  skip chmod ${mode} ${shortenHomePath(action.path)} (${action.skipped})`));
						else if (action.error) lines.push(muted(`  chmod ${mode} ${shortenHomePath(action.path)} failed: ${action.error}`));
						continue;
					}
					const command = shortenHomeInString(action.command);
					if (action.ok) lines.push(muted(`  ${command}`));
					else if (action.skipped) lines.push(muted(`  skip ${command} (${action.skipped})`));
					else if (action.error) lines.push(muted(`  ${command} failed: ${action.error}`));
				}
				if (fixResult.errors.length > 0) for (const err of fixResult.errors) lines.push(muted(`  error: ${shortenHomeInString(err)}`));
			}
		}
		const bySeverity = (sev) => report.findings.filter((f) => f.severity === sev);
		const render = (sev) => {
			const list = bySeverity(sev);
			if (list.length === 0) return;
			const label = sev === "critical" ? rich ? theme.error("CRITICAL") : "CRITICAL" : sev === "warn" ? rich ? theme.warn("WARN") : "WARN" : rich ? theme.muted("INFO") : "INFO";
			lines.push("");
			lines.push(heading(label));
			for (const f of list) {
				lines.push(`${theme.muted(f.checkId)} ${f.title}`);
				lines.push(`  ${f.detail}`);
				if (f.remediation?.trim()) lines.push(`  ${muted(`Fix: ${f.remediation.trim()}`)}`);
			}
		};
		render("critical");
		render("warn");
		render("info");
		defaultRuntime.log(lines.join("\n"));
	});
}
//#endregion
export { registerSecurityCli };
