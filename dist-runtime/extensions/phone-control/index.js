import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/phone-control/index.ts
const STATE_VERSION = 2;
const STATE_REL_PATH = [
	"plugins",
	"phone-control",
	"armed.json"
];
const GROUP_COMMANDS = {
	camera: ["camera.snap", "camera.clip"],
	screen: ["screen.record"],
	writes: [
		"calendar.add",
		"contacts.add",
		"reminders.add",
		"sms.send"
	]
};
function uniqSorted(values) {
	return [...new Set(values.map((v) => v.trim()).filter(Boolean))].toSorted();
}
function resolveCommandsForGroup(group) {
	if (group === "all") return uniqSorted(Object.values(GROUP_COMMANDS).flat());
	return uniqSorted(GROUP_COMMANDS[group]);
}
function formatGroupList() {
	return [
		"camera",
		"screen",
		"writes",
		"all"
	].join(", ");
}
function parseDurationMs(input) {
	if (!input) return null;
	const raw = input.trim().toLowerCase();
	if (!raw) return null;
	const m = raw.match(/^(\d+)(s|m|h|d)$/);
	if (!m) return null;
	const n = Number.parseInt(m[1] ?? "", 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = m[2];
	return n * (unit === "s" ? 1e3 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5);
}
function formatDuration(ms) {
	const s = Math.max(0, Math.floor(ms / 1e3));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}
function resolveStatePath(stateDir) {
	return path.join(stateDir, ...STATE_REL_PATH);
}
async function readArmState(statePath) {
	try {
		const raw = await fs.readFile(statePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed.version !== 1 && parsed.version !== 2) return null;
		if (typeof parsed.armedAtMs !== "number") return null;
		if (!(parsed.expiresAtMs === null || typeof parsed.expiresAtMs === "number")) return null;
		if (parsed.version === 1) {
			if (!Array.isArray(parsed.removedFromDeny) || !parsed.removedFromDeny.every((v) => typeof v === "string")) return null;
			return parsed;
		}
		const group = typeof parsed.group === "string" ? parsed.group : "";
		if (group !== "camera" && group !== "screen" && group !== "writes" && group !== "all") return null;
		if (!Array.isArray(parsed.armedCommands) || !parsed.armedCommands.every((v) => typeof v === "string")) return null;
		if (!Array.isArray(parsed.addedToAllow) || !parsed.addedToAllow.every((v) => typeof v === "string")) return null;
		if (!Array.isArray(parsed.removedFromDeny) || !parsed.removedFromDeny.every((v) => typeof v === "string")) return null;
		return parsed;
	} catch {
		return null;
	}
}
async function writeArmState(statePath, state) {
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	if (!state) {
		try {
			await fs.unlink(statePath);
		} catch {}
		return;
	}
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
function normalizeDenyList(cfg) {
	return uniqSorted([...cfg.gateway?.nodes?.denyCommands ?? []]);
}
function normalizeAllowList(cfg) {
	return uniqSorted([...cfg.gateway?.nodes?.allowCommands ?? []]);
}
function patchConfigNodeLists(cfg, next) {
	return {
		...cfg,
		gateway: {
			...cfg.gateway,
			nodes: {
				...cfg.gateway?.nodes,
				allowCommands: next.allowCommands,
				denyCommands: next.denyCommands
			}
		}
	};
}
async function disarmNow(params) {
	const { api, stateDir, statePath, reason } = params;
	const state = await readArmState(statePath);
	if (!state) return {
		changed: false,
		restored: [],
		removed: []
	};
	const cfg = api.runtime.config.loadConfig();
	const allow = new Set(normalizeAllowList(cfg));
	const deny = new Set(normalizeDenyList(cfg));
	const removed = [];
	const restored = [];
	if (state.version === 1) {
		for (const cmd of state.removedFromDeny) if (!deny.has(cmd)) {
			deny.add(cmd);
			restored.push(cmd);
		}
	} else {
		for (const cmd of state.addedToAllow) if (allow.delete(cmd)) removed.push(cmd);
		for (const cmd of state.removedFromDeny) if (!deny.has(cmd)) {
			deny.add(cmd);
			restored.push(cmd);
		}
	}
	if (removed.length > 0 || restored.length > 0) {
		const next = patchConfigNodeLists(cfg, {
			allowCommands: uniqSorted([...allow]),
			denyCommands: uniqSorted([...deny])
		});
		await api.runtime.config.writeConfigFile(next);
	}
	await writeArmState(statePath, null);
	api.logger.info(`phone-control: disarmed (${reason}) stateDir=${stateDir}`);
	return {
		changed: removed.length > 0 || restored.length > 0,
		removed: uniqSorted(removed),
		restored: uniqSorted(restored)
	};
}
function formatHelp() {
	return [
		"Phone control commands:",
		"",
		"/phone status",
		"/phone arm <group> [duration]",
		"/phone disarm",
		"",
		"Groups:",
		`- ${formatGroupList()}`,
		"",
		"Duration format: 30s | 10m | 2h | 1d (default: 10m).",
		"",
		"Notes:",
		"- This only toggles what the gateway is allowed to invoke on phone nodes.",
		"- iOS will still ask for permissions (camera, photos, contacts, etc.) on first use."
	].join("\n");
}
function parseGroup(raw) {
	const value = (raw ?? "").trim().toLowerCase();
	if (!value) return null;
	if (value === "camera" || value === "screen" || value === "writes" || value === "all") return value;
	return null;
}
function formatStatus(state) {
	if (!state) return "Phone control: disarmed.";
	const until = state.expiresAtMs == null ? "manual disarm required" : `expires in ${formatDuration(Math.max(0, state.expiresAtMs - Date.now()))}`;
	const cmds = uniqSorted(state.version === 1 ? state.removedFromDeny : state.armedCommands.length > 0 ? state.armedCommands : [...state.addedToAllow, ...state.removedFromDeny]);
	return `Phone control: armed (${until}).\nTemporarily allowed: ${cmds.length > 0 ? cmds.join(", ") : "none"}`;
}
function register(api) {
	let expiryInterval = null;
	api.registerService({
		id: "phone-control-expiry",
		start: async (ctx) => {
			const statePath = resolveStatePath(ctx.stateDir);
			const tick = async () => {
				const state = await readArmState(statePath);
				if (!state || state.expiresAtMs == null) return;
				if (Date.now() < state.expiresAtMs) return;
				await disarmNow({
					api,
					stateDir: ctx.stateDir,
					statePath,
					reason: "expired"
				});
			};
			await tick().catch(() => {});
			expiryInterval = setInterval(() => {
				tick().catch(() => {});
			}, 15e3);
			expiryInterval.unref?.();
		},
		stop: async () => {
			if (expiryInterval) {
				clearInterval(expiryInterval);
				expiryInterval = null;
			}
		}
	});
	api.registerCommand({
		name: "phone",
		description: "Arm/disarm high-risk phone node commands (camera/screen/writes).",
		acceptsArgs: true,
		handler: async (ctx) => {
			const tokens = (ctx.args?.trim() ?? "").split(/\s+/).filter(Boolean);
			const action = tokens[0]?.toLowerCase() ?? "";
			const stateDir = api.runtime.state.resolveStateDir();
			const statePath = resolveStatePath(stateDir);
			if (!action || action === "help") return { text: `${formatStatus(await readArmState(statePath))}\n\n${formatHelp()}` };
			if (action === "status") return { text: formatStatus(await readArmState(statePath)) };
			if (action === "disarm") {
				const res = await disarmNow({
					api,
					stateDir,
					statePath,
					reason: "manual"
				});
				if (!res.changed) return { text: "Phone control: disarmed." };
				const restoredLabel = res.restored.length > 0 ? res.restored.join(", ") : "none";
				return { text: `Phone control: disarmed.\nRemoved allowlist: ${res.removed.length > 0 ? res.removed.join(", ") : "none"}\nRestored denylist: ${restoredLabel}` };
			}
			if (action === "arm") {
				const group = parseGroup(tokens[1]);
				if (!group) return { text: `Usage: /phone arm <group> [duration]\nGroups: ${formatGroupList()}` };
				const durationMs = parseDurationMs(tokens[2]) ?? 10 * 6e4;
				const expiresAtMs = Date.now() + durationMs;
				const commands = resolveCommandsForGroup(group);
				const cfg = api.runtime.config.loadConfig();
				const allowSet = new Set(normalizeAllowList(cfg));
				const denySet = new Set(normalizeDenyList(cfg));
				const addedToAllow = [];
				const removedFromDeny = [];
				for (const cmd of commands) {
					if (!allowSet.has(cmd)) {
						allowSet.add(cmd);
						addedToAllow.push(cmd);
					}
					if (denySet.delete(cmd)) removedFromDeny.push(cmd);
				}
				const next = patchConfigNodeLists(cfg, {
					allowCommands: uniqSorted([...allowSet]),
					denyCommands: uniqSorted([...denySet])
				});
				await api.runtime.config.writeConfigFile(next);
				await writeArmState(statePath, {
					version: STATE_VERSION,
					armedAtMs: Date.now(),
					expiresAtMs,
					group,
					armedCommands: uniqSorted(commands),
					addedToAllow: uniqSorted(addedToAllow),
					removedFromDeny: uniqSorted(removedFromDeny)
				});
				const allowedLabel = uniqSorted(commands).join(", ");
				return { text: `Phone control: armed for ${formatDuration(durationMs)}.\nTemporarily allowed: ${allowedLabel}\nTo disarm early: /phone disarm` };
			}
			return { text: formatHelp() };
		}
	});
}
//#endregion
export { register as default };
