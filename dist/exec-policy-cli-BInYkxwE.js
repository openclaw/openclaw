import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { n as isRich, r as theme } from "./theme-D58JpUfy.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { M as restoreExecApprovalsSnapshot, N as saveExecApprovals, _ as normalizeExecSecurity, b as readExecApprovalsSnapshot, h as normalizeExecAsk, v as normalizeExecTarget } from "./exec-approvals-Bef7TPVc.js";
import { n as sanitizeExecApprovalDisplayText } from "./exec-approval-command-display-DFkfeGi4.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-ockhvL7y.js";
import { t as collectExecPolicyScopeSnapshots } from "./exec-approvals-effective-DvSlJ8_B.js";
import crypto from "node:crypto";
//#region src/cli/exec-policy-cli.ts
const EXEC_POLICY_PRESETS = {
	yolo: {
		host: "gateway",
		security: "full",
		ask: "off",
		askFallback: "full"
	},
	cautious: {
		host: "gateway",
		security: "allowlist",
		ask: "on-miss",
		askFallback: "deny"
	},
	"deny-all": {
		host: "gateway",
		security: "deny",
		ask: "off",
		askFallback: "deny"
	}
};
var ExecPolicyCliError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ExecPolicyCliError";
	}
};
function failExecPolicy(message) {
	throw new ExecPolicyCliError(message);
}
function formatExecPolicyError(err) {
	return sanitizeExecPolicyMessage(err instanceof Error ? err.message : String(err));
}
async function runExecPolicyAction(action) {
	try {
		await action();
	} catch (err) {
		defaultRuntime.error(formatExecPolicyError(err));
		defaultRuntime.exit(1);
	}
}
function sanitizeExecPolicyTableCell(value) {
	return sanitizeExecApprovalDisplayText(sanitizeTerminalText(value));
}
function sanitizeExecPolicyMessage(value) {
	return sanitizeTerminalText(String(value));
}
function hashExecApprovalsFile(file) {
	const raw = `${JSON.stringify(file, null, 2)}\n`;
	return crypto.createHash("sha256").update(raw).digest("hex");
}
function resolveExecPolicyInput(params) {
	const resolved = {};
	if (params.host !== void 0) {
		const host = normalizeExecTarget(params.host);
		if (!host) failExecPolicy(`Invalid exec host: ${sanitizeExecPolicyMessage(params.host)}`);
		resolved.host = host;
	}
	if (params.security !== void 0) {
		const security = normalizeExecSecurity(params.security);
		if (!security) failExecPolicy(`Invalid exec security: ${sanitizeExecPolicyMessage(params.security)}`);
		resolved.security = security;
	}
	if (params.ask !== void 0) {
		const ask = normalizeExecAsk(params.ask);
		if (!ask) failExecPolicy(`Invalid exec ask mode: ${sanitizeExecPolicyMessage(params.ask)}`);
		resolved.ask = ask;
	}
	if (params.askFallback !== void 0) {
		const askFallback = normalizeExecSecurity(params.askFallback);
		if (!askFallback) failExecPolicy(`Invalid exec askFallback: ${sanitizeExecPolicyMessage(params.askFallback)}`);
		resolved.askFallback = askFallback;
	}
	return resolved;
}
function applyConfigExecPolicy(draft, policy) {
	const root = draft;
	root.tools ??= {};
	root.tools.exec ??= {};
	if (policy.host !== void 0) root.tools.exec.host = policy.host;
	if (policy.security !== void 0) root.tools.exec.security = policy.security;
	if (policy.ask !== void 0) root.tools.exec.ask = policy.ask;
}
function applyApprovalsDefaults(file, policy) {
	const next = structuredClone(file ?? { version: 1 });
	next.version = 1;
	next.defaults ??= {};
	if (policy.security !== void 0) next.defaults.security = policy.security;
	if (policy.ask !== void 0) next.defaults.ask = policy.ask;
	if (policy.askFallback !== void 0) next.defaults.askFallback = policy.askFallback;
	return next;
}
function buildNextExecPolicyConfig(config, policy) {
	const draft = structuredClone(config);
	applyConfigExecPolicy(draft, policy);
	return draft;
}
async function buildLocalExecPolicyShowPayload() {
	const configSnapshot = await readConfigFileSnapshot();
	const approvalsSnapshot = readExecApprovalsSnapshot();
	const scopes = collectExecPolicyScopeSnapshots({
		cfg: configSnapshot.config ?? {},
		approvals: approvalsSnapshot.file,
		hostPath: approvalsSnapshot.path
	}).map(buildExecPolicyShowScope);
	const hasNodeRuntimeScope = scopes.some((scope) => scope.runtimeApprovalsSource === "node-runtime");
	return {
		configPath: configSnapshot.path,
		approvalsPath: approvalsSnapshot.path,
		approvalsExists: approvalsSnapshot.exists,
		effectivePolicy: {
			note: hasNodeRuntimeScope ? "Scopes requesting host=node are node-managed at runtime. Local approvals are shown only for local/gateway scopes." : "Effective exec policy is the host approvals file intersected with requested tools.exec policy.",
			scopes
		}
	};
}
function buildExecPolicyShowScope(snapshot) {
	const { allowedDecisions: _allowedDecisions, ...baseScope } = snapshot;
	if (snapshot.host.requested !== "node") return {
		...baseScope,
		runtimeApprovalsSource: "local-file"
	};
	return {
		...baseScope,
		runtimeApprovalsSource: "node-runtime",
		security: {
			requested: snapshot.security.requested,
			requestedSource: snapshot.security.requestedSource,
			host: "unknown",
			hostSource: "node runtime approvals",
			effective: "unknown",
			note: "runtime policy resolved by node approvals"
		},
		ask: {
			requested: snapshot.ask.requested,
			requestedSource: snapshot.ask.requestedSource,
			host: "unknown",
			hostSource: "node runtime approvals",
			effective: "unknown",
			note: "runtime policy resolved by node approvals"
		},
		askFallback: {
			effective: "unknown",
			source: "node runtime approvals"
		}
	};
}
function renderExecPolicyShow(payload) {
	const rich = isRich();
	const heading = (text) => rich ? theme.heading(text) : text;
	const muted = (text) => rich ? theme.muted(text) : text;
	defaultRuntime.log(heading("Exec Policy"));
	defaultRuntime.log(renderTable({
		width: getTerminalTableWidth(),
		columns: [{
			key: "Field",
			header: "Field",
			minWidth: 14
		}, {
			key: "Value",
			header: "Value",
			minWidth: 24,
			flex: true
		}],
		rows: [
			{
				Field: "Config",
				Value: sanitizeExecPolicyTableCell(payload.configPath)
			},
			{
				Field: "Approvals",
				Value: sanitizeExecPolicyTableCell(payload.approvalsPath)
			},
			{
				Field: "Approvals File",
				Value: sanitizeExecPolicyTableCell(payload.approvalsExists ? "present" : "missing")
			}
		]
	}).trimEnd());
	defaultRuntime.log("");
	defaultRuntime.log(heading("Effective Policy"));
	defaultRuntime.log(renderTable({
		width: getTerminalTableWidth(),
		columns: [
			{
				key: "Scope",
				header: "Scope",
				minWidth: 12
			},
			{
				key: "Requested",
				header: "Requested",
				minWidth: 24,
				flex: true
			},
			{
				key: "Host",
				header: "Host",
				minWidth: 24,
				flex: true
			},
			{
				key: "Effective",
				header: "Effective",
				minWidth: 16
			}
		],
		rows: payload.effectivePolicy.scopes.map((scope) => ({
			Scope: sanitizeExecPolicyTableCell(scope.scopeLabel),
			Requested: sanitizeExecPolicyTableCell(`host=${scope.host.requested} (${scope.host.requestedSource})\nsecurity=${scope.security.requested} (${scope.security.requestedSource})\nask=${scope.ask.requested} (${scope.ask.requestedSource})`),
			Host: sanitizeExecPolicyTableCell(`security=${scope.security.host} (${scope.security.hostSource})\nask=${scope.ask.host} (${scope.ask.hostSource})\naskFallback=${scope.askFallback.effective} (${scope.askFallback.source})`),
			Effective: sanitizeExecPolicyTableCell(`security=${scope.security.effective}\nask=${scope.ask.effective}`)
		}))
	}).trimEnd());
	defaultRuntime.log("");
	defaultRuntime.log(muted(payload.effectivePolicy.note));
}
async function applyLocalExecPolicy(policy) {
	const configSnapshot = await readConfigFileSnapshot();
	const nextConfig = buildNextExecPolicyConfig(configSnapshot.config ?? {}, policy);
	if (nextConfig.tools?.exec?.host === "node") failExecPolicy("Local exec-policy cannot synchronize host=node. Node approvals are fetched from the node at runtime.");
	const approvalsSnapshot = readExecApprovalsSnapshot();
	const nextApprovals = applyApprovalsDefaults(approvalsSnapshot.file, policy);
	const writtenApprovalsHash = hashExecApprovalsFile(nextApprovals);
	saveExecApprovals(nextApprovals);
	try {
		await replaceConfigFile({
			baseHash: configSnapshot.hash,
			nextConfig
		});
	} catch (err) {
		if (readExecApprovalsSnapshot().hash !== writtenApprovalsHash) throw err;
		restoreExecApprovalsSnapshot(approvalsSnapshot);
		throw err;
	}
	return await buildLocalExecPolicyShowPayload();
}
function registerExecPolicyCli(program) {
	const execPolicy = program.command("exec-policy").description("Show or synchronize requested exec policy with host approvals").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.openclaw.ai/cli/approvals")}\n`);
	execPolicy.command("show").description("Show the local config policy, host approvals, and effective merge").option("--json", "Output as JSON", false).action(async (opts) => {
		await runExecPolicyAction(async () => {
			const payload = await buildLocalExecPolicyShowPayload();
			if (opts.json) {
				defaultRuntime.writeJson(payload, 0);
				return;
			}
			renderExecPolicyShow(payload);
		});
	});
	execPolicy.command("preset <name>").description("Apply a synchronized preset: \"yolo\", \"cautious\", or \"deny-all\"").option("--json", "Output as JSON", false).action(async (name, opts) => {
		await runExecPolicyAction(async () => {
			if (!Object.hasOwn(EXEC_POLICY_PRESETS, name)) failExecPolicy(`Unknown exec-policy preset: ${sanitizeExecPolicyMessage(name)}`);
			const preset = EXEC_POLICY_PRESETS[name];
			const payload = await applyLocalExecPolicy(preset);
			if (opts.json) {
				defaultRuntime.writeJson({
					preset: name,
					...payload
				}, 0);
				return;
			}
			defaultRuntime.log(`Applied exec-policy preset: ${sanitizeExecPolicyMessage(name)}`);
			defaultRuntime.log("");
			renderExecPolicyShow(payload);
		});
	});
	execPolicy.command("set").description("Synchronize local config and host approvals using explicit values").option("--host <host>", "Exec host target: auto|sandbox|gateway|node").option("--security <mode>", "Exec security: deny|allowlist|full").option("--ask <mode>", "Exec ask mode: off|on-miss|always").option("--ask-fallback <mode>", "Host approvals fallback: deny|allowlist|full").option("--json", "Output as JSON", false).action(async (opts) => {
		await runExecPolicyAction(async () => {
			const policy = resolveExecPolicyInput(opts);
			if (Object.keys(policy).length === 0) failExecPolicy("Provide at least one of --host, --security, --ask, or --ask-fallback.");
			const payload = await applyLocalExecPolicy(policy);
			if (opts.json) {
				defaultRuntime.writeJson({
					applied: policy,
					...payload
				}, 0);
				return;
			}
			defaultRuntime.log("Synchronized local exec policy.");
			defaultRuntime.log("");
			renderExecPolicyShow(payload);
		});
	});
}
//#endregion
export { registerExecPolicyCli };
