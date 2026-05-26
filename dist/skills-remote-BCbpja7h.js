import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { o as loadWorkspaceSkillEntries } from "./workspace-BoRIIBbL.js";
import { t as bumpSkillsSnapshotVersion } from "./refresh-state-PCEDjmSb.js";
import { t as listAgentWorkspaceDirs } from "./workspace-dirs-BOQJykhE.js";
import { c as updatePairedNodeMetadata, r as listNodePairing } from "./node-pairing-Dqxd4uL_.js";
//#region src/infra/skills-remote.ts
const log = createSubsystemLogger("gateway/skills-remote");
const remoteNodes = /* @__PURE__ */ new Map();
const remoteBinProbeInflight = /* @__PURE__ */ new Map();
let remoteRegistry = null;
function describeNode(nodeId) {
	const record = remoteNodes.get(nodeId);
	const name = record?.displayName?.trim();
	const base = name && name !== nodeId ? `${name} (${nodeId})` : nodeId;
	const ip = record?.remoteIp?.trim();
	return ip ? `${base} @ ${ip}` : base;
}
function extractErrorMessage(err) {
	if (!err) return;
	if (typeof err === "string") return err;
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
	if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
	if (typeof err === "symbol") return err.toString();
	if (typeof err === "object") try {
		return JSON.stringify(err);
	} catch {
		return;
	}
}
function logRemoteBinProbeFailure(nodeId, err, context) {
	const message = extractErrorMessage(err);
	const label = describeNode(nodeId);
	const details = [
		context?.command ? `command=${context.command}` : void 0,
		typeof context?.timeoutMs === "number" ? `timeoutMs=${context.timeoutMs}` : void 0,
		typeof context?.requiredBinCount === "number" ? `requiredBins=${context.requiredBinCount}` : void 0,
		`connected=${remoteNodes.get(nodeId)?.connected === true ? "yes" : "no"}`
	].filter(Boolean).join(" ");
	if (message?.includes("node not connected") || message?.includes("node disconnected")) {
		log.info(`remote bin probe skipped: node unavailable (${label}; ${details})`);
		return;
	}
	if (message?.includes("invoke timed out") || message?.includes("timeout")) {
		log.warn(`remote bin probe timed out (${label}; ${details}); check node connectivity for ${label}`);
		return;
	}
	log.warn(`remote bin probe error (${label}; ${details}): ${message ?? "unknown"}`);
}
function logRemoteBinProbePreflightFailure(nodeId, err, context) {
	const message = extractErrorMessage(err);
	const label = describeNode(nodeId);
	const details = [
		context?.command ? `command=${context.command}` : void 0,
		typeof context?.timeoutMs === "number" ? `timeoutMs=${context.timeoutMs}` : void 0,
		typeof context?.requiredBinCount === "number" ? `requiredBins=${context.requiredBinCount}` : void 0,
		`connected=${remoteNodes.get(nodeId)?.connected === true ? "yes" : "no"}`
	].filter(Boolean).join(" ");
	log.info(`remote bin probe skipped: node connectivity unavailable (${label}; ${details}): ${message ?? "unknown"}`);
}
function isMacPlatform(platform, deviceFamily) {
	const platformNorm = normalizeLowercaseStringOrEmpty(platform);
	const familyNorm = normalizeLowercaseStringOrEmpty(deviceFamily);
	if (platformNorm.includes("mac")) return true;
	if (platformNorm.includes("darwin")) return true;
	if (familyNorm === "mac") return true;
	return false;
}
function supportsSystemRun(commands) {
	return Array.isArray(commands) && commands.includes("system.run");
}
function supportsSystemWhich(commands) {
	return Array.isArray(commands) && commands.includes("system.which");
}
function upsertNode(record) {
	const existing = remoteNodes.get(record.nodeId);
	const bins = new Set(record.bins ?? existing?.bins ?? []);
	remoteNodes.set(record.nodeId, {
		nodeId: record.nodeId,
		displayName: record.displayName ?? existing?.displayName,
		platform: record.platform ?? existing?.platform,
		deviceFamily: record.deviceFamily ?? existing?.deviceFamily,
		commands: record.commands ?? existing?.commands,
		remoteIp: record.remoteIp ?? existing?.remoteIp,
		bins,
		connected: record.connected ?? existing?.connected ?? false
	});
}
function clearRemoteNodeBins(nodeId) {
	const existing = remoteNodes.get(nodeId);
	if (!existing || existing.bins.size === 0) return false;
	existing.bins = /* @__PURE__ */ new Set();
	return true;
}
function setSkillsRemoteRegistry(registry) {
	remoteRegistry = registry;
}
async function primeRemoteSkillsCache() {
	try {
		const list = await listNodePairing();
		let sawMac = false;
		for (const node of list.paired) {
			upsertNode({
				nodeId: node.nodeId,
				displayName: node.displayName,
				platform: node.platform,
				deviceFamily: node.deviceFamily,
				commands: node.commands,
				remoteIp: node.remoteIp,
				bins: node.bins,
				connected: false
			});
			if (node.bins && node.bins.length > 0 && isMacPlatform(node.platform, node.deviceFamily) && supportsSystemRun(node.commands)) sawMac = true;
		}
		if (sawMac) bumpSkillsSnapshotVersion({ reason: "remote-node" });
	} catch (err) {
		log.warn(`failed to prime remote skills cache: ${String(err)}`);
	}
}
function recordRemoteNodeInfo(node) {
	upsertNode({
		...node,
		connected: true
	});
}
function recordRemoteNodeBins(nodeId, bins) {
	upsertNode({
		nodeId,
		bins
	});
}
function removeRemoteNodeInfo(nodeId) {
	const existing = remoteNodes.get(nodeId);
	remoteNodes.delete(nodeId);
	if (existing && isMacPlatform(existing.platform, existing.deviceFamily) && supportsSystemRun(existing.commands)) bumpSkillsSnapshotVersion({ reason: "remote-node" });
}
function collectRequiredBins(entries, targetPlatform) {
	const bins = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		const os = entry.metadata?.os ?? [];
		if (os.length > 0 && !os.includes(targetPlatform)) continue;
		const required = entry.metadata?.requires?.bins ?? [];
		const anyBins = entry.metadata?.requires?.anyBins ?? [];
		for (const bin of required) if (bin.trim()) bins.add(bin.trim());
		for (const bin of anyBins) if (bin.trim()) bins.add(bin.trim());
	}
	return [...bins];
}
function buildBinProbeScript(bins) {
	return `for b in ${bins.map((bin) => `'${bin.replace(/'/g, `'\\''`)}'`).join(" ")}; do if command -v "$b" >/dev/null 2>&1; then echo "$b"; fi; done`;
}
function parseBinProbePayload(payloadJSON, payload) {
	if (!payloadJSON && !payload) return [];
	try {
		const parsed = payloadJSON ? JSON.parse(payloadJSON) : payload;
		if (Array.isArray(parsed.bins)) return parsed.bins.map((bin) => normalizeOptionalString(String(bin)) ?? "").filter(Boolean);
		if (parsed.bins && typeof parsed.bins === "object") return Object.entries(parsed.bins).filter(([, resolvedPath]) => normalizeOptionalString(resolvedPath) !== void 0).map(([bin]) => normalizeOptionalString(bin) ?? "").filter(Boolean);
		if (typeof parsed.stdout === "string") return parsed.stdout.split(/\r?\n/).map((line) => normalizeOptionalString(line) ?? "").filter(Boolean);
	} catch {
		return [];
	}
	return [];
}
function areBinSetsEqual(a, b) {
	if (!a) return false;
	if (a.size !== b.size) return false;
	for (const bin of b) if (!a.has(bin)) return false;
	return true;
}
async function refreshRemoteNodeBins(params) {
	const existing = remoteBinProbeInflight.get(params.nodeId);
	if (existing) {
		await existing;
		return;
	}
	const run = refreshRemoteNodeBinsUncoalesced(params).finally(() => {
		if (remoteBinProbeInflight.get(params.nodeId) === run) remoteBinProbeInflight.delete(params.nodeId);
	});
	remoteBinProbeInflight.set(params.nodeId, run);
	await run;
}
async function refreshRemoteNodeBinsUncoalesced(params) {
	if (!remoteRegistry) return;
	if (!isMacPlatform(params.platform, params.deviceFamily)) return;
	const canWhich = supportsSystemWhich(params.commands);
	const canRun = supportsSystemRun(params.commands);
	if (!canWhich && !canRun) return;
	const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
	const requiredBins = /* @__PURE__ */ new Set();
	for (const workspaceDir of workspaceDirs) {
		const entries = loadWorkspaceSkillEntries(workspaceDir, { config: params.cfg });
		for (const bin of collectRequiredBins(entries, "darwin")) requiredBins.add(bin);
	}
	if (requiredBins.size === 0) return;
	const binsList = [...requiredBins];
	const timeoutMs = params.timeoutMs ?? 15e3;
	const command = canWhich ? "system.which" : "system.run";
	const logContext = {
		command,
		timeoutMs,
		requiredBinCount: binsList.length
	};
	const connectivityTimeoutMs = Math.min(timeoutMs, 2e3);
	if (typeof remoteRegistry.checkConnectivity === "function") {
		const preflightConnId = remoteRegistry.get(params.nodeId)?.connId;
		const connectivity = await remoteRegistry.checkConnectivity(params.nodeId, connectivityTimeoutMs);
		if (!connectivity.ok) {
			const latestSession = remoteRegistry.get(params.nodeId);
			if (preflightConnId && latestSession && latestSession.connId !== preflightConnId) {
				await refreshRemoteNodeBinsUncoalesced({
					nodeId: latestSession.nodeId,
					platform: latestSession.platform,
					deviceFamily: latestSession.deviceFamily,
					commands: latestSession.commands,
					cfg: params.cfg,
					timeoutMs: params.timeoutMs
				});
				return;
			}
			const cleared = clearRemoteNodeBins(params.nodeId);
			logRemoteBinProbePreflightFailure(params.nodeId, connectivity.error.message, {
				command: "websocket.ping",
				timeoutMs: connectivityTimeoutMs,
				requiredBinCount: binsList.length
			});
			if (cleared) bumpSkillsSnapshotVersion({ reason: "remote-node" });
			return;
		}
	}
	try {
		const res = await remoteRegistry.invoke(canWhich ? {
			nodeId: params.nodeId,
			command,
			params: { bins: binsList },
			timeoutMs
		} : {
			nodeId: params.nodeId,
			command,
			params: { command: [
				"/bin/sh",
				"-lc",
				buildBinProbeScript(binsList)
			] },
			timeoutMs
		});
		if (!res.ok) {
			const cleared = clearRemoteNodeBins(params.nodeId);
			logRemoteBinProbeFailure(params.nodeId, res.error?.message ?? "unknown", logContext);
			if (cleared) bumpSkillsSnapshotVersion({ reason: "remote-node" });
			return;
		}
		const bins = parseBinProbePayload(res.payloadJSON, res.payload);
		const existingBins = remoteNodes.get(params.nodeId)?.bins;
		const hasChanged = !areBinSetsEqual(existingBins, new Set(bins));
		recordRemoteNodeBins(params.nodeId, bins);
		if (!hasChanged) return;
		await updatePairedNodeMetadata(params.nodeId, { bins });
		bumpSkillsSnapshotVersion({ reason: "remote-node" });
	} catch (err) {
		const cleared = clearRemoteNodeBins(params.nodeId);
		logRemoteBinProbeFailure(params.nodeId, err, logContext);
		if (cleared) bumpSkillsSnapshotVersion({ reason: "remote-node" });
	}
}
function getRemoteSkillEligibility(options) {
	const macNodes = [...remoteNodes.values()].filter((node) => node.connected && isMacPlatform(node.platform, node.deviceFamily) && supportsSystemRun(node.commands));
	if (macNodes.length === 0) return;
	const bins = /* @__PURE__ */ new Set();
	for (const node of macNodes) for (const bin of node.bins) bins.add(bin);
	const labels = macNodes.map((node) => node.displayName ?? node.nodeId).filter(Boolean);
	const note = options?.advertiseExecNode === false ? void 0 : labels.length > 0 ? `Remote macOS node available (${labels.join(", ")}). Run macOS-only skills via exec host=node on that node.` : "Remote macOS node available. Run macOS-only skills via exec host=node on that node.";
	return {
		platforms: ["darwin"],
		hasBin: (bin) => bins.has(bin),
		hasAnyBin: (required) => required.some((bin) => bins.has(bin)),
		...note ? { note } : {}
	};
}
async function refreshRemoteBinsForConnectedNodes(cfg) {
	if (!remoteRegistry) return;
	const connected = remoteRegistry.listConnected();
	for (const node of connected) await refreshRemoteNodeBins({
		nodeId: node.nodeId,
		platform: node.platform,
		deviceFamily: node.deviceFamily,
		commands: node.commands,
		cfg
	});
}
//#endregion
export { refreshRemoteBinsForConnectedNodes as a, setSkillsRemoteRegistry as c, recordRemoteNodeInfo as i, primeRemoteSkillsCache as n, refreshRemoteNodeBins as o, recordRemoteNodeBins as r, removeRemoteNodeInfo as s, getRemoteSkillEligibility as t };
