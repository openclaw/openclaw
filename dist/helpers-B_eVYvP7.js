import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import "./security-runtime-CcSekjBd.js";
import { t as MIGRATION_REASON_MISSING_SOURCE_OR_TARGET, u as markMigrationItemError } from "./migration-DGUrqTK8.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { parse } from "yaml";
//#region extensions/migrate-hermes/helpers.ts
const HOME_SHORTHAND_RE = /^~(?=$|[\\/])/u;
const UNSAFE_NAME_CHARS_RE = /[^a-z0-9._-]+/g;
const EDGE_DASHES_RE = /^-+|-+$/g;
function resolveHomePath(input) {
	const value = input.trim();
	return value ? path.resolve(value.replace(HOME_SHORTHAND_RE, os.homedir())) : value;
}
async function exists(filePath) {
	return await pathExists(filePath);
}
async function isDirectory(dirPath) {
	return (await fs.stat(dirPath).catch(() => void 0))?.isDirectory() === true;
}
function sanitizeName(name) {
	return name.trim().toLowerCase().replaceAll(UNSAFE_NAME_CHARS_RE, "-").replaceAll(EDGE_DASHES_RE, "");
}
async function readText(filePath) {
	return filePath ? await fs.readFile(filePath, "utf8").catch(() => void 0) : void 0;
}
function parseEnv(content) {
	const env = {};
	if (!content) return env;
	for (const line of content.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
		if (!match) continue;
		const key = match[1];
		let value = match[2] ?? "";
		if (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
		env[key] = value;
	}
	return env;
}
function parseHermesConfig(content) {
	if (!content) return {};
	try {
		const parsed = parse(content);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function childRecord(root, key) {
	const value = root?.[key];
	return isRecord(value) ? value : {};
}
function readString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
}
async function appendItem(item) {
	if (!item.source || !item.target) return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
	try {
		const content = await fs.readFile(item.source, "utf8");
		const header = `\n\n<!-- Imported from Hermes: ${path.basename(item.source)} -->\n\n`;
		await fs.mkdir(path.dirname(item.target), { recursive: true });
		await appendRegularFile({
			filePath: item.target,
			content: `${header}${content.trimEnd()}\n`,
			rejectSymlinkParents: true
		});
		return {
			...item,
			status: "migrated"
		};
	} catch (err) {
		return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
	}
}
//#endregion
export { isRecord as a, readString as c, resolveHomePath as d, sanitizeName as f, isDirectory as i, readStringArray as l, childRecord as n, parseEnv as o, exists as r, parseHermesConfig as s, appendItem as t, readText as u };
