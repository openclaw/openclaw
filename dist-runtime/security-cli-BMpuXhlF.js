import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import { g as resolveOAuthDir, i as init_paths, s as resolveConfigPath, v as resolveStateDir } from "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme, r as isRich } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import { C as shortenHomePath, S as shortenHomeInString, d as init_utils } from "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { Ib as createConfigIO, Va as resolveCommandSecretRefsViaGateway, rn as formatHelpExamples, zb as loadConfig } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-DSKLJ_RM.js";
import { l as normalizeAgentId, s as init_session_key } from "./session-key-B-Mu-04L.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import { f as resolveDefaultAgentId } from "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import { n as runExec } from "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import { I as createIcaclsResetCommand, L as formatIcaclsResetCommand } from "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import { o as getSecurityAuditCommandSecretTargetIds } from "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import { _ as readChannelAllowFromStore } from "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import "./dangerous-tools-ACVy39Yu.js";
import { t as runSecurityAudit } from "./audit-HLZzOhOz.js";
import { t as collectIncludePathsRecursive } from "./includes-scan-CFbBo_CJ.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/security/fix.ts
init_runtime();
init_paths();
init_session_key();
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
		params.policyFlips.add(`channels.${params.channel}.`);
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
			params.policyFlips.add(`channels.${params.channel}.accounts.${accountId}.`);
		}
	}
}
function setWhatsAppGroupAllowFromFromStore(params) {
	const section = params.cfg.channels?.whatsapp;
	if (!section || typeof section !== "object") return;
	if (params.storeAllowFrom.length === 0) return;
	const maybeApply = (prefix, obj) => {
		if (!params.policyFlips.has(prefix)) return;
		const allowFrom = Array.isArray(obj.allowFrom) ? obj.allowFrom : [];
		const groupAllowFrom = Array.isArray(obj.groupAllowFrom) ? obj.groupAllowFrom : [];
		if (allowFrom.length > 0) return;
		if (groupAllowFrom.length > 0) return;
		obj.groupAllowFrom = params.storeAllowFrom;
		params.changes.push(`${prefix}groupAllowFrom=pairing-store`);
	};
	maybeApply("channels.whatsapp.", section);
	const accounts = section.accounts;
	if (!accounts || typeof accounts !== "object") return;
	for (const [accountId, accountValue] of Object.entries(accounts)) {
		if (!accountValue || typeof accountValue !== "object") continue;
		const account = accountValue;
		maybeApply(`channels.whatsapp.accounts.${accountId}.`, account);
	}
}
function applyConfigFixes(params) {
	const next = structuredClone(params.cfg ?? {});
	const changes = [];
	const policyFlips = /* @__PURE__ */ new Set();
	if (next.logging?.redactSensitive === "off") {
		next.logging = {
			...next.logging,
			redactSensitive: "tools"
		};
		changes.push("logging.redactSensitive=off -> \"tools\"");
	}
	for (const channel of [
		"telegram",
		"whatsapp",
		"discord",
		"signal",
		"imessage",
		"slack",
		"msteams"
	]) setGroupPolicyAllowlist({
		cfg: next,
		channel,
		changes,
		policyFlips
	});
	return {
		cfg: next,
		changes,
		policyFlips
	};
}
async function chmodCredentialsAndAgentState(params) {
	const credsDir = resolveOAuthDir(params.env, params.stateDir);
	params.actions.push(await safeChmod({
		path: credsDir,
		mode: 448,
		require: "dir"
	}));
	const credsEntries = await fs.readdir(credsDir, { withFileTypes: true }).catch(() => []);
	for (const entry of credsEntries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".json")) continue;
		const p = path.join(credsDir, entry.name);
		params.actions.push(await safeChmod({
			path: p,
			mode: 384,
			require: "file"
		}));
	}
	const ids = /* @__PURE__ */ new Set();
	ids.add(resolveDefaultAgentId(params.cfg));
	const list = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents?.list : [];
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
		params.actions.push(await safeChmod({
			path: agentRoot,
			mode: 448,
			require: "dir"
		}));
		params.actions.push(await params.applyPerms({
			path: agentDir,
			mode: 448,
			require: "dir"
		}));
		const authPath = path.join(agentDir, "auth-profiles.json");
		params.actions.push(await params.applyPerms({
			path: authPath,
			mode: 384,
			require: "file"
		}));
		params.actions.push(await params.applyPerms({
			path: sessionsDir,
			mode: 448,
			require: "dir"
		}));
		const storePath = path.join(sessionsDir, "sessions.json");
		params.actions.push(await params.applyPerms({
			path: storePath,
			mode: 384,
			require: "file"
		}));
		const sessionEntries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
		for (const entry of sessionEntries) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".jsonl")) continue;
			const p = path.join(sessionsDir, entry.name);
			params.actions.push(await params.applyPerms({
				path: p,
				mode: 384,
				require: "file"
			}));
		}
	}
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
	const snap = await io.readConfigFileSnapshot();
	if (!snap.valid) errors.push(...snap.issues.map((i) => `${i.path}: ${i.message}`));
	let configWritten = false;
	let changes = [];
	if (snap.valid) {
		const fixed = applyConfigFixes({
			cfg: snap.config,
			env
		});
		changes = fixed.changes;
		const whatsappStoreAllowFrom = await readChannelAllowFromStore("whatsapp", env, DEFAULT_ACCOUNT_ID).catch(() => []);
		if (whatsappStoreAllowFrom.length > 0) setWhatsAppGroupAllowFromFromStore({
			cfg: fixed.cfg,
			storeAllowFrom: whatsappStoreAllowFrom,
			changes,
			policyFlips: fixed.policyFlips
		});
		if (changes.length > 0) try {
			await io.writeConfigFile(fixed.cfg);
			configWritten = true;
		} catch (err) {
			errors.push(`writeConfigFile failed: ${String(err)}`);
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
	actions.push(await applyPerms({
		path: stateDir,
		mode: 448,
		require: "dir"
	}));
	actions.push(await applyPerms({
		path: configPath,
		mode: 384,
		require: "file"
	}));
	if (snap.exists) {
		const includePaths = await collectIncludePathsRecursive({
			configPath: snap.path,
			parsed: snap.parsed
		}).catch(() => []);
		for (const p of includePaths) actions.push(await applyPerms({
			path: p,
			mode: 384,
			require: "file"
		}));
	}
	await chmodCredentialsAndAgentState({
		env,
		stateDir,
		cfg: snap.config ?? {},
		actions,
		applyPerms
	}).catch((err) => {
		errors.push(`chmodCredentialsAndAgentState failed: ${String(err)}`);
	});
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
init_theme();
init_utils();
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
		["openclaw security audit --deep", "Include best-effort live Gateway probe checks."],
		["openclaw security audit --deep --token <token>", "Use explicit token for deep probe."],
		["openclaw security audit --deep --password <password>", "Use explicit password for deep probe."],
		["openclaw security audit --fix", "Apply safe remediations and file-permission fixes."],
		["openclaw security audit --json", "Output machine-readable JSON."]
	])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/security", "docs.openclaw.ai/cli/security")}\n`).command("audit").description("Audit config + local state for common security foot-guns").option("--deep", "Attempt live Gateway probe (best-effort)", false).option("--token <token>", "Use explicit gateway token for deep probe auth").option("--password <password>", "Use explicit gateway password for deep probe auth").option("--fix", "Apply safe fixes (tighten defaults + chmod state/config)", false).option("--json", "Print JSON", false).action(async (opts) => {
		const fixResult = opts.fix ? await fixSecurityFootguns().catch((_err) => null) : null;
		const sourceConfig = loadConfig();
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
			deepProbeAuth: opts.token?.trim() || opts.password?.trim() ? {
				...opts.token?.trim() ? { token: opts.token } : {},
				...opts.password?.trim() ? { password: opts.password } : {}
			} : void 0
		});
		if (opts.json) {
			defaultRuntime.log(JSON.stringify(fixResult ? {
				fix: fixResult,
				report,
				secretDiagnostics
			} : {
				...report,
				secretDiagnostics
			}, null, 2));
			return;
		}
		const rich = isRich();
		const heading = (text) => rich ? theme.heading(text) : text;
		const muted = (text) => rich ? theme.muted(text) : text;
		const lines = [];
		lines.push(heading("OpenClaw security audit"));
		lines.push(muted(`Summary: ${formatSummary(report.summary)}`));
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
