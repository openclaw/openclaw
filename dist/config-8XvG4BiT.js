import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { m as writeJson } from "./json-files-C2hqjU--.js";
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
	await writeJson(resolveNodeHostConfigPath(), config, { mode: 384 });
}
async function ensureNodeHostConfig() {
	const normalized = normalizeConfig(await loadNodeHostConfig());
	await saveNodeHostConfig(normalized);
	return normalized;
}
//#endregion
export { loadNodeHostConfig as n, saveNodeHostConfig as r, ensureNodeHostConfig as t };
