import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import { n as info, r as init_globals, t as danger, u as success } from "./globals-B6h30oSy.js";
import { i as init_paths, t as CONFIG_PATH } from "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import { C as shortenHomePath, d as init_utils } from "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { Jb as writeConfigFile, Ub as readConfigFileSnapshot, fb as OLLAMA_DEFAULT_BASE_URL } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import { o as isBlockedObjectKey } from "./account-id-DSKLJ_RM.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import { a as normalizeConfigIssues, n as formatConfigIssueLines } from "./issue-format-CBjhFckx.js";
import { t as redactConfigObject } from "./redact-snapshot-BvQb4wiH.js";
import JSON5 from "json5";
//#region src/cli/config-cli.ts
init_paths();
init_globals();
init_runtime();
init_theme();
init_utils();
const OLLAMA_API_KEY_PATH = [
	"models",
	"providers",
	"ollama",
	"apiKey"
];
const OLLAMA_PROVIDER_PATH = [
	"models",
	"providers",
	"ollama"
];
function isIndexSegment(raw) {
	return /^[0-9]+$/.test(raw);
}
function parsePath(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	const parts = [];
	let current = "";
	let i = 0;
	while (i < trimmed.length) {
		const ch = trimmed[i];
		if (ch === "\\") {
			const next = trimmed[i + 1];
			if (next) current += next;
			i += 2;
			continue;
		}
		if (ch === ".") {
			if (current) parts.push(current);
			current = "";
			i += 1;
			continue;
		}
		if (ch === "[") {
			if (current) parts.push(current);
			current = "";
			const close = trimmed.indexOf("]", i);
			if (close === -1) throw new Error(`Invalid path (missing "]"): ${raw}`);
			const inside = trimmed.slice(i + 1, close).trim();
			if (!inside) throw new Error(`Invalid path (empty "[]"): ${raw}`);
			parts.push(inside);
			i = close + 1;
			continue;
		}
		current += ch;
		i += 1;
	}
	if (current) parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}
function parseValue(raw, opts) {
	const trimmed = raw.trim();
	if (opts.strictJson) try {
		return JSON5.parse(trimmed);
	} catch (err) {
		throw new Error(`Failed to parse JSON5 value: ${String(err)}`, { cause: err });
	}
	try {
		return JSON5.parse(trimmed);
	} catch {
		return raw;
	}
}
function hasOwnPathKey(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}
function formatDoctorHint(message) {
	return `Run \`${formatCliCommand("openclaw doctor")}\` ${message}`;
}
function validatePathSegments(path) {
	for (const segment of path) if (!isIndexSegment(segment) && isBlockedObjectKey(segment)) throw new Error(`Invalid path segment: ${segment}`);
}
function getAtPath(root, path) {
	let current = root;
	for (const segment of path) {
		if (!current || typeof current !== "object") return { found: false };
		if (Array.isArray(current)) {
			if (!isIndexSegment(segment)) return { found: false };
			const index = Number.parseInt(segment, 10);
			if (!Number.isFinite(index) || index < 0 || index >= current.length) return { found: false };
			current = current[index];
			continue;
		}
		const record = current;
		if (!hasOwnPathKey(record, segment)) return { found: false };
		current = record[segment];
	}
	return {
		found: true,
		value: current
	};
}
function setAtPath(root, path, value) {
	let current = root;
	for (let i = 0; i < path.length - 1; i += 1) {
		const segment = path[i];
		const next = path[i + 1];
		const nextIsIndex = Boolean(next && isIndexSegment(next));
		if (Array.isArray(current)) {
			if (!isIndexSegment(segment)) throw new Error(`Expected numeric index for array segment "${segment}"`);
			const index = Number.parseInt(segment, 10);
			const existing = current[index];
			if (!existing || typeof existing !== "object") current[index] = nextIsIndex ? [] : {};
			current = current[index];
			continue;
		}
		if (!current || typeof current !== "object") throw new Error(`Cannot traverse into "${segment}" (not an object)`);
		const record = current;
		const existing = hasOwnPathKey(record, segment) ? record[segment] : void 0;
		if (!existing || typeof existing !== "object") record[segment] = nextIsIndex ? [] : {};
		current = record[segment];
	}
	const last = path[path.length - 1];
	if (Array.isArray(current)) {
		if (!isIndexSegment(last)) throw new Error(`Expected numeric index for array segment "${last}"`);
		const index = Number.parseInt(last, 10);
		current[index] = value;
		return;
	}
	if (!current || typeof current !== "object") throw new Error(`Cannot set "${last}" (parent is not an object)`);
	current[last] = value;
}
function unsetAtPath(root, path) {
	let current = root;
	for (let i = 0; i < path.length - 1; i += 1) {
		const segment = path[i];
		if (!current || typeof current !== "object") return false;
		if (Array.isArray(current)) {
			if (!isIndexSegment(segment)) return false;
			const index = Number.parseInt(segment, 10);
			if (!Number.isFinite(index) || index < 0 || index >= current.length) return false;
			current = current[index];
			continue;
		}
		const record = current;
		if (!hasOwnPathKey(record, segment)) return false;
		current = record[segment];
	}
	const last = path[path.length - 1];
	if (Array.isArray(current)) {
		if (!isIndexSegment(last)) return false;
		const index = Number.parseInt(last, 10);
		if (!Number.isFinite(index) || index < 0 || index >= current.length) return false;
		current.splice(index, 1);
		return true;
	}
	if (!current || typeof current !== "object") return false;
	const record = current;
	if (!hasOwnPathKey(record, last)) return false;
	delete record[last];
	return true;
}
async function loadValidConfig(runtime = defaultRuntime) {
	const snapshot = await readConfigFileSnapshot();
	if (snapshot.valid) return snapshot;
	runtime.error(`Config invalid at ${shortenHomePath(snapshot.path)}.`);
	for (const line of formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true })) runtime.error(line);
	runtime.error(formatDoctorHint("to repair, then retry."));
	runtime.exit(1);
	return snapshot;
}
function parseRequiredPath(path) {
	const parsedPath = parsePath(path);
	if (parsedPath.length === 0) throw new Error("Path is empty.");
	validatePathSegments(parsedPath);
	return parsedPath;
}
function pathEquals(path, expected) {
	return path.length === expected.length && path.every((segment, index) => segment === expected[index]);
}
function ensureValidOllamaProviderForApiKeySet(root, path) {
	if (!pathEquals(path, OLLAMA_API_KEY_PATH)) return;
	if (getAtPath(root, OLLAMA_PROVIDER_PATH).found) return;
	setAtPath(root, OLLAMA_PROVIDER_PATH, {
		baseUrl: OLLAMA_DEFAULT_BASE_URL,
		api: "ollama",
		models: []
	});
}
async function runConfigGet(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	try {
		const parsedPath = parseRequiredPath(opts.path);
		const res = getAtPath(redactConfigObject((await loadValidConfig(runtime)).config), parsedPath);
		if (!res.found) {
			runtime.error(danger(`Config path not found: ${opts.path}`));
			runtime.exit(1);
			return;
		}
		if (opts.json) {
			runtime.log(JSON.stringify(res.value ?? null, null, 2));
			return;
		}
		if (typeof res.value === "string" || typeof res.value === "number" || typeof res.value === "boolean") {
			runtime.log(String(res.value));
			return;
		}
		runtime.log(JSON.stringify(res.value ?? null, null, 2));
	} catch (err) {
		runtime.error(danger(String(err)));
		runtime.exit(1);
	}
}
async function runConfigUnset(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	try {
		const parsedPath = parseRequiredPath(opts.path);
		const snapshot = await loadValidConfig(runtime);
		const next = structuredClone(snapshot.resolved);
		if (!unsetAtPath(next, parsedPath)) {
			runtime.error(danger(`Config path not found: ${opts.path}`));
			runtime.exit(1);
			return;
		}
		await writeConfigFile(next, { unsetPaths: [parsedPath] });
		runtime.log(info(`Removed ${opts.path}. Restart the gateway to apply.`));
	} catch (err) {
		runtime.error(danger(String(err)));
		runtime.exit(1);
	}
}
async function runConfigFile(opts) {
	const runtime = opts.runtime ?? defaultRuntime;
	try {
		const snapshot = await readConfigFileSnapshot();
		runtime.log(shortenHomePath(snapshot.path));
	} catch (err) {
		runtime.error(danger(String(err)));
		runtime.exit(1);
	}
}
async function runConfigValidate(opts = {}) {
	const runtime = opts.runtime ?? defaultRuntime;
	let outputPath = CONFIG_PATH ?? "openclaw.json";
	try {
		const snapshot = await readConfigFileSnapshot();
		outputPath = snapshot.path;
		const shortPath = shortenHomePath(outputPath);
		if (!snapshot.exists) {
			if (opts.json) runtime.log(JSON.stringify({
				valid: false,
				path: outputPath,
				error: "file not found"
			}));
			else runtime.error(danger(`Config file not found: ${shortPath}`));
			runtime.exit(1);
			return;
		}
		if (!snapshot.valid) {
			const issues = normalizeConfigIssues(snapshot.issues);
			if (opts.json) runtime.log(JSON.stringify({
				valid: false,
				path: outputPath,
				issues
			}, null, 2));
			else {
				runtime.error(danger(`Config invalid at ${shortPath}:`));
				for (const line of formatConfigIssueLines(issues, danger("×"), { normalizeRoot: true })) runtime.error(`  ${line}`);
				runtime.error("");
				runtime.error(formatDoctorHint("to repair, or fix the keys above manually."));
			}
			runtime.exit(1);
			return;
		}
		if (opts.json) runtime.log(JSON.stringify({
			valid: true,
			path: outputPath
		}));
		else runtime.log(success(`Config valid: ${shortPath}`));
	} catch (err) {
		if (opts.json) runtime.log(JSON.stringify({
			valid: false,
			path: outputPath,
			error: String(err)
		}));
		else runtime.error(danger(`Config validation error: ${String(err)}`));
		runtime.exit(1);
	}
}
function registerConfigCli(program) {
	const cmd = program.command("config").description("Non-interactive config helpers (get/set/unset/file/validate). Run without subcommand for the setup wizard.").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/config", "docs.openclaw.ai/cli/config")}\n`).option("--section <section>", "Configure wizard sections (repeatable). Use with no subcommand.", (value, previous) => [...previous, value], []).action(async (opts) => {
		const { configureCommandFromSectionsArg } = await import("./configure-BNw_cZbb.js");
		await configureCommandFromSectionsArg(opts.section, defaultRuntime);
	});
	cmd.command("get").description("Get a config value by dot path").argument("<path>", "Config path (dot or bracket notation)").option("--json", "Output JSON", false).action(async (path, opts) => {
		await runConfigGet({
			path,
			json: Boolean(opts.json)
		});
	});
	cmd.command("set").description("Set a config value by dot path").argument("<path>", "Config path (dot or bracket notation)").argument("<value>", "Value (JSON5 or raw string)").option("--strict-json", "Strict JSON5 parsing (error instead of raw string fallback)", false).option("--json", "Legacy alias for --strict-json", false).action(async (path, value, opts) => {
		try {
			const parsedPath = parseRequiredPath(path);
			const parsedValue = parseValue(value, { strictJson: Boolean(opts.strictJson || opts.json) });
			const snapshot = await loadValidConfig();
			const next = structuredClone(snapshot.resolved);
			ensureValidOllamaProviderForApiKeySet(next, parsedPath);
			setAtPath(next, parsedPath, parsedValue);
			await writeConfigFile(next);
			defaultRuntime.log(info(`Updated ${path}. Restart the gateway to apply.`));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	cmd.command("unset").description("Remove a config value by dot path").argument("<path>", "Config path (dot or bracket notation)").action(async (path) => {
		await runConfigUnset({ path });
	});
	cmd.command("file").description("Print the active config file path").action(async () => {
		await runConfigFile({});
	});
	cmd.command("validate").description("Validate the current config against the schema without starting the gateway").option("--json", "Output validation result as JSON", false).action(async (opts) => {
		await runConfigValidate({ json: Boolean(opts.json) });
	});
}
//#endregion
export { registerConfigCli, runConfigGet, runConfigUnset };
