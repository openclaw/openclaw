import { T as pathExists } from "./fs-safe-DpJlqO1z.js";
import { t as appendRegularFile } from "./regular-file-6GdZVPgG.js";
import "./security-runtime-JcBeOGgV.js";
import { t as MIGRATION_REASON_MISSING_SOURCE_OR_TARGET, u as markMigrationItemError } from "./migration-BnsKfCr4.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { parse } from "yaml";
//#region extensions/migrate-hermes/helpers.ts
function resolveHomePath(input) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	return path.resolve(trimmed.replace(/^~(?=$|[\\/])/u, os.homedir()));
}
async function exists(filePath) {
	return await pathExists(filePath);
}
async function isDirectory(dirPath) {
	try {
		return (await fs.stat(dirPath)).isDirectory();
	} catch {
		return false;
	}
}
function sanitizeName(name) {
	return name.trim().toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
}
async function readText(filePath) {
	if (!filePath) return;
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return;
	}
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
