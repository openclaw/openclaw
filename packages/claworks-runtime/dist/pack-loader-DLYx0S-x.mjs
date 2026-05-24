import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
//#region src/pack-loader/yaml-parsers.ts
/** Accept snake_case (pack YAML) and camelCase (SDK-style) field names. */
function readField(raw, ...keys) {
	for (const key of keys) {
		const value = raw[key];
		if (value != null && String(value).trim() !== "") return String(value);
	}
	return "";
}
async function readPackManifest(manifestPath) {
	const raw = parse(await readFile(manifestPath, "utf8"));
	if (!raw?.id || !raw?.version) throw new Error(`Invalid pack manifest: ${manifestPath}`);
	return raw;
}
function parseObjectTypeYaml(content, packId, fileName) {
	const doc = parse(content);
	const ot = doc.object_type ?? doc;
	const apiName = String(ot.api_name ?? ot.name ?? basename(fileName, ".yaml"));
	let fields = [];
	if (Array.isArray(ot.fields)) fields = ot.fields.map((spec) => ({
		name: String(spec.name ?? ""),
		type: mapYamlType(String(spec.type ?? "string")),
		required: spec.required === true,
		refType: spec.foreign_key ? String(spec.foreign_key).split(".")[0] : void 0
	}));
	else {
		const properties = ot.properties ?? {};
		fields = Object.entries(properties).map(([name, spec]) => ({
			name,
			type: mapYamlType(String(spec.type ?? "string")),
			required: spec.required === true,
			refType: spec.foreign_key ? String(spec.foreign_key).split(".")[0] : void 0
		}));
	}
	return {
		name: apiName,
		description: ot.description ? String(ot.description).trim() : void 0,
		pack: packId,
		primaryKey: String(ot.primary_key ?? ot.primaryKey ?? "id"),
		fields,
		actions: []
	};
}
function parsePlaybookYaml(content, packId) {
	const doc = parse(content);
	const id = String(doc.id ?? "");
	const trigger = parseTrigger(doc.trigger ?? {});
	const steps = (Array.isArray(doc.steps) ? doc.steps : []).map((s, i) => parseStep(s, i));
	const validRoles = [
		"viewer",
		"operator",
		"admin"
	];
	const rawRole = doc.required_role != null ? String(doc.required_role) : void 0;
	const required_role = rawRole && validRoles.includes(rawRole) ? rawRole : void 0;
	return {
		id,
		name: String(doc.name ?? id),
		description: doc.description ? String(doc.description).trim() : void 0,
		pack: packId,
		version: doc.version ? String(doc.version) : void 0,
		trigger,
		priority: typeof doc.priority === "number" ? doc.priority : 0,
		timeout_seconds: typeof doc.timeout_seconds === "number" ? doc.timeout_seconds : void 0,
		required_role,
		steps
	};
}
function parseTrigger(raw) {
	const rawKind = String(raw.kind ?? raw.type ?? "");
	const hasPattern = raw.event_type != null || raw.pattern != null || raw.event != null;
	const hasCron = raw.cron != null || rawKind === "schedule";
	if (rawKind === "manual") return { kind: "manual" };
	if (hasCron) return {
		kind: "schedule",
		cron: String(raw.cron ?? "0 * * * *"),
		timezone: raw.timezone ? String(raw.timezone) : void 0
	};
	if (rawKind === "event" || hasPattern) return {
		kind: "event",
		pattern: String(raw.event ?? raw.event_type ?? raw.pattern ?? "*"),
		condition: raw.condition ? String(raw.condition) : void 0,
		filter: raw.filter
	};
	return { kind: "manual" };
}
function parseStepMeta(raw) {
	const hitlRaw = raw.hitl;
	const hitl = hitlRaw ? {
		requiredIf: hitlRaw.required_if ? String(hitlRaw.required_if) : void 0,
		autoApproveIf: hitlRaw.auto_approve_if ? String(hitlRaw.auto_approve_if) : void 0,
		timeoutHours: typeof hitlRaw.timeout_hours === "number" ? hitlRaw.timeout_hours : void 0
	} : void 0;
	return {
		condition: raw.condition ? String(raw.condition) : void 0,
		onFailure: raw.on_failure === "continue" ? "continue" : "abort",
		hitl
	};
}
function parseStep(raw, index) {
	const id = String(raw.id ?? `step_${index}`);
	const stepType = String(raw.type ?? raw.kind ?? "notification");
	const meta = parseStepMeta(raw);
	if (stepType === "notification") {
		let channels;
		if (Array.isArray(raw.channels)) channels = raw.channels.map(String);
		else if (raw.channel && typeof raw.channel === "string") channels = [raw.channel];
		return {
			...meta,
			kind: "notification",
			id,
			message: String(raw.message ?? ""),
			channels
		};
	}
	if (stepType === "hitl") {
		const hitlMessage = String(raw.message ?? raw.prompt ?? "");
		const resolvedOptions = (Array.isArray(raw.options) ? raw.options : ["approve", "reject"]).map((o) => {
			if (o && typeof o === "object" && "value" in o) return String(o.value);
			return String(o);
		});
		const timeoutHours = typeof raw.timeout_hours === "number" ? raw.timeout_hours : meta.hitl?.timeoutHours;
		const timeoutSeconds = typeof raw.timeout_seconds === "number" ? raw.timeout_seconds : timeoutHours != null ? timeoutHours * 3600 : void 0;
		const autoApproveIf = raw.auto_approve_if != null ? String(raw.auto_approve_if) : meta.hitl?.autoApproveIf;
		const hitlConfig = {
			...meta.hitl,
			...autoApproveIf != null ? { autoApproveIf } : {},
			...timeoutHours != null ? { timeoutHours } : {}
		};
		return {
			...meta,
			hitl: Object.keys(hitlConfig).length > 0 ? hitlConfig : meta.hitl,
			kind: "hitl",
			id,
			message: hitlMessage,
			channel: raw.channel ? String(raw.channel) : void 0,
			options: resolvedOptions,
			output: String(raw.output ?? `${id}_decision`),
			timeout_seconds: timeoutSeconds
		};
	}
	if (stepType === "llm" || stepType === "llm_reason" || stepType === "llm_reasoning") {
		const llmOutput = readField(raw, "output", "output_var", "outputVar");
		return {
			...meta,
			kind: "llm",
			id,
			prompt: String(raw.prompt ?? ""),
			model: raw.model ? String(raw.model) : void 0,
			output: llmOutput || `${id}_result`
		};
	}
	if (stepType === "condition") {
		const thenRaw = Array.isArray(raw.then) ? raw.then : [];
		const elseRaw = Array.isArray(raw.else) ? raw.else : [];
		return {
			kind: "condition",
			id,
			if: String(raw.if ?? "true"),
			then: thenRaw.map((s, i) => parseStep(s, i)),
			else: elseRaw.map((s, i) => parseStep(s, i + 100))
		};
	}
	if (stepType === "scaffold") {
		const outputKey = readField(raw, "store_result_as", "storeResultAs", "output", "output_var");
		const variables = raw.variables ?? raw.params ?? {};
		return {
			...meta,
			kind: "action",
			id,
			actionApiName: "llm.scaffold",
			params: {
				scaffold_id: String(raw.scaffold_id ?? raw.scaffoldId ?? ""),
				variables,
				...raw.extra_context ? { extra_context: String(raw.extra_context) } : {},
				...raw.max_tokens ? { max_tokens: Number(raw.max_tokens) } : {},
				...raw.require_json !== void 0 ? { require_json: raw.require_json === true } : {}
			},
			output: outputKey || id
		};
	}
	if (stepType === "action") {
		const outputKey = readField(raw, "store_result_as", "storeResultAs", "output", "output_var", "outputVar");
		return {
			...meta,
			kind: "action",
			id,
			actionApiName: readField(raw, "action_api_name", "actionApiName", "action", "fn"),
			params: raw.params ?? raw.input ?? {},
			objectType: raw.object_type ? String(raw.object_type) : void 0,
			objectId: raw.object_id ? String(raw.object_id) : void 0,
			output: outputKey || id
		};
	}
	if (stepType === "function") {
		const outputKey = readField(raw, "store_result_as", "storeResultAs", "output", "output_var", "outputVar");
		return {
			...meta,
			kind: "function",
			id,
			functionApiName: readField(raw, "function_api_name", "functionApiName", "function"),
			params: raw.params ?? raw.input ?? {},
			output: outputKey || id
		};
	}
	if (stepType === "connector") return {
		...meta,
		kind: "connector",
		id,
		connectorId: String(raw.connector_id ?? raw.connector ?? ""),
		method: String(raw.method ?? "start"),
		params: raw.params ?? {}
	};
	if (stepType === "playbook") return {
		...meta,
		kind: "playbook",
		id,
		playbookId: String(raw.playbook_id ?? raw.playbook ?? ""),
		input: raw.input ?? raw.params
	};
	if (stepType === "call_playbook") {
		const outputKey = readField(raw, "store_result_as", "storeResultAs", "output");
		return {
			...meta,
			kind: "call_playbook",
			id,
			playbookId: String(raw.playbook_id ?? raw.playbook ?? ""),
			params: raw.params ?? raw.input,
			storeResultAs: outputKey || void 0,
			timeoutSeconds: typeof raw.timeout_seconds === "number" ? raw.timeout_seconds : void 0
		};
	}
	if (stepType === "a2a_delegate") {
		const a2aOutput = readField(raw, "output", "output_var", "outputVar");
		return {
			...meta,
			kind: "a2a_delegate",
			id,
			target: String(raw.target ?? raw.target_url ?? ""),
			task: String(raw.task ?? raw.message ?? ""),
			waitResult: raw.wait_result !== false && raw.waitResult !== false,
			output: a2aOutput || id
		};
	}
	if (stepType === "subagent") {
		const subagentOutput = readField(raw, "output", "output_var", "outputVar");
		return {
			...meta,
			kind: "subagent",
			id,
			prompt: String(raw.prompt ?? ""),
			model: raw.model ? String(raw.model) : void 0,
			output: subagentOutput || id
		};
	}
	if (stepType === "skill") return {
		...meta,
		kind: "skill",
		id,
		skillId: String(raw.skill_id ?? raw.skill ?? ""),
		input: raw.input ?? raw.params,
		output: readField(raw, "store_result_as", "storeResultAs", "output", "output_var") || id
	};
	if (stepType === "script") return {
		...meta,
		kind: "script",
		id,
		scriptId: String(raw.script_id ?? raw.script ?? ""),
		input: raw.input ?? raw.params,
		output: readField(raw, "store_result_as", "storeResultAs", "output", "output_var") || id
	};
	if (stepType === "notify") return {
		...meta,
		kind: "notification",
		id,
		message: String(raw.message ?? ""),
		channels: raw.channel ? [String(raw.channel)] : Array.isArray(raw.channels) ? raw.channels.map(String) : void 0
	};
	if (stepType === "memory_read") return {
		...meta,
		kind: "memory_read",
		id,
		subject: String(raw.subject ?? "global"),
		key: String(raw.key ?? ""),
		output: String(raw.output ?? `${id}_memory`)
	};
	if (stepType === "memory_write") return {
		...meta,
		kind: "memory_write",
		id,
		subject: String(raw.subject ?? "global"),
		key: String(raw.key ?? ""),
		value: raw.value,
		category: raw.category ? String(raw.category) : void 0,
		confidence: typeof raw.confidence === "number" ? raw.confidence : raw.confidence ? Number(raw.confidence) : void 0,
		source: raw.source ? String(raw.source) : void 0,
		output: raw.output ? String(raw.output) : void 0
	};
	if (stepType === "publish_event") return {
		...meta,
		kind: "publish_event",
		id,
		eventType: String(raw.event_type ?? raw.eventType ?? ""),
		source: raw.source ? String(raw.source) : void 0,
		payload: raw.payload ? raw.payload : void 0,
		output: raw.output ? String(raw.output) : void 0
	};
	if (stepType === "parallel") {
		const branchesRaw = Array.isArray(raw.branches) ? raw.branches : [];
		return {
			...meta,
			kind: "parallel",
			id,
			branches: branchesRaw.map((branch) => Array.isArray(branch) ? branch.map((s, i) => parseStep(s, i)) : []),
			merge_strategy: raw.merge_strategy === "first_success" ? "first_success" : "all",
			timeout_seconds: typeof raw.timeout_seconds === "number" ? raw.timeout_seconds : void 0,
			store_result_as: raw.store_result_as ? String(raw.store_result_as) : void 0,
			on_branch_failure: raw.on_branch_failure === "abort_all" ? "abort_all" : "continue"
		};
	}
	return {
		...meta,
		kind: "atomic",
		id,
		fn: String(raw.fn ?? raw.action ?? stepType),
		params: raw.params ?? raw.input ?? {},
		output: raw.output ? String(raw.output) : void 0
	};
}
function mapYamlType(t) {
	if (t === "integer" || t === "float" || t === "number") return "number";
	if (t === "boolean") return "boolean";
	if (t === "datetime" || t === "date") return "date";
	return "string";
}
//#endregion
//#region src/pack-loader/loader.ts
async function listYamlFiles(dir) {
	try {
		return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".yaml")).map((e) => join(dir, e.name));
	} catch {
		return [];
	}
}
/**
* Resolve the pack manifest from either `claworks.pack.json` (legacy) or `pack.yaml` (new format).
* pack.yaml uses a top-level `pack:` key and `requires:` for structured dependencies.
*/
async function readPackManifestFromDir(packDir) {
	return resolveManifest(packDir);
}
async function resolveManifest(packDir) {
	const jsonPath = join(packDir, "claworks.pack.json");
	try {
		await stat(jsonPath);
		return await readPackManifest(jsonPath);
	} catch {}
	const yamlPath = join(packDir, "pack.yaml");
	try {
		const raw = parse(await readFile(yamlPath, "utf8"));
		const p = raw?.pack ?? raw;
		if (!p?.id) throw new Error(`pack.yaml missing id in ${packDir}`);
		const requires = Array.isArray(p.requires) ? p.requires.map((r) => ({
			id: String(r.id ?? ""),
			version: r.version ? String(r.version) : void 0,
			optional: r.optional === true
		})) : void 0;
		const objectTypes = Array.isArray(p.objectTypes) ? p.objectTypes : [];
		const actionTypes = Array.isArray(p.actionTypes) ? p.actionTypes : [];
		const playbooks = Array.isArray(p.playbooks) ? p.playbooks : [];
		return {
			id: String(p.id),
			name: String(p.display_name ?? p.name ?? p.id),
			version: String(p.version ?? "0.1.0"),
			description: p.description ? String(p.description) : void 0,
			license: String(p.license ?? "proprietary"),
			requires,
			provides: {
				objectTypes,
				actionTypes,
				playbooks
			}
		};
	} catch (err) {
		throw new Error(`No claworks.pack.json or pack.yaml found in ${packDir}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
	}
}
/**
* Validate that all non-optional `requires` entries are satisfied by the loaded pack set.
* Returns a list of errors (empty = all dependencies satisfied).
*/
function validatePackDependencies(packs, logger) {
	const loadedById = new Map(packs.map((p) => [p.manifest.id, p.manifest.version]));
	const errors = [];
	for (const pack of packs) {
		const requires = pack.manifest.requires ?? [];
		for (const dep of requires) {
			const installedVersion = loadedById.get(dep.id);
			if (!installedVersion) {
				if (dep.optional) {
					logger?.(`[claworks:packs] optional dependency ${dep.id} for pack ${pack.manifest.id} not installed`);
					continue;
				}
				errors.push({
					packId: pack.manifest.id,
					dependencyId: dep.id,
					reason: `required pack '${dep.id}' is not loaded`
				});
				continue;
			}
			if (dep.version) {
				const match = dep.version.match(/^(>=|<=|=|>|<)\s*(\d+\.\d+\.\d+)$/);
				if (match) {
					const [, op, reqVersion] = match;
					const cmp = compareVersions(installedVersion, reqVersion);
					if (!(op === ">=" ? cmp >= 0 : op === "<=" ? cmp <= 0 : op === ">" ? cmp > 0 : op === "<" ? cmp < 0 : cmp === 0)) if (dep.optional) logger?.(`[claworks:packs] optional dep ${dep.id}@${dep.version} for pack ${pack.manifest.id} version mismatch (installed: ${installedVersion})`);
					else errors.push({
						packId: pack.manifest.id,
						dependencyId: dep.id,
						reason: `pack '${dep.id}' version ${installedVersion} does not satisfy ${dep.version}`
					});
				}
			}
		}
	}
	return errors;
}
function compareVersions(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
/**
* Try to load a Pack entry file (PackFactory).
* Candidate paths (in priority order):
*   1. manifest.entry (relative to packDir)
*   2. index.js  (compiled ESM output)
*   3. index.ts  (ts-node / tsx / Bun environments)
*   4. src/index.js
*/
async function tryLoadFactory(packDir, manifest, logger) {
	const candidates = [];
	if (manifest.entry) {
		candidates.push(join(packDir, manifest.entry));
		if (manifest.entry.endsWith(".js")) candidates.push(join(packDir, manifest.entry.replace(/\.js$/, ".ts")));
	} else candidates.push(join(packDir, "index.js"), join(packDir, "index.ts"), join(packDir, "src", "index.js"), join(packDir, "src", "index.ts"));
	for (const candidate of candidates) try {
		await stat(candidate);
		const mod = await import(pathToFileURL(candidate).href);
		if (typeof mod.default === "function") {
			logger?.(`[claworks:packs] loaded entry for pack '${manifest.id}': ${candidate}`);
			return mod.default;
		}
	} catch {}
}
async function loadPackFromDir(packDir, logger) {
	const manifest = await resolveManifest(packDir);
	const ontologyDir = join(packDir, "ontology");
	const objectTypes = [];
	for (const file of await listYamlFiles(join(ontologyDir, "object_types"))) {
		const content = await readFile(file, "utf8");
		objectTypes.push(parseObjectTypeYaml(content, manifest.id, file));
	}
	const playbooks = [];
	for (const file of await listYamlFiles(join(ontologyDir, "playbooks"))) {
		const content = await readFile(file, "utf8");
		playbooks.push(parsePlaybookYaml(content, manifest.id));
	}
	for (const file of await listYamlFiles(join(ontologyDir, "playbooks", "templates"))) {
		const content = await readFile(file, "utf8");
		playbooks.push(parsePlaybookYaml(content, manifest.id));
	}
	const skills = [];
	const skillsDir = join(packDir, "skills");
	try {
		const skillEntries = await readdir(skillsDir, { withFileTypes: true });
		for (const entry of skillEntries) if (entry.isFile() && /\.skill\.(ts|js)$/.test(entry.name)) {
			const skillId = entry.name.replace(/\.skill\.(ts|js)$/, "");
			skills.push({
				id: skillId,
				filePath: join(skillsDir, entry.name),
				packId: manifest.id
			});
			logger?.(`[claworks:packs] discovered skill '${skillId}' in pack '${manifest.id}'`);
		}
	} catch {}
	const scaffolds = [];
	const scaffoldsDir = join(packDir, "scaffolds");
	try {
		const scaffoldEntries = await readdir(scaffoldsDir, { withFileTypes: true });
		for (const entry of scaffoldEntries) if (entry.isFile() && entry.name.endsWith(".json")) try {
			const raw = JSON.parse(await readFile(join(scaffoldsDir, entry.name), "utf8"));
			if (raw.id && raw.prompt_template) {
				scaffolds.push({
					id: String(raw.id),
					description: raw.description ? String(raw.description) : void 0,
					prompt_template: String(raw.prompt_template),
					output_schema: raw.output_schema,
					output_parser: raw.output_parser ? String(raw.output_parser) : void 0,
					output_parser_config: raw.output_parser_config,
					recommended_models: Array.isArray(raw.recommended_models) ? raw.recommended_models.map(String) : void 0,
					max_tokens: typeof raw.max_tokens === "number" ? raw.max_tokens : void 0,
					temperature: typeof raw.temperature === "number" ? raw.temperature : void 0,
					examples: Array.isArray(raw.examples) ? raw.examples : void 0,
					packId: manifest.id
				});
				logger?.(`[claworks:packs] loaded scaffold '${raw.id}' in pack '${manifest.id}'`);
			}
		} catch {
			logger?.(`[claworks:packs] failed to parse scaffold '${entry.name}' in pack '${manifest.id}'`);
		}
	} catch {}
	return {
		manifest,
		path: packDir,
		objectTypes,
		playbooks,
		factory: await tryLoadFactory(packDir, manifest, logger),
		skills,
		scaffolds
	};
}
/**
* Expand installed pack IDs with non-optional `requires` dependencies (transitive).
* Returns a load order where dependencies precede dependents.
*/
async function resolveInstalledPackIds(installed, searchPaths, logger) {
	const seed = installed.map((ref) => ref.split("@")[0] ?? ref).filter(Boolean);
	const discovered = /* @__PURE__ */ new Set();
	const manifests = /* @__PURE__ */ new Map();
	const queue = [...seed];
	while (queue.length > 0) {
		const packId = queue.shift();
		if (!packId || discovered.has(packId)) continue;
		discovered.add(packId);
		const dir = await resolvePackDir$1(packId, searchPaths);
		if (!dir) {
			logger?.(`[claworks:packs] pack not found during dependency resolve: ${packId}`);
			continue;
		}
		let manifest;
		try {
			manifest = await resolveManifest(dir);
		} catch (err) {
			logger?.(`[claworks:packs] failed to read manifest for '${packId}': ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		manifests.set(packId, manifest);
		for (const dep of manifest.requires ?? []) {
			if (dep.optional) continue;
			if (!discovered.has(dep.id)) queue.push(dep.id);
		}
	}
	const ordered = [];
	const visiting = /* @__PURE__ */ new Set();
	const visited = /* @__PURE__ */ new Set();
	const visit = (packId) => {
		if (visited.has(packId)) return;
		if (visiting.has(packId)) return;
		visiting.add(packId);
		const manifest = manifests.get(packId);
		for (const dep of manifest?.requires ?? []) if (!dep.optional && discovered.has(dep.id)) visit(dep.id);
		visiting.delete(packId);
		visited.add(packId);
		ordered.push(packId);
	};
	for (const packId of seed) if (discovered.has(packId)) visit(packId);
	for (const packId of discovered) if (!visited.has(packId)) visit(packId);
	return ordered;
}
async function resolvePackDir$1(packRef, searchPaths) {
	for (const base of searchPaths) {
		const candidate = join(base, packRef);
		try {
			if ((await stat(join(candidate, "claworks.pack.json"))).isFile()) return candidate;
		} catch {}
	}
	return null;
}
function createPackLoader() {
	const loaded = [];
	return {
		async load(packPath, logger) {
			const pack = await loadPackFromDir(packPath, logger);
			const existing = loaded.findIndex((p) => p.manifest.id === pack.manifest.id);
			if (existing >= 0) loaded[existing] = pack;
			else loaded.push(pack);
			return pack;
		},
		async loadInstalled(config, logger) {
			const paths = config.paths ?? [];
			const installed = config.installed ?? [];
			const expanded = await resolveInstalledPackIds(installed, paths, logger);
			if (expanded.length > installed.length) {
				const added = expanded.filter((id) => !installed.some((ref) => (ref.split("@")[0] ?? ref) === id));
				if (added.length > 0) logger?.(`[claworks:packs] auto-installed required dependencies: ${added.join(", ")}`);
			}
			const results = [];
			for (const packId of expanded) {
				const dir = await resolvePackDir$1(packId, paths);
				if (!dir) {
					logger?.(`[claworks:packs] pack not found: ${packId}`);
					continue;
				}
				results.push(await this.load(dir, logger));
			}
			const depErrors = validatePackDependencies(results, logger);
			for (const err of depErrors) logger?.(`[claworks:packs] dependency error in pack '${err.packId}': ${err.reason}`);
			return results;
		},
		async install(source, config, logger) {
			if (source.startsWith("file://")) return this.load(source.slice(7), logger);
			const dir = await resolvePackDir$1(source.replace(/^nexus:\/\//, "").split("@")[0] ?? source, config.paths ?? []);
			if (!dir) throw new Error(`Pack not found: ${source}`);
			return this.load(dir, logger);
		},
		list() {
			return [...loaded];
		}
	};
}
//#endregion
//#region src/interfaces/nexus/catalog.ts
async function readPackManifestFile(manifestPath) {
	const raw = JSON.parse(await readFile(manifestPath, "utf8"));
	if (!raw?.id || !raw?.version) throw new Error(`Invalid pack manifest: ${manifestPath}`);
	return raw;
}
/** Scan catalog root: each subdir with claworks.pack.json is a pack (version from manifest). */
async function scanNexusCatalog(catalogRoot) {
	const entries = [];
	let dirs;
	try {
		dirs = await readdir(catalogRoot);
	} catch {
		return entries;
	}
	for (const slug of dirs) {
		if (slug.startsWith(".")) continue;
		const dir = join(catalogRoot, slug);
		const manifestPath = join(dir, "claworks.pack.json");
		try {
			if (!(await stat(manifestPath)).isFile()) continue;
			const manifest = await readPackManifestFile(manifestPath);
			entries.push({
				slug: manifest.id || slug,
				dir,
				manifest
			});
		} catch {}
	}
	return entries;
}
function listPackages(entries, opts) {
	const q = opts?.q?.toLowerCase().trim();
	return entries.filter((e) => {
		if (opts?.family && opts.family !== "claworks-pack") return false;
		if (!q) return true;
		return e.slug.toLowerCase().includes(q) || e.manifest.name.toLowerCase().includes(q) || (e.manifest.description?.toLowerCase().includes(q) ?? false);
	}).map((e) => ({
		slug: e.slug,
		name: e.manifest.name,
		description: e.manifest.description,
		latestVersion: e.manifest.version,
		family: "claworks-pack"
	}));
}
function getPackageDetail(entries, slug) {
	const matches = entries.filter((e) => e.slug === slug);
	if (matches.length === 0) return null;
	const first = matches[0];
	return {
		slug,
		name: first.manifest.name,
		description: first.manifest.description,
		latestVersion: first.manifest.version,
		family: "claworks-pack",
		versions: [...new Set(matches.map((m) => m.manifest.version))]
	};
}
function resolvePackDir(entries, slug, version) {
	const matches = entries.filter((e) => e.slug === slug);
	if (matches.length === 0) return null;
	if (version) return matches.find((m) => m.manifest.version === version) ?? null;
	return matches.toSorted((a, b) => b.manifest.version.localeCompare(a.manifest.version))[0] ?? null;
}
function openPackArtifactStream(packDir) {
	return tar.c({
		gzip: true,
		cwd: packDir
	}, ["."]);
}
async function extractPackBuffer(buffer, destDir) {
	const tempDir = await mkdtemp(join(tmpdir(), "claworks-pack-"));
	const archive = join(tempDir, "pack.tgz");
	try {
		await writeFile(archive, buffer);
		await tar.x({
			file: archive,
			cwd: destDir,
			gzip: true
		});
	} finally {
		await rm(tempDir, {
			recursive: true,
			force: true
		});
	}
}
//#endregion
//#region src/pack-loader/nexus-client.ts
function parseNexusSource(source) {
	const raw = source.replace(/^nexus:\/\//, "").trim();
	if (!raw) return null;
	const [slug, version] = raw.split("@");
	if (!slug) return null;
	return {
		slug,
		version: version || void 0
	};
}
function normalizeRegistryUrl(registry) {
	return registry.replace(/\/$/, "");
}
async function fetchJson(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(6e4) });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Nexus request failed ${res.status}: ${text}`);
	}
	return await res.json();
}
async function listNexusPackages(registry, opts) {
	const base = normalizeRegistryUrl(registry);
	const url = new URL(`${base}/api/packages`);
	url.searchParams.set("family", "claworks-pack");
	if (opts?.q) url.searchParams.set("q", opts.q);
	return await fetchJson(url.toString());
}
async function getNexusPackage(registry, slug) {
	return await fetchJson(`${normalizeRegistryUrl(registry)}/api/packages/${encodeURIComponent(slug)}`);
}
async function downloadPackArtifact(registry, slug, version) {
	const url = `${normalizeRegistryUrl(registry)}/api/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/artifacts/generic`;
	const res = await fetch(url, { signal: AbortSignal.timeout(12e4) });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Nexus artifact download failed ${res.status}: ${text}`);
	}
	return Buffer.from(await res.arrayBuffer());
}
async function installPackFromNexus(params) {
	const spec = parseNexusSource(params.source);
	if (!spec) throw new Error(`Invalid nexus source: ${params.source}`);
	let version = spec.version;
	if (!version) {
		const detail = await getNexusPackage(params.registry, spec.slug);
		version = detail.latestVersion ?? detail.versions[0];
	}
	if (!version) throw new Error(`No version found for pack: ${spec.slug}`);
	const archive = await downloadPackArtifact(params.registry, spec.slug, version);
	const destDir = join(params.installRoot, spec.slug);
	await rm(destDir, {
		recursive: true,
		force: true
	});
	await mkdir(destDir, { recursive: true });
	await extractPackBuffer(archive, destDir);
	return {
		slug: spec.slug,
		version,
		path: destDir
	};
}
//#endregion
export { parseObjectTypeYaml as _, parseNexusSource as a, listPackages as c, scanNexusCatalog as d, createPackLoader as f, validatePackDependencies as g, resolvePackDir$1 as h, listNexusPackages as i, openPackArtifactStream as l, resolveInstalledPackIds as m, getNexusPackage as n, extractPackBuffer as o, readPackManifestFromDir as p, installPackFromNexus as r, getPackageDetail as s, downloadPackArtifact as t, resolvePackDir as u, parsePlaybookYaml as v, readPackManifest as y };
