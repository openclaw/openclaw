import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { l as normalizeTrimmedStringList } from "./string-normalization-DiPHgdft.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-Cy1cBr1u.js";
import { Nn as record, Rn as string, Zn as unknown } from "./schemas-Del5uzR8.js";
import { n as safeParseWithSchema, t as safeParseJsonWithSchema } from "./zod-parse-B4dzFRWI.js";
import { t as note } from "./note-Dg2Luaaq.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/doctor-plugin-manifests.ts
const LEGACY_MANIFEST_CONTRACT_KEYS = [
	"speechProviders",
	"mediaUnderstandingProviders",
	"imageGenerationProviders",
	"tools"
];
const JsonRecordSchema = record(string(), unknown());
function readManifestJson(manifestPath) {
	try {
		return safeParseJsonWithSchema(JsonRecordSchema, fs.readFileSync(manifestPath, "utf-8"));
	} catch {
		return null;
	}
}
function manifestSeenKey(manifestPath) {
	try {
		return fs.realpathSync.native(manifestPath);
	} catch {
		return path.resolve(manifestPath);
	}
}
function buildLegacyManifestContractMigration(params) {
	const nextRaw = { ...params.raw };
	const parsedContracts = safeParseWithSchema(JsonRecordSchema, params.raw.contracts);
	const nextContracts = parsedContracts ? { ...parsedContracts } : {};
	const changeLines = [];
	for (const key of LEGACY_MANIFEST_CONTRACT_KEYS) {
		if (!(key in params.raw)) continue;
		const legacyValues = normalizeTrimmedStringList(params.raw[key]);
		const contractValues = normalizeTrimmedStringList(nextContracts[key]);
		if (legacyValues.length > 0 && contractValues.length === 0) {
			nextContracts[key] = legacyValues;
			changeLines.push(`- ${shortenHomePath(params.manifestPath)}: moved ${key} to contracts.${key}`);
		} else changeLines.push(`- ${shortenHomePath(params.manifestPath)}: removed legacy ${key} (kept contracts.${key})`);
		delete nextRaw[key];
	}
	if (changeLines.length === 0) return null;
	if (Object.keys(nextContracts).length > 0) nextRaw.contracts = nextContracts;
	else delete nextRaw.contracts;
	const pluginId = normalizeOptionalString(params.raw.id) ?? params.manifestPath;
	return {
		manifestPath: params.manifestPath,
		pluginId,
		nextRaw,
		changeLines
	};
}
function collectLegacyPluginManifestContractMigrations(params) {
	const seen = /* @__PURE__ */ new Set();
	const migrations = [];
	for (const root of params?.manifestRoots ?? []) {
		if (!fs.existsSync(root)) continue;
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manifestPath = path.join(root, entry.name, "openclaw.plugin.json");
			const seenKey = manifestSeenKey(manifestPath);
			if (seen.has(seenKey)) continue;
			seen.add(seenKey);
			const raw = readManifestJson(manifestPath);
			if (!raw) continue;
			const migration = buildLegacyManifestContractMigration({
				manifestPath,
				raw
			});
			if (migration) migrations.push(migration);
		}
	}
	for (const plugin of loadPluginManifestRegistry({
		...params?.config ? { config: params.config } : {},
		...params?.env ? { env: params.env } : {},
		...params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	}).plugins) {
		const seenKey = manifestSeenKey(plugin.manifestPath);
		if (seen.has(seenKey)) continue;
		seen.add(seenKey);
		const raw = readManifestJson(plugin.manifestPath);
		if (!raw) continue;
		const migration = buildLegacyManifestContractMigration({
			manifestPath: plugin.manifestPath,
			raw
		});
		if (migration) migrations.push(migration);
	}
	return migrations.toSorted((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}
async function maybeRepairLegacyPluginManifestContracts(params) {
	const migrations = collectLegacyPluginManifestContractMigrations({
		...params.config ? { config: params.config } : {},
		...params.env ? { env: params.env } : {},
		...params.manifestRoots ? { manifestRoots: params.manifestRoots } : {},
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	});
	if (migrations.length === 0) return;
	const emitNote = params.note ?? note;
	emitNote(["Legacy plugin manifest capability keys detected.", ...migrations.flatMap((migration) => migration.changeLines)].join("\n"), "Plugin manifests");
	if (!(params.prompter.shouldRepair || await params.prompter.confirmAutoFix({
		message: "Rewrite legacy plugin manifest capability keys into contracts now?",
		initialValue: true
	}))) return;
	const applied = [];
	for (const migration of migrations) try {
		fs.writeFileSync(migration.manifestPath, `${JSON.stringify(migration.nextRaw, null, 2)}\n`, "utf-8");
		applied.push(...migration.changeLines);
	} catch (error) {
		params.runtime.error(`Failed to rewrite legacy plugin manifest at ${migration.manifestPath}: ${String(error)}`);
	}
	if (applied.length > 0) emitNote(applied.join("\n"), "Doctor changes");
}
//#endregion
export { maybeRepairLegacyPluginManifestContracts };
