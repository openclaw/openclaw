import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { o as writeJsonAtomic } from "./json-files-DPM4MwsB.js";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
//#region src/node-host/config.ts
const NODE_HOST_FILE = "node.json";
function resolveNodeHostConfigPath() {
	return path.join(resolveStateDir(), NODE_HOST_FILE);
}
function normalizeConfig(config) {
	const base = {
		version: 1,
		nodeId: "",
		token: config?.token,
		displayName: config?.displayName,
		gateway: config?.gateway
	};
	if (config?.version === 1 && typeof config.nodeId === "string") base.nodeId = config.nodeId.trim();
	if (!base.nodeId) base.nodeId = crypto.randomUUID();
	return base;
}
async function loadNodeHostConfig() {
	const filePath = resolveNodeHostConfigPath();
	try {
		const raw = await fs.readFile(filePath, "utf8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return null;
	}
}
async function saveNodeHostConfig(config) {
	await writeJsonAtomic(resolveNodeHostConfigPath(), config, { mode: 384 });
}
async function ensureNodeHostConfig() {
	const normalized = normalizeConfig(await loadNodeHostConfig());
	await saveNodeHostConfig(normalized);
	return normalized;
}
//#endregion
export { loadNodeHostConfig as n, saveNodeHostConfig as r, ensureNodeHostConfig as t };
