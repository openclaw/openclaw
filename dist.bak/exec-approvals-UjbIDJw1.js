import { vn as expandHomePrefix } from "./entry.js";
import { t as DEFAULT_AGENT_ID } from "./session-key-qmb11-mH.js";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";

//#region src/infra/jsonl-socket.ts
async function requestJsonlSocket(params) {
	const { socketPath, payload, timeoutMs, accept } = params;
	return await new Promise((resolve) => {
		const client = new net.Socket();
		let settled = false;
		let buffer = "";
		const finish = (value) => {
			if (settled) return;
			settled = true;
			try {
				client.destroy();
			} catch {}
			resolve(value);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		client.on("error", () => finish(null));
		client.connect(socketPath, () => {
			client.write(`${payload}\n`);
		});
		client.on("data", (data) => {
			buffer += data.toString("utf8");
			let idx = buffer.indexOf("\n");
			while (idx !== -1) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				idx = buffer.indexOf("\n");
				if (!line) continue;
				try {
					const result = accept(JSON.parse(line));
					if (result === void 0) continue;
					clearTimeout(timer);
					finish(result);
					return;
				} catch {}
			}
		});
	});
}

//#endregion
//#region src/infra/exec-approvals.ts
const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 12e4;
const DEFAULT_SECURITY = "deny";
const DEFAULT_ASK = "on-miss";
const DEFAULT_ASK_FALLBACK = "deny";
const DEFAULT_AUTO_ALLOW_SKILLS = false;
const DEFAULT_SOCKET = "~/.openclaw/exec-approvals.sock";
const DEFAULT_FILE = "~/.openclaw/exec-approvals.json";
function hashExecApprovalsRaw(raw) {
	return crypto.createHash("sha256").update(raw ?? "").digest("hex");
}
function resolveExecApprovalsPath() {
	return expandHomePrefix(DEFAULT_FILE);
}
function resolveExecApprovalsSocketPath() {
	return expandHomePrefix(DEFAULT_SOCKET);
}
function normalizeAllowlistPattern(value) {
	const trimmed = value?.trim() ?? "";
	return trimmed ? trimmed.toLowerCase() : null;
}
function mergeLegacyAgent(current, legacy) {
	const allowlist = [];
	const seen = /* @__PURE__ */ new Set();
	const pushEntry = (entry) => {
		const key = normalizeAllowlistPattern(entry.pattern);
		if (!key || seen.has(key)) return;
		seen.add(key);
		allowlist.push(entry);
	};
	for (const entry of current.allowlist ?? []) pushEntry(entry);
	for (const entry of legacy.allowlist ?? []) pushEntry(entry);
	return {
		security: current.security ?? legacy.security,
		ask: current.ask ?? legacy.ask,
		askFallback: current.askFallback ?? legacy.askFallback,
		autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
		allowlist: allowlist.length > 0 ? allowlist : void 0
	};
}
function ensureDir(filePath) {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
}
function coerceAllowlistEntries(allowlist) {
	if (!Array.isArray(allowlist) || allowlist.length === 0) return Array.isArray(allowlist) ? allowlist : void 0;
	let changed = false;
	const result = [];
	for (const item of allowlist) if (typeof item === "string") {
		const trimmed = item.trim();
		if (trimmed) {
			result.push({ pattern: trimmed });
			changed = true;
		} else changed = true;
	} else if (item && typeof item === "object" && !Array.isArray(item)) {
		const pattern = item.pattern;
		if (typeof pattern === "string" && pattern.trim().length > 0) result.push(item);
		else changed = true;
	} else changed = true;
	return changed ? result.length > 0 ? result : void 0 : allowlist;
}
function ensureAllowlistIds(allowlist) {
	if (!Array.isArray(allowlist) || allowlist.length === 0) return allowlist;
	let changed = false;
	const next = allowlist.map((entry) => {
		if (entry.id) return entry;
		changed = true;
		return {
			...entry,
			id: crypto.randomUUID()
		};
	});
	return changed ? next : allowlist;
}
function normalizeExecApprovals(file) {
	const socketPath = file.socket?.path?.trim();
	const token = file.socket?.token?.trim();
	const agents = { ...file.agents };
	const legacyDefault = agents.default;
	if (legacyDefault) {
		const main = agents[DEFAULT_AGENT_ID];
		agents[DEFAULT_AGENT_ID] = main ? mergeLegacyAgent(main, legacyDefault) : legacyDefault;
		delete agents.default;
	}
	for (const [key, agent] of Object.entries(agents)) {
		const allowlist = ensureAllowlistIds(coerceAllowlistEntries(agent.allowlist));
		if (allowlist !== agent.allowlist) agents[key] = {
			...agent,
			allowlist
		};
	}
	return {
		version: 1,
		socket: {
			path: socketPath && socketPath.length > 0 ? socketPath : void 0,
			token: token && token.length > 0 ? token : void 0
		},
		defaults: {
			security: file.defaults?.security,
			ask: file.defaults?.ask,
			askFallback: file.defaults?.askFallback,
			autoAllowSkills: file.defaults?.autoAllowSkills
		},
		agents
	};
}
function mergeExecApprovalsSocketDefaults(params) {
	const currentSocketPath = params.current?.socket?.path?.trim();
	const currentToken = params.current?.socket?.token?.trim();
	const socketPath = params.normalized.socket?.path?.trim() ?? currentSocketPath ?? resolveExecApprovalsSocketPath();
	const token = params.normalized.socket?.token?.trim() ?? currentToken ?? "";
	return {
		...params.normalized,
		socket: {
			path: socketPath,
			token
		}
	};
}
function generateToken() {
	return crypto.randomBytes(24).toString("base64url");
}
function readExecApprovalsSnapshot() {
	const filePath = resolveExecApprovalsPath();
	if (!fs.existsSync(filePath)) return {
		path: filePath,
		exists: false,
		raw: null,
		file: normalizeExecApprovals({
			version: 1,
			agents: {}
		}),
		hash: hashExecApprovalsRaw(null)
	};
	const raw = fs.readFileSync(filePath, "utf8");
	let parsed = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	return {
		path: filePath,
		exists: true,
		raw,
		file: parsed?.version === 1 ? normalizeExecApprovals(parsed) : normalizeExecApprovals({
			version: 1,
			agents: {}
		}),
		hash: hashExecApprovalsRaw(raw)
	};
}
function loadExecApprovals() {
	const filePath = resolveExecApprovalsPath();
	try {
		if (!fs.existsSync(filePath)) return normalizeExecApprovals({
			version: 1,
			agents: {}
		});
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed?.version !== 1) return normalizeExecApprovals({
			version: 1,
			agents: {}
		});
		return normalizeExecApprovals(parsed);
	} catch {
		return normalizeExecApprovals({
			version: 1,
			agents: {}
		});
	}
}
function saveExecApprovals(file) {
	const filePath = resolveExecApprovalsPath();
	ensureDir(filePath);
	fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 384 });
	try {
		fs.chmodSync(filePath, 384);
	} catch {}
}
function ensureExecApprovals() {
	const next = normalizeExecApprovals(loadExecApprovals());
	const socketPath = next.socket?.path?.trim();
	const token = next.socket?.token?.trim();
	const updated = {
		...next,
		socket: {
			path: socketPath && socketPath.length > 0 ? socketPath : resolveExecApprovalsSocketPath(),
			token: token && token.length > 0 ? token : generateToken()
		}
	};
	saveExecApprovals(updated);
	return updated;
}
function normalizeSecurity(value, fallback) {
	if (value === "allowlist" || value === "full" || value === "deny") return value;
	return fallback;
}
function normalizeAsk(value, fallback) {
	if (value === "always" || value === "off" || value === "on-miss") return value;
	return fallback;
}
function resolveExecApprovals(agentId, overrides) {
	const file = ensureExecApprovals();
	return resolveExecApprovalsFromFile({
		file,
		agentId,
		overrides,
		path: resolveExecApprovalsPath(),
		socketPath: expandHomePrefix(file.socket?.path ?? resolveExecApprovalsSocketPath()),
		token: file.socket?.token ?? ""
	});
}
function resolveExecApprovalsFromFile(params) {
	const file = normalizeExecApprovals(params.file);
	const defaults = file.defaults ?? {};
	const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
	const agent = file.agents?.[agentKey] ?? {};
	const wildcard = file.agents?.["*"] ?? {};
	const fallbackSecurity = params.overrides?.security ?? DEFAULT_SECURITY;
	const fallbackAsk = params.overrides?.ask ?? DEFAULT_ASK;
	const fallbackAskFallback = params.overrides?.askFallback ?? DEFAULT_ASK_FALLBACK;
	const fallbackAutoAllowSkills = params.overrides?.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS;
	const resolvedDefaults = {
		security: normalizeSecurity(defaults.security, fallbackSecurity),
		ask: normalizeAsk(defaults.ask, fallbackAsk),
		askFallback: normalizeSecurity(defaults.askFallback ?? fallbackAskFallback, fallbackAskFallback),
		autoAllowSkills: Boolean(defaults.autoAllowSkills ?? fallbackAutoAllowSkills)
	};
	const resolvedAgent = {
		security: normalizeSecurity(agent.security ?? wildcard.security ?? resolvedDefaults.security, resolvedDefaults.security),
		ask: normalizeAsk(agent.ask ?? wildcard.ask ?? resolvedDefaults.ask, resolvedDefaults.ask),
		askFallback: normalizeSecurity(agent.askFallback ?? wildcard.askFallback ?? resolvedDefaults.askFallback, resolvedDefaults.askFallback),
		autoAllowSkills: Boolean(agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills)
	};
	const allowlist = [...Array.isArray(wildcard.allowlist) ? wildcard.allowlist : [], ...Array.isArray(agent.allowlist) ? agent.allowlist : []];
	return {
		path: params.path ?? resolveExecApprovalsPath(),
		socketPath: expandHomePrefix(params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath()),
		token: params.token ?? file.socket?.token ?? "",
		defaults: resolvedDefaults,
		agent: resolvedAgent,
		allowlist,
		file
	};
}
function requiresExecApproval(params) {
	return params.ask === "always" || params.ask === "on-miss" && params.security === "allowlist" && (!params.analysisOk || !params.allowlistSatisfied);
}
function recordAllowlistUse(approvals, agentId, entry, command, resolvedPath) {
	const target = agentId ?? DEFAULT_AGENT_ID;
	const agents = approvals.agents ?? {};
	const existing = agents[target] ?? {};
	const nextAllowlist = (Array.isArray(existing.allowlist) ? existing.allowlist : []).map((item) => item.pattern === entry.pattern ? {
		...item,
		id: item.id ?? crypto.randomUUID(),
		lastUsedAt: Date.now(),
		lastUsedCommand: command,
		lastResolvedPath: resolvedPath
	} : item);
	agents[target] = {
		...existing,
		allowlist: nextAllowlist
	};
	approvals.agents = agents;
	saveExecApprovals(approvals);
}
function addAllowlistEntry(approvals, agentId, pattern) {
	const target = agentId ?? DEFAULT_AGENT_ID;
	const agents = approvals.agents ?? {};
	const existing = agents[target] ?? {};
	const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
	const trimmed = pattern.trim();
	if (!trimmed) return;
	if (allowlist.some((entry) => entry.pattern === trimmed)) return;
	allowlist.push({
		id: crypto.randomUUID(),
		pattern: trimmed,
		lastUsedAt: Date.now()
	});
	agents[target] = {
		...existing,
		allowlist
	};
	approvals.agents = agents;
	saveExecApprovals(approvals);
}
function minSecurity(a, b) {
	const order = {
		deny: 0,
		allowlist: 1,
		full: 2
	};
	return order[a] <= order[b] ? a : b;
}
function maxAsk(a, b) {
	const order = {
		off: 0,
		"on-miss": 1,
		always: 2
	};
	return order[a] >= order[b] ? a : b;
}

//#endregion
export { mergeExecApprovalsSocketDefaults as a, readExecApprovalsSnapshot as c, resolveExecApprovals as d, resolveExecApprovalsFromFile as f, maxAsk as i, recordAllowlistUse as l, requestJsonlSocket as m, addAllowlistEntry as n, minSecurity as o, saveExecApprovals as p, ensureExecApprovals as r, normalizeExecApprovals as s, DEFAULT_EXEC_APPROVAL_TIMEOUT_MS as t, requiresExecApproval as u };