import { r as STATE_DIR } from "./paths-Cnwfh6dH.js";
import "./agent-scope-C5uhMtO-.js";
import { l as normalizeMainKey } from "./session-key-CQewiu8n.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-BWnA6LIS.js";
import "./auth-D9txGPY0.js";
import { n as resolveGatewayAuth } from "./auth-resolve-gCe3cvBY.js";
import { i as getRuntimeConfig, r as createConfigIO } from "./io-DxdqJz8n.js";
import { i as resolveMainSessionKey } from "./main-session-B4hR9U8Q.js";
import "./sessions-BVCHk8wn.js";
import { t as getHealthSnapshot } from "./health-DPBmViOk.js";
import { t as listSystemPresence } from "./system-presence-DUBh95A1.js";
import { t as getUpdateAvailable } from "./update-startup-XoCeeyPN.js";
//#region src/gateway/server/health-state.ts
let presenceVersion = 1;
let healthVersion = 1;
let healthCache = null;
let healthRefresh = null;
let sensitiveHealthRefresh = null;
let broadcastHealthUpdate = null;
function buildGatewaySnapshot(opts) {
	const cfg = getRuntimeConfig();
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const mainKey = normalizeMainKey(cfg.session?.mainKey);
	const mainSessionKey = resolveMainSessionKey(cfg);
	const scope = cfg.session?.scope ?? "per-sender";
	const presence = listSystemPresence();
	const uptimeMs = Math.round(process.uptime() * 1e3);
	const updateAvailable = getUpdateAvailable() ?? void 0;
	const snapshot = {
		presence,
		health: {},
		stateVersion: {
			presence: presenceVersion,
			health: healthVersion
		},
		uptimeMs,
		sessionDefaults: {
			defaultAgentId,
			mainKey,
			mainSessionKey,
			scope
		},
		updateAvailable
	};
	if (opts?.includeSensitive === true) {
		const auth = resolveGatewayAuth({
			authConfig: cfg.gateway?.auth,
			env: process.env
		});
		snapshot.configPath = createConfigIO().configPath;
		snapshot.stateDir = STATE_DIR;
		snapshot.authMode = auth.mode;
	}
	return snapshot;
}
function getHealthCache() {
	return healthCache;
}
function getHealthVersion() {
	return healthVersion;
}
function incrementPresenceVersion() {
	presenceVersion += 1;
	return presenceVersion;
}
function getPresenceVersion() {
	return presenceVersion;
}
function setBroadcastHealthUpdate(fn) {
	broadcastHealthUpdate = fn;
}
async function refreshGatewayHealthSnapshot(opts) {
	const includeSensitive = opts?.includeSensitive === true;
	let refresh = includeSensitive ? sensitiveHealthRefresh : healthRefresh;
	if (!refresh) {
		refresh = (async () => {
			let runtimeSnapshot;
			try {
				runtimeSnapshot = opts?.getRuntimeSnapshot?.();
			} catch {
				runtimeSnapshot = void 0;
			}
			const eventLoop = opts?.getEventLoopHealth?.();
			const snap = await getHealthSnapshot({
				probe: opts?.probe,
				includeSensitive,
				runtimeSnapshot,
				...eventLoop ? { eventLoop } : {}
			});
			if (!includeSensitive) {
				healthCache = snap;
				healthVersion += 1;
				if (broadcastHealthUpdate) broadcastHealthUpdate(snap);
			}
			return snap;
		})().finally(() => {
			if (includeSensitive) sensitiveHealthRefresh = null;
			else healthRefresh = null;
		});
		if (includeSensitive) sensitiveHealthRefresh = refresh;
		else healthRefresh = refresh;
	}
	return refresh;
}
//#endregion
export { incrementPresenceVersion as a, getPresenceVersion as i, getHealthCache as n, refreshGatewayHealthSnapshot as o, getHealthVersion as r, setBroadcastHealthUpdate as s, buildGatewaySnapshot as t };
