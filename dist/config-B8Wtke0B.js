import { At as boolean, Et as array, Ln as strictObject, Rn as string, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { n as buildPluginConfigSchema } from "./config-schema-DBTUnI0T.js";
import { c as mapPluginConfigIssues } from "./extension-shared-DSIp8QS_.js";
import "./api-DPrhLRY7.js";
import path from "node:path";
import os from "node:os";
//#region extensions/memory-wiki/src/config.ts
const WIKI_VAULT_MODES = [
	"isolated",
	"bridge",
	"unsafe-local"
];
const WIKI_RENDER_MODES = ["native", "obsidian"];
const WIKI_SEARCH_BACKENDS = ["shared", "local"];
const WIKI_SEARCH_CORPORA = [
	"wiki",
	"memory",
	"all"
];
const DEFAULT_WIKI_VAULT_MODE = "isolated";
const DEFAULT_WIKI_RENDER_MODE = "native";
const DEFAULT_WIKI_SEARCH_BACKEND = "shared";
const DEFAULT_WIKI_SEARCH_CORPUS = "wiki";
const MemoryWikiConfigSource = strictObject({
	vaultMode: _enum(WIKI_VAULT_MODES).optional(),
	vault: strictObject({
		path: string().optional(),
		renderMode: _enum(WIKI_RENDER_MODES).optional()
	}).optional(),
	obsidian: strictObject({
		enabled: boolean().optional(),
		useOfficialCli: boolean().optional(),
		vaultName: string().optional(),
		openAfterWrites: boolean().optional()
	}).optional(),
	bridge: strictObject({
		enabled: boolean().optional(),
		readMemoryArtifacts: boolean().optional(),
		indexDreamReports: boolean().optional(),
		indexDailyNotes: boolean().optional(),
		indexMemoryRoot: boolean().optional(),
		followMemoryEvents: boolean().optional()
	}).optional(),
	unsafeLocal: strictObject({
		allowPrivateMemoryCoreAccess: boolean().optional(),
		paths: array(string()).optional()
	}).optional(),
	ingest: strictObject({
		autoCompile: boolean().optional(),
		maxConcurrentJobs: number().int().min(1).optional(),
		allowUrlIngest: boolean().optional()
	}).optional(),
	search: strictObject({
		backend: _enum(WIKI_SEARCH_BACKENDS).optional(),
		corpus: _enum(WIKI_SEARCH_CORPORA).optional()
	}).optional(),
	context: strictObject({ includeCompiledDigestPrompt: boolean().optional() }).optional(),
	render: strictObject({
		preserveHumanBlocks: boolean().optional(),
		createBacklinks: boolean().optional(),
		createDashboards: boolean().optional()
	}).optional()
});
const memoryWikiConfigSchema = buildPluginConfigSchema(MemoryWikiConfigSource, { safeParse(value) {
	if (value === void 0) return {
		success: true,
		data: resolveMemoryWikiConfig(void 0)
	};
	const result = MemoryWikiConfigSource.safeParse(value);
	if (result.success) return {
		success: true,
		data: resolveMemoryWikiConfig(result.data)
	};
	return {
		success: false,
		error: { issues: mapPluginConfigIssues(result.error.issues) }
	};
} });
function expandHomePath(inputPath, homedir) {
	if (inputPath === "~") return homedir;
	if (inputPath.startsWith("~/")) return path.join(homedir, inputPath.slice(2));
	return inputPath;
}
function resolveDefaultMemoryWikiVaultPath(homedir = os.homedir()) {
	return path.join(homedir, ".openclaw", "wiki", "main");
}
function resolveMemoryWikiConfig(config, options) {
	const homedir = options?.homedir ?? os.homedir();
	const parsed = config ? MemoryWikiConfigSource.safeParse(config) : null;
	const safeConfig = parsed?.success ? parsed.data : config ?? {};
	return {
		vaultMode: safeConfig.vaultMode ?? "isolated",
		vault: {
			path: expandHomePath(safeConfig.vault?.path ?? resolveDefaultMemoryWikiVaultPath(homedir), homedir),
			renderMode: safeConfig.vault?.renderMode ?? "native"
		},
		obsidian: {
			enabled: safeConfig.obsidian?.enabled ?? false,
			useOfficialCli: safeConfig.obsidian?.useOfficialCli ?? false,
			...safeConfig.obsidian?.vaultName ? { vaultName: safeConfig.obsidian.vaultName } : {},
			openAfterWrites: safeConfig.obsidian?.openAfterWrites ?? false
		},
		bridge: {
			enabled: safeConfig.bridge?.enabled ?? false,
			readMemoryArtifacts: safeConfig.bridge?.readMemoryArtifacts ?? true,
			indexDreamReports: safeConfig.bridge?.indexDreamReports ?? true,
			indexDailyNotes: safeConfig.bridge?.indexDailyNotes ?? true,
			indexMemoryRoot: safeConfig.bridge?.indexMemoryRoot ?? true,
			followMemoryEvents: safeConfig.bridge?.followMemoryEvents ?? true
		},
		unsafeLocal: {
			allowPrivateMemoryCoreAccess: safeConfig.unsafeLocal?.allowPrivateMemoryCoreAccess ?? false,
			paths: safeConfig.unsafeLocal?.paths ?? []
		},
		ingest: {
			autoCompile: safeConfig.ingest?.autoCompile ?? true,
			maxConcurrentJobs: safeConfig.ingest?.maxConcurrentJobs ?? 1,
			allowUrlIngest: safeConfig.ingest?.allowUrlIngest ?? true
		},
		search: {
			backend: safeConfig.search?.backend ?? "shared",
			corpus: safeConfig.search?.corpus ?? "wiki"
		},
		context: { includeCompiledDigestPrompt: safeConfig.context?.includeCompiledDigestPrompt ?? false },
		render: {
			preserveHumanBlocks: safeConfig.render?.preserveHumanBlocks ?? true,
			createBacklinks: safeConfig.render?.createBacklinks ?? true,
			createDashboards: safeConfig.render?.createDashboards ?? true
		}
	};
}
//#endregion
export { WIKI_RENDER_MODES as a, WIKI_VAULT_MODES as c, resolveMemoryWikiConfig as d, DEFAULT_WIKI_VAULT_MODE as i, memoryWikiConfigSchema as l, DEFAULT_WIKI_SEARCH_BACKEND as n, WIKI_SEARCH_BACKENDS as o, DEFAULT_WIKI_SEARCH_CORPUS as r, WIKI_SEARCH_CORPORA as s, DEFAULT_WIKI_RENDER_MODE as t, resolveDefaultMemoryWikiVaultPath as u };
