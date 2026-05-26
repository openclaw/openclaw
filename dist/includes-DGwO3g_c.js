import { i as isPathInside } from "./path-BlG8lhgR.js";
import { i as openRootFileSync, t as canUseRootFileOpen } from "./root-file-jRMCpJW4.js";
import { x as isPlainObject } from "./utils-sBTEdeml.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import "./boundary-file-read-CBe_wA_B.js";
import "./scan-paths-BJFKmVji.js";
import fs from "node:fs";
import JSON5 from "json5";
import path from "node:path";
//#region src/config/includes.ts
/**
* Config includes: $include directive for modular configs
*
* @example
* ```json5
* {
*   "$include": "./base.json5",           // single file
*   "$include": ["./a.json5", "./b.json5"] // merge multiple
* }
* ```
*/
const INCLUDE_KEY = "$include";
var ConfigIncludeError = class extends Error {
	constructor(message, includePath, cause) {
		super(message);
		this.includePath = includePath;
		this.cause = cause;
		this.name = "ConfigIncludeError";
	}
};
var CircularIncludeError = class extends ConfigIncludeError {
	constructor(chain) {
		super(`Circular include detected: ${chain.join(" -> ")}`, chain[chain.length - 1]);
		this.chain = chain;
		this.name = "CircularIncludeError";
	}
};
/** Deep merge: arrays concatenate, objects merge recursively, primitives: source wins */
function deepMerge(target, source) {
	if (Array.isArray(target) && Array.isArray(source)) return [...target, ...source];
	if (isPlainObject(target) && isPlainObject(source)) {
		const result = { ...target };
		for (const key of Object.keys(source)) {
			if (isBlockedObjectKey(key)) continue;
			result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
		}
		return result;
	}
	return source;
}
var IncludeProcessor = class IncludeProcessor {
	constructor(basePath, resolver, rootDir, allowedRoots) {
		this.basePath = basePath;
		this.resolver = resolver;
		this.visited = /* @__PURE__ */ new Set();
		this.depth = 0;
		this.visited.add(path.normalize(basePath));
		const configRootDir = path.normalize(rootDir ?? path.dirname(basePath));
		this.configRoot = {
			rootDir: configRootDir,
			rootRealDir: path.normalize(safeRealpath(configRootDir))
		};
		this.allowedRoots = allowedRoots ?? [];
	}
	get rootDir() {
		return this.configRoot.rootDir;
	}
	process(obj) {
		if (Array.isArray(obj)) return obj.map((item) => this.process(item));
		if (!isPlainObject(obj)) return obj;
		if (!("$include" in obj)) return this.processObject(obj);
		return this.processInclude(obj);
	}
	processObject(obj) {
		const result = {};
		for (const [key, value] of Object.entries(obj)) result[key] = this.process(value);
		return result;
	}
	processInclude(obj) {
		const includeValue = obj[INCLUDE_KEY];
		const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
		const included = this.resolveInclude(includeValue);
		if (otherKeys.length === 0) return included;
		if (!isPlainObject(included)) throw new ConfigIncludeError("Sibling keys require included content to be an object", typeof includeValue === "string" ? includeValue : INCLUDE_KEY);
		const rest = {};
		for (const key of otherKeys) rest[key] = this.process(obj[key]);
		return deepMerge(included, rest);
	}
	resolveInclude(value) {
		if (typeof value === "string") return this.loadFile(value);
		if (Array.isArray(value)) return value.reduce((merged, item) => {
			if (typeof item !== "string") throw new ConfigIncludeError(`Invalid $include array item: expected string, got ${typeof item}`, String(item));
			return deepMerge(merged, this.loadFile(item));
		}, {});
		throw new ConfigIncludeError(`Invalid $include value: expected string or array of strings, got ${typeof value}`, String(value));
	}
	loadFile(includePath) {
		const { resolvedPath, root } = this.resolvePath(includePath);
		this.checkCircular(resolvedPath);
		this.checkDepth(includePath);
		const raw = this.readFile(includePath, resolvedPath, root);
		const parsed = this.parseFile(includePath, resolvedPath, raw);
		return this.processNested(resolvedPath, parsed);
	}
	resolvePath(includePath) {
		const configDir = path.dirname(this.basePath);
		const resolved = path.isAbsolute(includePath) ? includePath : path.resolve(configDir, includePath);
		const normalized = path.normalize(resolved);
		const lexicalMatch = this.findContainingRoot(normalized, "rootDir");
		if (!lexicalMatch) throw new ConfigIncludeError(`Include path escapes config directory: ${includePath} (root: ${this.rootDir})`, includePath);
		try {
			const real = fs.realpathSync(normalized);
			const realMatch = this.findContainingRoot(real, "rootRealDir");
			if (!realMatch) throw new ConfigIncludeError(`Include path resolves outside config directory (symlink): ${includePath} (root: ${this.rootDir})`, includePath);
			return {
				resolvedPath: normalized,
				root: realMatch
			};
		} catch (err) {
			if (err instanceof ConfigIncludeError) throw err;
			if (isNotFoundError(err)) return {
				resolvedPath: normalized,
				root: lexicalMatch
			};
			throw new ConfigIncludeError(`Failed to resolve include file realpath: ${includePath} (resolved: ${normalized})`, includePath, err instanceof Error ? err : void 0);
		}
	}
	findContainingRoot(candidate, field) {
		if (isPathInside(this.configRoot[field], candidate)) return this.configRoot;
		for (const root of this.allowedRoots) if (isPathInside(root[field], candidate)) return root;
		return null;
	}
	checkCircular(resolvedPath) {
		if (this.visited.has(resolvedPath)) throw new CircularIncludeError([...this.visited, resolvedPath]);
	}
	checkDepth(includePath) {
		if (this.depth >= 10) throw new ConfigIncludeError(`Maximum include depth (10) exceeded at: ${includePath}`, includePath);
	}
	readFile(includePath, resolvedPath, root) {
		try {
			if (this.resolver.readFileWithGuards) return this.resolver.readFileWithGuards({
				includePath,
				resolvedPath,
				rootRealDir: root.rootRealDir
			});
			return this.resolver.readFile(resolvedPath);
		} catch (err) {
			if (err instanceof ConfigIncludeError) throw err;
			throw new ConfigIncludeError(`Failed to read include file: ${includePath} (resolved: ${resolvedPath})`, includePath, err instanceof Error ? err : void 0);
		}
	}
	parseFile(includePath, resolvedPath, raw) {
		try {
			return this.resolver.parseJson(raw);
		} catch (err) {
			throw new ConfigIncludeError(`Failed to parse include file: ${includePath} (resolved: ${resolvedPath})`, includePath, err instanceof Error ? err : void 0);
		}
	}
	processNested(resolvedPath, parsed) {
		const nested = new IncludeProcessor(resolvedPath, this.resolver, this.rootDir, this.allowedRoots);
		nested.visited = new Set([...this.visited, resolvedPath]);
		nested.depth = this.depth + 1;
		return nested.process(parsed);
	}
};
function safeRealpath(target) {
	try {
		return fs.realpathSync(target);
	} catch {
		return target;
	}
}
function isNotFoundError(error) {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function readConfigIncludeFileWithGuards(params) {
	const ioFs = params.ioFs ?? fs;
	const maxBytes = params.maxBytes ?? 2097152;
	if (!canUseRootFileOpen(ioFs)) return ioFs.readFileSync(params.resolvedPath, "utf-8");
	const opened = openRootFileSync({
		absolutePath: params.resolvedPath,
		rootPath: params.rootRealDir,
		rootRealPath: params.rootRealDir,
		boundaryLabel: "config directory",
		skipLexicalRootCheck: true,
		maxBytes,
		ioFs
	});
	if (!opened.ok) {
		if (opened.reason === "validation") throw new ConfigIncludeError(`Include file failed security checks (regular file, max ${maxBytes} bytes, no hardlinks): ${params.includePath}`, params.includePath);
		throw new ConfigIncludeError(`Failed to read include file: ${params.includePath} (resolved: ${params.resolvedPath})`, params.includePath, opened.error instanceof Error ? opened.error : void 0);
	}
	try {
		return ioFs.readFileSync(opened.fd, "utf-8");
	} finally {
		ioFs.closeSync(opened.fd);
	}
}
const defaultResolver = {
	readFile: (p) => fs.readFileSync(p, "utf-8"),
	readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) => readConfigIncludeFileWithGuards({
		includePath,
		resolvedPath,
		rootRealDir
	}),
	parseJson: (raw) => JSON5.parse(raw)
};
/**
* Resolves all $include directives in a parsed config object.
*/
function resolveConfigIncludes(obj, configPath, resolver = defaultResolver, options = {}) {
	return new IncludeProcessor(configPath, resolver, void 0, (options.allowedRoots ?? []).filter((entry) => typeof entry === "string" && entry.length > 0 && path.isAbsolute(entry)).map((entry) => {
		const rootDir = path.normalize(entry);
		return {
			rootDir,
			rootRealDir: path.normalize(safeRealpath(rootDir))
		};
	})).process(obj);
}
//#endregion
export { resolveConfigIncludes as a, readConfigIncludeFileWithGuards as i, ConfigIncludeError as n, INCLUDE_KEY as r, CircularIncludeError as t };
