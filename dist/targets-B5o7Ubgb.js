import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, n as listAgentIds } from "./agent-scope-config-CMp71_27.js";
import { n as resolveAgentsDirFromSessionStorePath, u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { n as resolveAgentSessionDirsFromAgentsDir, r as resolveAgentSessionDirsFromAgentsDirSync } from "./session-dirs-Dmxb0Dxh.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region src/config/sessions/targets.ts
const NON_FATAL_DISCOVERY_ERROR_CODES = new Set([
	"EACCES",
	"ELOOP",
	"ENOENT",
	"ENOTDIR",
	"EPERM",
	"ESTALE"
]);
function dedupeTargetsByStorePath(targets) {
	const deduped = /* @__PURE__ */ new Map();
	for (const target of targets) if (!deduped.has(target.storePath)) deduped.set(target.storePath, target);
	return [...deduped.values()];
}
function shouldSkipDiscoveryError(err) {
	const code = err?.code;
	return typeof code === "string" && NON_FATAL_DISCOVERY_ERROR_CODES.has(code);
}
function isWithinRoot(realPath, realRoot) {
	return realPath === realRoot || realPath.startsWith(`${realRoot}${path.sep}`);
}
function shouldSkipDiscoveredAgentDirName(dirName, agentId) {
	return agentId === "main" && normalizeLowercaseStringOrEmpty(dirName) !== "main";
}
function listConfiguredSessionStoreAgentIds(cfg) {
	const ids = new Set(listAgentIds(cfg).map((agentId) => normalizeAgentId(agentId)));
	const addAcpAgentId = (agentId) => {
		const raw = agentId?.trim() ?? "";
		if (!raw || raw === "*") return;
		const normalized = normalizeAgentId(raw);
		ids.add(normalized);
	};
	addAcpAgentId(cfg.acp?.defaultAgent);
	for (const agentId of cfg.acp?.allowedAgents ?? []) addAcpAgentId(agentId);
	for (const agent of cfg.agents?.list ?? []) if (agent.runtime?.type === "acp") addAcpAgentId(agent.runtime.acp?.agent ?? agent.id);
	return [...ids];
}
function resolveValidatedDiscoveredStorePathSync(params) {
	const storePath = path.join(params.sessionsDir, "sessions.json");
	try {
		const stat = fs.lstatSync(storePath);
		if (stat.isSymbolicLink() || !stat.isFile()) return;
		const realStorePath = fs.realpathSync.native(storePath);
		return isWithinRoot(realStorePath, params.realAgentsRoot ?? fs.realpathSync.native(params.agentsRoot)) ? realStorePath : void 0;
	} catch (err) {
		if (shouldSkipDiscoveryError(err)) return;
		throw err;
	}
}
async function resolveValidatedDiscoveredStorePath(params) {
	const storePath = path.join(params.sessionsDir, "sessions.json");
	try {
		const stat = await fs$1.lstat(storePath);
		if (stat.isSymbolicLink() || !stat.isFile()) return;
		const realStorePath = await fs$1.realpath(storePath);
		return isWithinRoot(realStorePath, params.realAgentsRoot ?? await fs$1.realpath(params.agentsRoot)) ? realStorePath : void 0;
	} catch (err) {
		if (shouldSkipDiscoveryError(err)) return;
		throw err;
	}
}
function resolveSessionStoreDiscoveryState(cfg, env) {
	const configuredTargets = resolveSessionStoreTargets(cfg, { allAgents: true }, { env });
	const agentsRoots = /* @__PURE__ */ new Set();
	for (const target of configuredTargets) {
		const agentsDir = resolveAgentsDirFromSessionStorePath(target.storePath);
		if (agentsDir) agentsRoots.add(agentsDir);
	}
	agentsRoots.add(path.join(resolveStateDir(env), "agents"));
	return {
		configuredTargets,
		agentsRoots: [...agentsRoots]
	};
}
function toDiscoveredSessionStoreTarget(sessionsDir, storePath) {
	const dirName = path.basename(path.dirname(sessionsDir));
	const agentId = normalizeAgentId(dirName);
	if (shouldSkipDiscoveredAgentDirName(dirName, agentId)) return;
	return {
		agentId,
		storePath
	};
}
function resolveAllAgentSessionStoreTargetsSync(cfg, params = {}) {
	const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, params.env ?? process.env);
	const realAgentsRoots = /* @__PURE__ */ new Map();
	const getRealAgentsRoot = (agentsRoot) => {
		const cached = realAgentsRoots.get(agentsRoot);
		if (cached !== void 0) return cached;
		try {
			const realAgentsRoot = fs.realpathSync.native(agentsRoot);
			realAgentsRoots.set(agentsRoot, realAgentsRoot);
			return realAgentsRoot;
		} catch (err) {
			if (shouldSkipDiscoveryError(err)) return;
			throw err;
		}
	};
	const validatedConfiguredTargets = configuredTargets.flatMap((target) => {
		const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
		if (!agentsRoot) return [target];
		const realAgentsRoot = getRealAgentsRoot(agentsRoot);
		if (!realAgentsRoot) return [];
		const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
			sessionsDir: path.dirname(target.storePath),
			agentsRoot,
			realAgentsRoot
		});
		return validatedStorePath ? [{
			...target,
			storePath: validatedStorePath
		}] : [];
	});
	const discoveredTargets = agentsRoots.flatMap((agentsDir) => {
		try {
			const realAgentsRoot = getRealAgentsRoot(agentsDir);
			if (!realAgentsRoot) return [];
			return resolveAgentSessionDirsFromAgentsDirSync(agentsDir).flatMap((sessionsDir) => {
				const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
					sessionsDir,
					agentsRoot: agentsDir,
					realAgentsRoot
				});
				const target = validatedStorePath ? toDiscoveredSessionStoreTarget(sessionsDir, validatedStorePath) : void 0;
				return target ? [target] : [];
			});
		} catch (err) {
			if (shouldSkipDiscoveryError(err)) return [];
			throw err;
		}
	});
	return dedupeTargetsByStorePath([...validatedConfiguredTargets, ...discoveredTargets]);
}
function resolveAgentSessionStoreTargetsSync(cfg, agentId, params = {}) {
	const env = params.env ?? process.env;
	const requested = normalizeAgentId(agentId);
	const storePaths = new Set([resolveStorePath(cfg.session?.store, {
		agentId: requested,
		env
	}), resolveStorePath(void 0, {
		agentId: requested,
		env
	})]);
	const targets = [];
	const realAgentsRoots = /* @__PURE__ */ new Map();
	const getRealAgentsRoot = (agentsRoot) => {
		if (realAgentsRoots.has(agentsRoot)) return realAgentsRoots.get(agentsRoot);
		try {
			const realAgentsRoot = fs.realpathSync.native(agentsRoot);
			realAgentsRoots.set(agentsRoot, realAgentsRoot);
			return realAgentsRoot;
		} catch (err) {
			if (shouldSkipDiscoveryError(err)) {
				realAgentsRoots.set(agentsRoot, void 0);
				return;
			}
			throw err;
		}
	};
	for (const storePath of storePaths) {
		const agentsRoot = resolveAgentsDirFromSessionStorePath(storePath);
		if (!agentsRoot) {
			targets.push({
				agentId: requested,
				storePath
			});
			continue;
		}
		const realAgentsRoot = getRealAgentsRoot(agentsRoot);
		if (!realAgentsRoot) continue;
		const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
			sessionsDir: path.dirname(storePath),
			agentsRoot,
			realAgentsRoot
		});
		if (validatedStorePath) targets.push({
			agentId: requested,
			storePath: validatedStorePath
		});
	}
	const { agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);
	for (const agentsDir of agentsRoots) try {
		const realAgentsRoot = getRealAgentsRoot(agentsDir);
		if (!realAgentsRoot) continue;
		for (const sessionsDir of resolveAgentSessionDirsFromAgentsDirSync(agentsDir)) {
			const target = toDiscoveredSessionStoreTarget(sessionsDir, path.join(sessionsDir, "sessions.json"));
			if (!target || normalizeAgentId(target.agentId) !== requested) continue;
			const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
				sessionsDir,
				agentsRoot: agentsDir,
				realAgentsRoot
			});
			if (validatedStorePath) targets.push({
				...target,
				storePath: validatedStorePath
			});
		}
	} catch (err) {
		if (shouldSkipDiscoveryError(err)) continue;
		throw err;
	}
	return dedupeTargetsByStorePath(targets);
}
async function resolveAllAgentSessionStoreTargets(cfg, params = {}) {
	const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, params.env ?? process.env);
	const realAgentsRoots = /* @__PURE__ */ new Map();
	const getRealAgentsRoot = async (agentsRoot) => {
		const cached = realAgentsRoots.get(agentsRoot);
		if (cached !== void 0) return cached;
		try {
			const realAgentsRoot = await fs$1.realpath(agentsRoot);
			realAgentsRoots.set(agentsRoot, realAgentsRoot);
			return realAgentsRoot;
		} catch (err) {
			if (shouldSkipDiscoveryError(err)) return;
			throw err;
		}
	};
	const validatedConfiguredTargets = (await Promise.all(configuredTargets.map(async (target) => {
		const agentsRoot = resolveAgentsDirFromSessionStorePath(target.storePath);
		if (!agentsRoot) return target;
		const realAgentsRoot = await getRealAgentsRoot(agentsRoot);
		if (!realAgentsRoot) return;
		const validatedStorePath = await resolveValidatedDiscoveredStorePath({
			sessionsDir: path.dirname(target.storePath),
			agentsRoot,
			realAgentsRoot
		});
		return validatedStorePath ? Object.assign({}, target, { storePath: validatedStorePath }) : void 0;
	}))).filter((target) => Boolean(target));
	const discoveredTargets = (await Promise.all(agentsRoots.map(async (agentsDir) => {
		try {
			const realAgentsRoot = await getRealAgentsRoot(agentsDir);
			if (!realAgentsRoot) return [];
			const sessionsDirs = await resolveAgentSessionDirsFromAgentsDir(agentsDir);
			return (await Promise.all(sessionsDirs.map(async (sessionsDir) => {
				const validatedStorePath = await resolveValidatedDiscoveredStorePath({
					sessionsDir,
					agentsRoot: agentsDir,
					realAgentsRoot
				});
				return validatedStorePath ? toDiscoveredSessionStoreTarget(sessionsDir, validatedStorePath) : void 0;
			}))).filter((target) => Boolean(target));
		} catch (err) {
			if (shouldSkipDiscoveryError(err)) return [];
			throw err;
		}
	}))).flat();
	return dedupeTargetsByStorePath([...validatedConfiguredTargets, ...discoveredTargets]);
}
function resolveSessionStoreTargets(cfg, opts, params = {}) {
	const env = params.env ?? process.env;
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const hasAgent = Boolean(opts.agent?.trim());
	const allAgents = opts.allAgents === true;
	if (hasAgent && allAgents) throw new Error("--agent and --all-agents cannot be used together");
	if (opts.store && (hasAgent || allAgents)) throw new Error("--store cannot be combined with --agent or --all-agents");
	if (opts.store) return [{
		agentId: defaultAgentId,
		storePath: resolveStorePath(opts.store, {
			agentId: defaultAgentId,
			env
		})
	}];
	if (allAgents) return dedupeTargetsByStorePath(listConfiguredSessionStoreAgentIds(cfg).map((agentId) => ({
		agentId,
		storePath: resolveStorePath(cfg.session?.store, {
			agentId,
			env
		})
	})));
	if (hasAgent) {
		const knownAgents = listAgentIds(cfg);
		const requested = normalizeAgentId(opts.agent ?? "");
		if (!knownAgents.includes(requested)) throw new Error(`Unknown agent id "${opts.agent}". Use "openclaw agents list" to see configured agents.`);
		return [{
			agentId: requested,
			storePath: resolveStorePath(cfg.session?.store, {
				agentId: requested,
				env
			})
		}];
	}
	return [{
		agentId: defaultAgentId,
		storePath: resolveStorePath(cfg.session?.store, {
			agentId: defaultAgentId,
			env
		})
	}];
}
//#endregion
export { resolveSessionStoreTargets as a, resolveAllAgentSessionStoreTargetsSync as i, resolveAgentSessionStoreTargetsSync as n, resolveAllAgentSessionStoreTargets as r, listConfiguredSessionStoreAgentIds as t };
