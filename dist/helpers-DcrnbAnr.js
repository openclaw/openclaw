import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import "./security-runtime-CcSekjBd.js";
import { t as MIGRATION_REASON_MISSING_SOURCE_OR_TARGET, u as markMigrationItemError } from "./migration-DGUrqTK8.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region extensions/migrate-claude/helpers.ts
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
async function readJsonObject(filePath) {
	const content = await readText(filePath);
	if (!content) return {};
	try {
		const parsed = JSON.parse(content);
		return isRecord(parsed) ? parsed : {};
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
async function appendItem(item) {
	if (!item.source || !item.target) return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
	try {
		const content = await fs.readFile(item.source, "utf8");
		const header = `\n\n<!-- Imported from Claude: ${typeof item.details?.sourceLabel === "string" ? item.details.sourceLabel : path.basename(item.source)} -->\n\n`;
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
export { isRecord as a, resolveHomePath as c, isDirectory as i, sanitizeName as l, childRecord as n, readJsonObject as o, exists as r, readText as s, appendItem as t };
