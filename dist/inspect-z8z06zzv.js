import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { m as resolveGatewayWindowsTaskName, p as resolveGatewaySystemdServiceName, r as GATEWAY_SERVICE_MARKER, u as resolveGatewayLaunchAgentLabel } from "./constants-CmvvKVqh.js";
import { n as resolveHomeDir } from "./paths-Bq0Y-b28.js";
import { i as parseSystemdExecStart } from "./systemd-unit-BiZwreE3.js";
import { t as execSchtasks } from "./schtasks-exec-DaVAzDNM.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/daemon/inspect.ts
const EXTRA_MARKERS = ["openclaw", "clawdbot"];
const SYSTEMD_REFERENCE_ONLY_KEYS = new Set([
	"after",
	"before",
	"bindsto",
	"conflicts",
	"partof",
	"propagatesreloadto",
	"reloadpropagatedfrom",
	"requisite",
	"requires",
	"upholds",
	"wants"
]);
function renderGatewayServiceCleanupHints(env = process.env) {
	const profile = env.OPENCLAW_PROFILE;
	switch (process.platform) {
		case "darwin": {
			const label = resolveGatewayLaunchAgentLabel(profile);
			return [`launchctl bootout gui/$UID/${label}`, `rm ~/Library/LaunchAgents/${label}.plist`];
		}
		case "linux": {
			const unit = resolveGatewaySystemdServiceName(profile);
			return [`systemctl --user disable --now ${unit}.service`, `rm ~/.config/systemd/user/${unit}.service`];
		}
		case "win32": return [`schtasks /Delete /TN "${resolveGatewayWindowsTaskName(profile)}" /F`];
		default: return [];
	}
}
function hasGatewaySubcommandArg(args) {
	return args.some((arg) => {
		const normalized = normalizeLowercaseStringOrEmpty(arg);
		return normalized === "gateway" || /(^|\s)gateway(\s|$)/.test(normalized);
	});
}
function detectMarkerLineWithGateway(contents) {
	const lower = normalizeLowercaseStringOrEmpty(contents.replace(/\\\r?\n\s*/g, " "));
	for (const line of lower.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
		const assignment = trimmed.indexOf("=");
		if (assignment > 0) {
			const key = trimmed.slice(0, assignment).trim();
			if (SYSTEMD_REFERENCE_ONLY_KEYS.has(key)) continue;
			if (key === "execstart" && !hasGatewaySubcommandArg(parseSystemdExecStart(trimmed.slice(assignment + 1).trim()))) continue;
			if (key !== "execstart") continue;
		}
		if (!trimmed.includes("gateway")) continue;
		for (const marker of EXTRA_MARKERS) if (trimmed.includes(marker)) return marker;
	}
	return null;
}
function hasGatewayServiceMarker(content) {
	const lower = normalizeLowercaseStringOrEmpty(content);
	const markerKeys = ["openclaw_service_marker"];
	const kindKeys = ["openclaw_service_kind"];
	const markerValues = [normalizeLowercaseStringOrEmpty(GATEWAY_SERVICE_MARKER)];
	const hasMarkerKey = markerKeys.some((key) => lower.includes(key));
	const hasKindKey = kindKeys.some((key) => lower.includes(key));
	const hasMarkerValue = markerValues.some((value) => lower.includes(value));
	return hasMarkerKey && hasKindKey && hasMarkerValue && lower.includes(normalizeLowercaseStringOrEmpty("gateway"));
}
function extractPlistKeyBlock(contents, key, tag) {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`<key>${escapedKey}<\\/key>\\s*<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
	return contents.match(pattern)?.[1]?.trim() || null;
}
function extractPlistStringValues(contents, key, tag) {
	const block = extractPlistKeyBlock(contents, key, tag);
	if (!block) return [];
	if (tag === "string") return [block];
	return Array.from(block.matchAll(/<string>([\s\S]*?)<\/string>/gi)).map((match) => match[1]?.trim() ?? "").filter(Boolean);
}
function detectLaunchdGatewayExecutionMarker(contents) {
	const program = extractPlistStringValues(contents, "Program", "string");
	const programArguments = extractPlistStringValues(contents, "ProgramArguments", "array");
	if (!hasGatewaySubcommandArg(programArguments)) return null;
	const launchCommand = normalizeLowercaseStringOrEmpty([...program, ...programArguments].filter(Boolean).join("\n"));
	for (const marker of EXTRA_MARKERS) if (launchCommand.includes(marker)) return marker;
	return null;
}
function isOpenClawGatewayLaunchdService(label, contents) {
	if (hasGatewayServiceMarker(contents)) return true;
	if (detectLaunchdGatewayExecutionMarker(contents) !== "openclaw") return false;
	return label.startsWith("ai.openclaw.");
}
function isOpenClawGatewaySystemdService(name, contents) {
	if (hasGatewayServiceMarker(contents)) return true;
	if (!name.startsWith("openclaw-gateway")) return false;
	return normalizeLowercaseStringOrEmpty(contents).includes("gateway");
}
function isOpenClawGatewayTaskName(name) {
	const normalized = normalizeLowercaseStringOrEmpty(name);
	if (!normalized) return false;
	return normalized === normalizeLowercaseStringOrEmpty(resolveGatewayWindowsTaskName()) || normalized.startsWith("openclaw gateway");
}
function tryExtractPlistLabel(contents) {
	const match = contents.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/i);
	if (!match) return null;
	return match[1]?.trim() || null;
}
function isIgnoredLaunchdLabel(label) {
	return label === resolveGatewayLaunchAgentLabel();
}
function isIgnoredSystemdName(name) {
	return name === resolveGatewaySystemdServiceName();
}
function isLegacyLabel(label) {
	return normalizeLowercaseStringOrEmpty(label).includes("clawdbot");
}
async function readDirEntries(dir) {
	try {
		return await fs.readdir(dir);
	} catch {
		return [];
	}
}
async function readUtf8File(filePath) {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return null;
	}
}
async function collectServiceFiles(params) {
	const out = [];
	const entries = await readDirEntries(params.dir);
	for (const entry of entries) {
		if (!entry.endsWith(params.extension)) continue;
		const name = entry.slice(0, -params.extension.length);
		if (params.isIgnoredName(name)) continue;
		const fullPath = path.join(params.dir, entry);
		const contents = await readUtf8File(fullPath);
		if (contents === null) continue;
		out.push({
			entry,
			name,
			fullPath,
			contents
		});
	}
	return out;
}
async function scanLaunchdDir(params) {
	const results = [];
	const candidates = await collectServiceFiles({
		dir: params.dir,
		extension: ".plist",
		isIgnoredName: isIgnoredLaunchdLabel
	});
	for (const { name: labelFromName, fullPath, contents } of candidates) {
		const label = tryExtractPlistLabel(contents) ?? labelFromName;
		const legacyLabel = isLegacyLabel(labelFromName) || isLegacyLabel(label);
		const executionMarker = detectLaunchdGatewayExecutionMarker(contents);
		const marker = hasGatewayServiceMarker(contents) || executionMarker === "openclaw" ? "openclaw" : executionMarker === "clawdbot" || legacyLabel ? "clawdbot" : null;
		if (!marker) continue;
		if (isIgnoredLaunchdLabel(label)) continue;
		if (marker === "openclaw" && isOpenClawGatewayLaunchdService(label, contents)) continue;
		results.push({
			platform: "darwin",
			label,
			detail: `plist: ${fullPath}`,
			scope: params.scope,
			marker,
			legacy: marker !== "openclaw" || isLegacyLabel(label)
		});
	}
	return results;
}
async function scanSystemdDir(params) {
	const results = [];
	const candidates = await collectServiceFiles({
		dir: params.dir,
		extension: ".service",
		isIgnoredName: params.includeManagedOpenClaw ? () => false : isIgnoredSystemdName
	});
	for (const { entry, name, fullPath, contents } of candidates) {
		const marker = hasGatewayServiceMarker(contents) ? "openclaw" : detectMarkerLineWithGateway(contents);
		if (!marker) continue;
		if (!params.includeManagedOpenClaw && marker === "openclaw" && isOpenClawGatewaySystemdService(name, contents)) continue;
		results.push({
			platform: "linux",
			label: entry,
			detail: `unit: ${fullPath}`,
			scope: params.scope,
			marker,
			legacy: marker !== "openclaw"
		});
	}
	return results;
}
async function findSystemGatewayServices() {
	if (process.platform !== "linux") return [];
	const results = [];
	try {
		for (const dir of [
			"/etc/systemd/system",
			"/usr/lib/systemd/system",
			"/lib/systemd/system"
		]) results.push(...await scanSystemdDir({
			dir,
			scope: "system",
			includeManagedOpenClaw: true
		}));
	} catch {
		return [];
	}
	return results;
}
function parseSchtasksList(output) {
	const tasks = [];
	let current = null;
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			if (current) {
				tasks.push(current);
				current = null;
			}
			continue;
		}
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = normalizeLowercaseStringOrEmpty(line.slice(0, idx));
		const value = line.slice(idx + 1).trim();
		if (!value) continue;
		if (key === "taskname") {
			if (current) tasks.push(current);
			current = { name: value };
			continue;
		}
		if (!current) continue;
		if (key === "task to run") current.taskToRun = value;
	}
	if (current) tasks.push(current);
	return tasks;
}
async function findExtraGatewayServices(env, opts = {}) {
	const results = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (svc) => {
		const key = `${svc.platform}:${svc.label}:${svc.detail}:${svc.scope}`;
		if (seen.has(key)) return;
		seen.add(key);
		results.push(svc);
	};
	if (process.platform === "darwin") {
		try {
			const home = resolveHomeDir(env);
			const userDir = path.join(home, "Library", "LaunchAgents");
			for (const svc of await scanLaunchdDir({
				dir: userDir,
				scope: "user"
			})) push(svc);
			if (opts.deep) {
				for (const svc of await scanLaunchdDir({
					dir: path.join(path.sep, "Library", "LaunchAgents"),
					scope: "system"
				})) push(svc);
				for (const svc of await scanLaunchdDir({
					dir: path.join(path.sep, "Library", "LaunchDaemons"),
					scope: "system"
				})) push(svc);
			}
		} catch {
			return results;
		}
		return results;
	}
	if (process.platform === "linux") {
		try {
			const home = resolveHomeDir(env);
			const userDir = path.join(home, ".config", "systemd", "user");
			for (const svc of await scanSystemdDir({
				dir: userDir,
				scope: "user"
			})) push(svc);
			if (opts.deep) for (const dir of [
				"/etc/systemd/system",
				"/usr/lib/systemd/system",
				"/lib/systemd/system"
			]) for (const svc of await scanSystemdDir({
				dir,
				scope: "system"
			})) push(svc);
		} catch {
			return results;
		}
		return results;
	}
	if (process.platform === "win32") {
		if (!opts.deep) return results;
		const res = await execSchtasks([
			"/Query",
			"/FO",
			"LIST",
			"/V"
		]);
		if (res.code !== 0) return results;
		const tasks = parseSchtasksList(res.stdout);
		for (const task of tasks) {
			const name = task.name.trim();
			if (!name) continue;
			if (isOpenClawGatewayTaskName(name)) continue;
			const lowerName = normalizeLowercaseStringOrEmpty(name);
			const lowerCommand = normalizeLowercaseStringOrEmpty(task.taskToRun ?? "");
			let marker = null;
			for (const candidate of EXTRA_MARKERS) if (lowerName.includes(candidate) || lowerCommand.includes(candidate)) {
				marker = candidate;
				break;
			}
			if (!marker) continue;
			push({
				platform: "win32",
				label: name,
				detail: task.taskToRun ? `task: ${name}, run: ${task.taskToRun}` : name,
				scope: "system",
				marker,
				legacy: marker !== "openclaw"
			});
		}
		return results;
	}
	return results;
}
//#endregion
export { renderGatewayServiceCleanupHints as i, findExtraGatewayServices as n, findSystemGatewayServices as r, detectMarkerLineWithGateway as t };
