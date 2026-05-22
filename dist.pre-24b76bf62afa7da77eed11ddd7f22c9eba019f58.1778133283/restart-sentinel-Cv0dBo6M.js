import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { t as formatCliCommand } from "./command-format-ut6bcRZg.js";
import { s as resolveRuntimeServiceVersion } from "./version-DdTF4eka.js";
import { o as writeJsonAtomic } from "./json-files-DPM4MwsB.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/infra/restart-sentinel.ts
const DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE = "The gateway restart completed successfully. Tell the user OpenClaw restarted successfully and continue any pending work.";
const SENTINEL_FILENAME = "restart-sentinel.json";
function formatDoctorNonInteractiveHint(env = process.env) {
	return `Run: ${formatCliCommand("openclaw doctor --non-interactive", env)}`;
}
function resolveRestartSentinelPath(env = process.env) {
	return path.join(resolveStateDir(env), SENTINEL_FILENAME);
}
async function writeRestartSentinel(payload, env = process.env) {
	const filePath = resolveRestartSentinelPath(env);
	await writeJsonAtomic(filePath, {
		version: 1,
		payload
	}, {
		trailingNewline: true,
		ensureDirMode: 448
	});
	return filePath;
}
function isPlainRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function cloneRestartSentinelPayload(payload) {
	return JSON.parse(JSON.stringify(payload));
}
async function rewriteRestartSentinel(rewrite, env = process.env) {
	const current = await readRestartSentinel(env);
	if (!current) return null;
	const nextPayload = rewrite(cloneRestartSentinelPayload(current.payload));
	if (!nextPayload) return null;
	await writeRestartSentinel(nextPayload, env);
	return {
		version: 1,
		payload: nextPayload
	};
}
async function finalizeUpdateRestartSentinelRunningVersion(version = resolveRuntimeServiceVersion(process.env), env = process.env) {
	return await rewriteRestartSentinel((payload) => {
		if (payload.kind !== "update") return null;
		const stats = payload.stats ? { ...payload.stats } : {};
		const after = isPlainRecord(stats.after) ? { ...stats.after } : {};
		after.version = version;
		stats.after = after;
		return {
			...payload,
			stats
		};
	}, env);
}
async function markUpdateRestartSentinelFailure(reason, env = process.env) {
	return await rewriteRestartSentinel((payload) => {
		if (payload.kind !== "update") return null;
		const stats = payload.stats ? { ...payload.stats } : {};
		stats.reason = reason;
		return {
			...payload,
			status: "error",
			stats
		};
	}, env);
}
async function removeRestartSentinelFile(filePath) {
	if (!filePath) return;
	await fs.unlink(filePath).catch(() => {});
}
function buildRestartSuccessContinuation(params) {
	const message = params.continuationMessage?.trim();
	if (message) return {
		kind: "agentTurn",
		message
	};
	return params.sessionKey?.trim() ? {
		kind: "agentTurn",
		message: DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE
	} : null;
}
async function readRestartSentinel(env = process.env) {
	const filePath = resolveRestartSentinelPath(env);
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			await fs.unlink(filePath).catch(() => {});
			return null;
		}
		if (!parsed || parsed.version !== 1 || !parsed.payload) {
			await fs.unlink(filePath).catch(() => {});
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}
function formatRestartSentinelMessage(payload) {
	const message = payload.message?.trim();
	if (message && (!payload.stats || payload.kind === "config-auto-recovery")) return message;
	const lines = [summarizeRestartSentinel(payload)];
	if (message) lines.push(message);
	const reason = payload.stats?.reason?.trim();
	if (reason && reason !== message) lines.push(`Reason: ${reason}`);
	if (payload.doctorHint?.trim()) lines.push(payload.doctorHint.trim());
	return lines.join("\n");
}
function summarizeRestartSentinel(payload) {
	if (payload.kind === "config-auto-recovery") return "Gateway auto-recovery";
	return `Gateway restart ${payload.kind} ${payload.status}${payload.stats?.mode ? ` (${payload.stats.mode})` : ""}`.trim();
}
function trimLogTail(input, maxChars = 8e3) {
	if (!input) return null;
	const text = input.trimEnd();
	if (text.length <= maxChars) return text;
	return `…${text.slice(text.length - maxChars)}`;
}
//#endregion
export { markUpdateRestartSentinelFailure as a, resolveRestartSentinelPath as c, writeRestartSentinel as d, formatRestartSentinelMessage as i, summarizeRestartSentinel as l, finalizeUpdateRestartSentinelRunningVersion as n, readRestartSentinel as o, formatDoctorNonInteractiveHint as r, removeRestartSentinelFile as s, buildRestartSuccessContinuation as t, trimLogTail as u };
