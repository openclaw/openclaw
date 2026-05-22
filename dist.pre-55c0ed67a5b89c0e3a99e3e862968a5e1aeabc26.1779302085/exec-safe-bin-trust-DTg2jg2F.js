import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as expandHomePrefix } from "./home-dir-BOPFpGo8.js";
import { S as unwrapKnownDispatchWrapperInvocation, b as resolveDispatchWrapperTrustPlan, c as isShellWrapperExecutable, d as unwrapKnownShellMultiplexerInvocation, r as extractBindableShellWrapperInlineCommand } from "./shell-wrapper-resolution-CehhL5X5.js";
import fs from "node:fs";
import path from "node:path";
//#region src/infra/exec-safe-bin-policy-profiles.ts
const NO_FLAGS$1 = /* @__PURE__ */ new Set();
const DEFAULT_SAFE_BINS = [
	"cut",
	"uniq",
	"head",
	"tail",
	"tr",
	"wc"
];
const toFlagSet = (flags) => {
	if (!flags || flags.length === 0) return NO_FLAGS$1;
	return new Set(flags);
};
function collectKnownLongFlags(allowedValueFlags, deniedFlags) {
	const known = /* @__PURE__ */ new Set();
	for (const flag of allowedValueFlags) if (flag.startsWith("--")) known.add(flag);
	for (const flag of deniedFlags) if (flag.startsWith("--")) known.add(flag);
	return Array.from(known);
}
function buildLongFlagPrefixMap(knownLongFlags) {
	const prefixMap = /* @__PURE__ */ new Map();
	for (const flag of knownLongFlags) {
		if (!flag.startsWith("--") || flag.length <= 2) continue;
		for (let length = 3; length <= flag.length; length += 1) {
			const prefix = flag.slice(0, length);
			const existing = prefixMap.get(prefix);
			if (existing === void 0) {
				prefixMap.set(prefix, flag);
				continue;
			}
			if (existing !== flag) prefixMap.set(prefix, null);
		}
	}
	return prefixMap;
}
function compileSafeBinProfile(fixture) {
	const allowedValueFlags = toFlagSet(fixture.allowedValueFlags);
	const deniedFlags = toFlagSet(fixture.deniedFlags);
	const knownLongFlags = collectKnownLongFlags(allowedValueFlags, deniedFlags);
	return {
		minPositional: fixture.minPositional,
		maxPositional: fixture.maxPositional,
		allowedValueFlags,
		deniedFlags,
		knownLongFlags,
		knownLongFlagsSet: new Set(knownLongFlags),
		longFlagPrefixMap: buildLongFlagPrefixMap(knownLongFlags)
	};
}
function compileSafeBinProfiles(fixtures) {
	return Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, compileSafeBinProfile(fixture)]));
}
const SAFE_BIN_PROFILES = compileSafeBinProfiles({
	jq: {
		maxPositional: 1,
		allowedValueFlags: [
			"--arg",
			"--argjson",
			"--argstr"
		],
		deniedFlags: [
			"--argfile",
			"--rawfile",
			"--slurpfile",
			"--from-file",
			"--library-path",
			"-L",
			"-f"
		]
	},
	grep: {
		maxPositional: 0,
		allowedValueFlags: [
			"--regexp",
			"--max-count",
			"--after-context",
			"--before-context",
			"--context",
			"--devices",
			"--binary-files",
			"--exclude",
			"--include",
			"--label",
			"-e",
			"-m",
			"-A",
			"-B",
			"-C",
			"-D"
		],
		deniedFlags: [
			"--file",
			"--exclude-from",
			"--dereference-recursive",
			"--directories",
			"--recursive",
			"-f",
			"-d",
			"-r",
			"-R"
		]
	},
	cut: {
		maxPositional: 0,
		allowedValueFlags: [
			"--bytes",
			"--characters",
			"--fields",
			"--delimiter",
			"--output-delimiter",
			"-b",
			"-c",
			"-f",
			"-d"
		]
	},
	sort: {
		maxPositional: 0,
		allowedValueFlags: [
			"--key",
			"--field-separator",
			"--buffer-size",
			"--parallel",
			"--batch-size",
			"-k",
			"-t",
			"-S"
		],
		deniedFlags: [
			"--compress-program",
			"--files0-from",
			"--output",
			"--random-source",
			"--temporary-directory",
			"-T",
			"-o"
		]
	},
	uniq: {
		maxPositional: 0,
		allowedValueFlags: [
			"--skip-fields",
			"--skip-chars",
			"--check-chars",
			"--group",
			"-f",
			"-s",
			"-w"
		]
	},
	head: {
		maxPositional: 0,
		allowedValueFlags: [
			"--lines",
			"--bytes",
			"-n",
			"-c"
		]
	},
	tail: {
		maxPositional: 0,
		allowedValueFlags: [
			"--lines",
			"--bytes",
			"--sleep-interval",
			"--max-unchanged-stats",
			"--pid",
			"-n",
			"-c"
		]
	},
	tr: {
		minPositional: 1,
		maxPositional: 2
	},
	wc: {
		maxPositional: 0,
		deniedFlags: ["--files0-from"]
	}
});
function normalizeSafeBinProfileName(raw) {
	const name = normalizeLowercaseStringOrEmpty(raw);
	return name.length > 0 ? name : null;
}
function normalizeFixtureLimit(raw) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return;
	const next = Math.trunc(raw);
	return next >= 0 ? next : void 0;
}
function normalizeFixtureFlags(flags) {
	if (!Array.isArray(flags) || flags.length === 0) return;
	const normalized = Array.from(new Set(flags.map((flag) => flag.trim()).filter((flag) => flag.length > 0))).toSorted((a, b) => a.localeCompare(b));
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeSafeBinProfileFixture(fixture) {
	const minPositional = normalizeFixtureLimit(fixture.minPositional);
	const maxPositionalRaw = normalizeFixtureLimit(fixture.maxPositional);
	return {
		minPositional,
		maxPositional: minPositional !== void 0 && maxPositionalRaw !== void 0 && maxPositionalRaw < minPositional ? minPositional : maxPositionalRaw,
		allowedValueFlags: normalizeFixtureFlags(fixture.allowedValueFlags),
		deniedFlags: normalizeFixtureFlags(fixture.deniedFlags)
	};
}
function normalizeSafeBinProfileFixtures(fixtures) {
	const normalized = {};
	if (!fixtures) return normalized;
	for (const [rawName, fixture] of Object.entries(fixtures)) {
		const name = normalizeSafeBinProfileName(rawName);
		if (!name) continue;
		normalized[name] = normalizeSafeBinProfileFixture(fixture);
	}
	return normalized;
}
function resolveSafeBinProfiles(fixtures) {
	const normalizedFixtures = normalizeSafeBinProfileFixtures(fixtures);
	if (Object.keys(normalizedFixtures).length === 0) return SAFE_BIN_PROFILES;
	return {
		...SAFE_BIN_PROFILES,
		...compileSafeBinProfiles(normalizedFixtures)
	};
}
//#endregion
//#region src/infra/exec-allowlist-pattern.ts
const GLOB_REGEX_CACHE_LIMIT = 512;
const globRegexCache = /* @__PURE__ */ new Map();
function normalizeMatchTarget(value) {
	if (process.platform === "win32") return normalizeLowercaseStringOrEmpty(value.replace(/^\\\\[?.]\\/, "").replace(/\\/g, "/"));
	return value.replace(/\\\\/g, "/");
}
function tryRealpath(value) {
	try {
		return fs.realpathSync(value);
	} catch {
		return null;
	}
}
function hasDotPathSegment(value) {
	return value.replace(/\\/g, "/").split("/").some((segment) => segment === "." || segment === "..");
}
function normalizeDotPathSegments(value) {
	return normalizeMatchTarget(process.platform === "win32" ? path.win32.normalize(value) : path.posix.normalize(value));
}
function escapeRegExpLiteral(input) {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function compileGlobRegex(pattern) {
	const cacheKey = `${process.platform}:${pattern}`;
	const cached = globRegexCache.get(cacheKey);
	if (cached) return cached;
	let regex = "^";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				regex += ".*";
				i += 2;
				continue;
			}
			regex += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			regex += "[^/]";
			i += 1;
			continue;
		}
		regex += escapeRegExpLiteral(ch);
		i += 1;
	}
	regex += "$";
	const compiled = new RegExp(regex, process.platform === "win32" ? "i" : "");
	if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) globRegexCache.clear();
	globRegexCache.set(cacheKey, compiled);
	return compiled;
}
function matchesExecAllowlistPattern(pattern, target) {
	const trimmed = pattern.trim();
	if (!trimmed) return false;
	const expanded = trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed;
	const hasWildcard = /[*?]/.test(expanded);
	let normalizedPattern = expanded;
	let normalizedTarget = target;
	if (process.platform === "win32" && !hasWildcard) {
		normalizedPattern = tryRealpath(expanded) ?? expanded;
		normalizedTarget = tryRealpath(target) ?? target;
	}
	normalizedPattern = normalizeMatchTarget(normalizedPattern);
	normalizedTarget = normalizeMatchTarget(normalizedTarget);
	if (hasWildcard && hasDotPathSegment(normalizedTarget)) normalizedTarget = normalizeDotPathSegments(normalizedTarget);
	return compileGlobRegex(normalizedPattern).test(normalizedTarget);
}
//#endregion
//#region src/infra/exec-wrapper-trust-plan.ts
function blockedExecWrapperTrustPlan(params) {
	return {
		argv: params.argv,
		policyArgv: params.policyArgv ?? params.argv,
		wrapperChain: params.wrapperChain,
		policyBlocked: true,
		blockedWrapper: params.blockedWrapper,
		shellWrapperExecutable: false,
		shellInlineCommand: null
	};
}
function finalizeExecWrapperTrustPlan(argv, policyArgv, wrapperChain, policyBlocked, blockedWrapper) {
	const rawExecutable = argv[0]?.trim() ?? "";
	const shellWrapperExecutable = !policyBlocked && rawExecutable.length > 0 && isShellWrapperExecutable(rawExecutable);
	const plan = {
		argv,
		policyArgv,
		wrapperChain,
		policyBlocked,
		shellWrapperExecutable,
		shellInlineCommand: shellWrapperExecutable ? extractBindableShellWrapperInlineCommand(argv) : null
	};
	if (blockedWrapper !== void 0) plan.blockedWrapper = blockedWrapper;
	return plan;
}
function resolveExecWrapperTrustPlan(argv, maxDepth = 4) {
	let current = argv;
	let policyArgv = argv;
	let sawShellMultiplexer = false;
	const wrapperChain = [];
	for (let depth = 0; depth < maxDepth; depth += 1) {
		const dispatchPlan = resolveDispatchWrapperTrustPlan(current, maxDepth - wrapperChain.length);
		if (dispatchPlan.policyBlocked) return blockedExecWrapperTrustPlan({
			argv: dispatchPlan.argv,
			policyArgv: dispatchPlan.argv,
			wrapperChain,
			blockedWrapper: dispatchPlan.blockedWrapper ?? current[0] ?? "unknown"
		});
		if (dispatchPlan.wrappers.length > 0) {
			wrapperChain.push(...dispatchPlan.wrappers);
			current = dispatchPlan.argv;
			if (!sawShellMultiplexer) policyArgv = current;
			if (wrapperChain.length >= maxDepth) break;
			continue;
		}
		const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(current);
		if (shellMultiplexerUnwrap.kind === "blocked") return blockedExecWrapperTrustPlan({
			argv: current,
			policyArgv,
			wrapperChain,
			blockedWrapper: shellMultiplexerUnwrap.wrapper
		});
		if (shellMultiplexerUnwrap.kind === "unwrapped") {
			wrapperChain.push(shellMultiplexerUnwrap.wrapper);
			if (!sawShellMultiplexer) {
				policyArgv = current;
				sawShellMultiplexer = true;
			}
			current = shellMultiplexerUnwrap.argv;
			if (wrapperChain.length >= maxDepth) break;
			continue;
		}
		break;
	}
	if (wrapperChain.length >= maxDepth) {
		const dispatchOverflow = unwrapKnownDispatchWrapperInvocation(current);
		if (dispatchOverflow.kind === "blocked" || dispatchOverflow.kind === "unwrapped") return blockedExecWrapperTrustPlan({
			argv: current,
			policyArgv,
			wrapperChain,
			blockedWrapper: dispatchOverflow.wrapper
		});
		const shellMultiplexerOverflow = unwrapKnownShellMultiplexerInvocation(current);
		if (shellMultiplexerOverflow.kind === "blocked" || shellMultiplexerOverflow.kind === "unwrapped") return blockedExecWrapperTrustPlan({
			argv: current,
			policyArgv,
			wrapperChain,
			blockedWrapper: shellMultiplexerOverflow.wrapper
		});
	}
	return finalizeExecWrapperTrustPlan(current, policyArgv, wrapperChain, false);
}
//#endregion
//#region src/infra/executable-path.ts
function isDriveLessWindowsRootedPath(value) {
	return process.platform === "win32" && /^:[\\/]/.test(value);
}
function resolveExecutablePathCandidate(rawExecutable, options) {
	const expanded = rawExecutable.startsWith("~") ? expandHomePrefix(rawExecutable, { env: options?.env }) : rawExecutable;
	if (isDriveLessWindowsRootedPath(expanded)) return;
	const hasPathSeparator = expanded.includes("/") || expanded.includes("\\");
	if (options?.requirePathSeparator && !hasPathSeparator) return;
	if (!hasPathSeparator) return expanded;
	if (path.isAbsolute(expanded)) return path.resolve(expanded);
	const base = options?.cwd && options.cwd.trim() ? options.cwd.trim() : process.cwd();
	return path.resolve(base, expanded);
}
function resolveWindowsExecutableExtensions(executable, env) {
	if (process.platform !== "win32") return [""];
	if (path.extname(executable).length > 0) return [""];
	return ["", ...(env?.PATHEXT ?? env?.Pathext ?? process.env.PATHEXT ?? process.env.Pathext ?? ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => normalizeLowercaseStringOrEmpty(ext))];
}
function resolveWindowsExecutableExtSet(env) {
	return new Set((env?.PATHEXT ?? env?.Pathext ?? process.env.PATHEXT ?? process.env.Pathext ?? ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => normalizeLowercaseStringOrEmpty(ext)).filter(Boolean));
}
function isExecutableFile(filePath) {
	try {
		if (!fs.statSync(filePath).isFile()) return false;
		if (process.platform === "win32") {
			const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
			if (!ext) return true;
			return resolveWindowsExecutableExtSet(void 0).has(ext);
		}
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function resolveExecutableFromPathEnv(executable, pathEnv, env) {
	const delimiter = process.platform === "win32" ? ";" : path.delimiter;
	const entries = pathEnv.split(delimiter).filter(Boolean);
	const extensions = resolveWindowsExecutableExtensions(executable, env);
	for (const entry of entries) for (const ext of extensions) {
		const candidate = path.join(entry, executable + ext);
		if (isExecutableFile(candidate)) return candidate;
	}
}
function resolveExecutablePath(rawExecutable, options) {
	const candidate = resolveExecutablePathCandidate(rawExecutable, options);
	if (!candidate) return;
	if (candidate.includes("/") || candidate.includes("\\")) return isExecutableFile(candidate) ? candidate : void 0;
	return resolveExecutableFromPathEnv(candidate, options?.env?.PATH ?? options?.env?.Path ?? process.env.PATH ?? process.env.Path ?? "", options?.env);
}
const KNOWN_PATHEXT = new Set([
	".com",
	".exe",
	".bat",
	".cmd"
]);
/**
* On Windows, resolves a bare command name to its full .cmd or .exe path by
* probing PATH/PATHEXT without executing another resolver. On non-Windows this
* is a no-op.
*/
function resolveExecutable(cmd) {
	if (process.platform !== "win32") return cmd;
	if (KNOWN_PATHEXT.has(normalizeLowercaseStringOrEmpty(path.extname(cmd)))) return cmd;
	const entries = (process.env.PATH ?? process.env.Path ?? "").split(";").filter(Boolean);
	const extensions = resolveWindowsExecutableExtensions(cmd, process.env);
	const matches = [];
	for (const entry of entries) for (const ext of extensions) {
		const candidate = path.join(entry, cmd + ext);
		if (isExecutableFile(candidate)) matches.push(candidate);
	}
	const cmdMatch = matches.find((match) => normalizeLowercaseStringOrEmpty(path.extname(match)) === ".cmd");
	if (cmdMatch) return cmdMatch;
	const exeMatch = matches.find((match) => normalizeLowercaseStringOrEmpty(path.extname(match)) === ".exe");
	if (exeMatch) return exeMatch;
	if (matches[0]) return matches[0];
	return cmd;
}
//#endregion
//#region src/infra/exec-command-resolution.ts
function isCommandResolution(resolution) {
	return Boolean(resolution && "execution" in resolution && "policy" in resolution);
}
function parseFirstToken(command) {
	const trimmed = command.trim();
	if (!trimmed) return null;
	const first = trimmed[0];
	if (first === "\"" || first === "'") {
		const end = trimmed.indexOf(first, 1);
		if (end > 1) return trimmed.slice(1, end);
		return trimmed.slice(1);
	}
	const match = /^[^\s]+/.exec(trimmed);
	return match ? match[0] : null;
}
function tryResolveRealpath(filePath) {
	if (!filePath) return;
	try {
		return fs.realpathSync(filePath);
	} catch {
		return;
	}
}
function buildExecutableResolution(rawExecutable, params) {
	const resolvedPath = resolveExecutablePath(rawExecutable, {
		cwd: params.cwd,
		env: params.env
	});
	return {
		rawExecutable,
		resolvedPath,
		resolvedRealPath: tryResolveRealpath(resolvedPath),
		executableName: resolvedPath ? path.basename(resolvedPath) : rawExecutable
	};
}
function buildCommandResolution(params) {
	const execution = buildExecutableResolution(params.rawExecutable, params);
	const policy = params.policyRawExecutable ? buildExecutableResolution(params.policyRawExecutable, params) : execution;
	const resolution = {
		execution,
		policy,
		effectiveArgv: params.effectiveArgv,
		wrapperChain: params.wrapperChain,
		policyBlocked: params.policyBlocked,
		blockedWrapper: params.blockedWrapper
	};
	return Object.defineProperties(resolution, {
		rawExecutable: { get: () => execution.rawExecutable },
		resolvedPath: { get: () => execution.resolvedPath },
		resolvedRealPath: { get: () => execution.resolvedRealPath },
		executableName: { get: () => execution.executableName },
		policyResolution: { get: () => policy === execution ? void 0 : policy }
	});
}
function resolveCommandResolution(command, cwd, env) {
	const rawExecutable = parseFirstToken(command);
	if (!rawExecutable) return null;
	return buildCommandResolution({
		rawExecutable,
		effectiveArgv: [rawExecutable],
		wrapperChain: [],
		policyBlocked: false,
		cwd,
		env
	});
}
function resolveCommandResolutionFromArgv(argv, cwd, env) {
	const plan = resolveExecWrapperTrustPlan(argv);
	const effectiveArgv = plan.argv;
	const rawExecutable = effectiveArgv[0]?.trim();
	if (!rawExecutable) return null;
	return buildCommandResolution({
		rawExecutable,
		policyRawExecutable: plan.policyArgv[0]?.trim(),
		effectiveArgv,
		wrapperChain: plan.wrapperChain,
		policyBlocked: plan.policyBlocked,
		blockedWrapper: plan.blockedWrapper,
		cwd,
		env
	});
}
function resolveExecutableCandidatePathFromResolution(resolution, cwd) {
	if (!resolution) return;
	if (resolution.resolvedPath) return resolution.resolvedPath;
	const raw = resolution.rawExecutable?.trim();
	if (!raw) return;
	return resolveExecutablePathCandidate(raw, {
		cwd,
		requirePathSeparator: true
	});
}
function resolveExecutableTrustPath(resolution, cwd) {
	const realPath = resolution?.resolvedRealPath?.trim();
	if (realPath) return realPath;
	const candidatePath = resolveExecutableCandidatePathFromResolution(resolution, cwd);
	return tryResolveRealpath(candidatePath) ?? candidatePath;
}
function resolveExecutionTargetResolution(resolution) {
	if (!resolution) return null;
	return isCommandResolution(resolution) ? resolution.execution : resolution;
}
function resolvePolicyTargetResolution(resolution) {
	if (!resolution) return null;
	return isCommandResolution(resolution) ? resolution.policy : resolution;
}
function resolveExecutionTargetCandidatePath(resolution, cwd) {
	return resolveExecutableCandidatePathFromResolution(isCommandResolution(resolution) ? resolution.execution : resolution, cwd);
}
function resolveExecutionTargetTrustPath(resolution, cwd) {
	return resolveExecutableTrustPath(isCommandResolution(resolution) ? resolution.execution : resolution, cwd);
}
function resolvePolicyTargetCandidatePath(resolution, cwd) {
	return resolveExecutableCandidatePathFromResolution(isCommandResolution(resolution) ? resolution.policy : resolution, cwd);
}
function resolvePolicyTargetTrustPath(resolution, cwd) {
	return resolveExecutableTrustPath(isCommandResolution(resolution) ? resolution.policy : resolution, cwd);
}
function resolveApprovalAuditCandidatePath(resolution, cwd) {
	return resolvePolicyTargetCandidatePath(resolution, cwd);
}
function resolveApprovalAuditTrustPath(resolution, cwd) {
	return resolvePolicyTargetTrustPath(resolution, cwd);
}
/** @deprecated Use resolveExecutionTargetCandidatePath. */
function resolveAllowlistCandidatePath(resolution, cwd) {
	return resolveExecutionTargetCandidatePath(resolution, cwd);
}
function resolvePolicyAllowlistCandidatePath(resolution, cwd) {
	return resolvePolicyTargetCandidatePath(resolution, cwd);
}
const TRAILING_SHELL_REDIRECTIONS_RE = /\s+(?:[12]>&[12]|[12]>\/dev\/null)\s*$/;
function stripTrailingRedirections(value) {
	let prev = value;
	while (true) {
		const next = prev.replace(TRAILING_SHELL_REDIRECTIONS_RE, "");
		if (next === prev) return next;
		prev = next;
	}
}
function matchArgPattern(argPattern, argv, platform) {
	const sep = argPattern.includes("\0") ? "\0" : " ";
	const argsSlice = argv.slice(1);
	const argsString = sep === "\0" ? argsSlice.length === 0 ? "\0\0" : argsSlice.join(sep) + sep : argsSlice.join(sep);
	try {
		const regex = new RegExp(argPattern);
		if (regex.test(argsString)) return true;
		if (normalizeLowercaseStringOrEmpty(platform ?? process.platform).startsWith("win")) {
			const normalized = argsString.replace(/\//g, "\\");
			if (normalized !== argsString && regex.test(normalized)) return true;
		}
		if (sep === " ") {
			const stripped = stripTrailingRedirections(argsString);
			if (stripped !== argsString && regex.test(stripped)) return true;
		}
		return false;
	} catch {
		return false;
	}
}
function hasPathSelector$1(value) {
	return value.includes("/") || value.includes("\\") || value.includes("~");
}
function matchesExecutableBasenamePattern(pattern, resolution) {
	if (hasPathSelector$1(resolution.rawExecutable)) return false;
	const candidates = /* @__PURE__ */ new Set();
	if (resolution.executableName) candidates.add(resolution.executableName);
	if (resolution.resolvedPath) candidates.add(path.basename(resolution.resolvedPath));
	return [...candidates].some((candidate) => matchesExecAllowlistPattern(pattern, candidate));
}
function matchAllowlist(entries, resolution, argv, platform) {
	if (!entries.length) return null;
	const bareWild = entries.find((e) => e.pattern?.trim() === "*" && !e.argPattern);
	if (bareWild && resolution) return bareWild;
	if (!resolution?.resolvedPath) return null;
	const trustPath = resolution.resolvedRealPath?.trim() || resolution.resolvedPath;
	if (!trustPath) return null;
	let pathOnlyMatch = null;
	for (const entry of entries) {
		const pattern = entry.pattern?.trim();
		if (!pattern) continue;
		if (!(hasPathSelector$1(pattern) ? matchesExecAllowlistPattern(pattern, trustPath) : pattern !== "*" && matchesExecutableBasenamePattern(pattern, resolution))) continue;
		if (!entry.argPattern) {
			if (!pathOnlyMatch) pathOnlyMatch = entry;
			continue;
		}
		if (argv && matchArgPattern(entry.argPattern, argv, platform)) return entry;
	}
	return pathOnlyMatch;
}
/**
* Tokenizes a single argv entry into a normalized option/positional model.
* Consumers can share this model to keep argv parsing behavior consistent.
*/
function parseExecArgvToken(raw) {
	if (!raw) return {
		kind: "empty",
		raw
	};
	if (raw === "--") return {
		kind: "terminator",
		raw
	};
	if (raw === "-") return {
		kind: "stdin",
		raw
	};
	if (!raw.startsWith("-")) return {
		kind: "positional",
		raw
	};
	if (raw.startsWith("--")) {
		const eqIndex = raw.indexOf("=");
		if (eqIndex > 0) return {
			kind: "option",
			raw,
			style: "long",
			flag: raw.slice(0, eqIndex),
			inlineValue: raw.slice(eqIndex + 1)
		};
		return {
			kind: "option",
			raw,
			style: "long",
			flag: raw
		};
	}
	const cluster = raw.slice(1);
	return {
		kind: "option",
		raw,
		style: "short-cluster",
		cluster,
		flags: cluster.split("").map((entry) => `-${entry}`)
	};
}
//#endregion
//#region src/infra/exec-safe-bin-semantics.ts
const JQ_ENV_FILTER_PATTERN = /(^|[^.$A-Za-z0-9_])env([^A-Za-z0-9_]|$)/;
const JQ_ENV_VARIABLE_PATTERN = /\$ENV\b/;
const ALWAYS_DENY_SAFE_BIN_SEMANTICS = () => false;
const UNSAFE_SAFE_BIN_WARNINGS = {
	awk: "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
	jq: "jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
	sed: "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins."
};
const SAFE_BIN_SEMANTIC_RULES = {
	jq: {
		validate: ({ positional }) => !positional.some((token) => JQ_ENV_FILTER_PATTERN.test(token) || JQ_ENV_VARIABLE_PATTERN.test(token)),
		configWarning: UNSAFE_SAFE_BIN_WARNINGS.jq
	},
	awk: {
		validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
		configWarning: UNSAFE_SAFE_BIN_WARNINGS.awk
	},
	gawk: {
		validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
		configWarning: UNSAFE_SAFE_BIN_WARNINGS.awk
	},
	mawk: {
		validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
		configWarning: UNSAFE_SAFE_BIN_WARNINGS.awk
	},
	nawk: {
		validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
		configWarning: UNSAFE_SAFE_BIN_WARNINGS.awk
	},
	sed: {
		validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
		configWarning: UNSAFE_SAFE_BIN_WARNINGS.sed
	},
	gsed: {
		validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
		configWarning: UNSAFE_SAFE_BIN_WARNINGS.sed
	}
};
function normalizeSafeBinName(raw) {
	const trimmed = normalizeLowercaseStringOrEmpty(raw);
	if (!trimmed) return "";
	return (trimmed.split(/[\\/]/).at(-1) ?? trimmed).replace(/\.(?:exe|cmd|bat|com)$/i, "");
}
function getSafeBinSemanticRule(binName) {
	const normalized = typeof binName === "string" ? normalizeSafeBinName(binName) : "";
	return normalized ? SAFE_BIN_SEMANTIC_RULES[normalized] : void 0;
}
function validateSafeBinSemantics(params) {
	return getSafeBinSemanticRule(params.binName)?.validate?.(params) ?? true;
}
function listRiskyConfiguredSafeBins(entries) {
	const hits = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const normalized = normalizeSafeBinName(entry);
		if (!normalized || hits.has(normalized)) continue;
		const warning = getSafeBinSemanticRule(normalized)?.configWarning;
		if (!warning) continue;
		hits.set(normalized, warning);
	}
	return Array.from(hits.entries()).map(([bin, warning]) => ({
		bin,
		warning
	})).toSorted((a, b) => a.bin.localeCompare(b.bin));
}
//#endregion
//#region src/infra/exec-safe-bin-policy-validator.ts
function isPathLikeToken(value) {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed === "-") return false;
	if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) return true;
	if (trimmed.startsWith("/")) return true;
	return /^[A-Za-z]:[\\/]/.test(trimmed);
}
function hasGlobToken(value) {
	return /[*?[\]]/.test(value);
}
function hasShellExpansionToken(value) {
	return /\$(?:[A-Za-z0-9_@*?!$#-]|\{|\(|\[)/.test(value);
}
const NO_FLAGS = /* @__PURE__ */ new Set();
function isSafeLiteralToken(value) {
	if (!value || value === "-") return true;
	return !hasGlobToken(value) && !hasShellExpansionToken(value) && !isPathLikeToken(value);
}
function isInvalidValueToken(value) {
	return !value || !isSafeLiteralToken(value);
}
function resolveCanonicalLongFlag(params) {
	if (!params.flag.startsWith("--") || params.flag.length <= 2) return null;
	if (params.knownLongFlagsSet.has(params.flag)) return params.flag;
	return params.longFlagPrefixMap.get(params.flag) ?? null;
}
function consumeLongOptionToken(params) {
	const canonicalFlag = resolveCanonicalLongFlag({
		flag: params.flag,
		knownLongFlagsSet: params.knownLongFlagsSet,
		longFlagPrefixMap: params.longFlagPrefixMap
	});
	if (!canonicalFlag) return -1;
	if (params.deniedFlags.has(canonicalFlag)) return -1;
	const expectsValue = params.allowedValueFlags.has(canonicalFlag);
	if (params.inlineValue !== void 0) {
		if (!expectsValue) return -1;
		return isSafeLiteralToken(params.inlineValue) ? params.index + 1 : -1;
	}
	if (!expectsValue) return params.index + 1;
	return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
}
function consumeShortOptionClusterToken(params) {
	for (let j = 0; j < params.flags.length; j += 1) {
		const flag = params.flags[j];
		if (params.deniedFlags.has(flag)) return -1;
		if (!params.allowedValueFlags.has(flag)) continue;
		const inlineValue = params.cluster.slice(j + 1);
		if (inlineValue) return isSafeLiteralToken(inlineValue) ? params.index + 1 : -1;
		return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
	}
	return -1;
}
function consumePositionalToken(token, positional) {
	if (!isSafeLiteralToken(token)) return false;
	positional.push(token);
	return true;
}
function validatePositionalCount(positional, profile) {
	const minPositional = profile.minPositional ?? 0;
	if (positional.length < minPositional) return false;
	if (typeof profile.maxPositional === "number" && positional.length > profile.maxPositional) return false;
	return true;
}
function collectPositionalTokens(args, profile) {
	const allowedValueFlags = profile.allowedValueFlags ?? NO_FLAGS;
	const deniedFlags = profile.deniedFlags ?? NO_FLAGS;
	const knownLongFlags = profile.knownLongFlags ?? collectKnownLongFlags(allowedValueFlags, deniedFlags);
	const knownLongFlagsSet = profile.knownLongFlagsSet ?? new Set(knownLongFlags);
	const longFlagPrefixMap = profile.longFlagPrefixMap ?? buildLongFlagPrefixMap(knownLongFlags);
	const positional = [];
	let i = 0;
	while (i < args.length) {
		const token = parseExecArgvToken(args[i] ?? "");
		if (token.kind === "empty" || token.kind === "stdin") {
			i += 1;
			continue;
		}
		if (token.kind === "terminator") {
			for (let j = i + 1; j < args.length; j += 1) {
				const rest = args[j];
				if (!rest || rest === "-") continue;
				if (!consumePositionalToken(rest, positional)) return null;
			}
			break;
		}
		if (token.kind === "positional") {
			if (!consumePositionalToken(token.raw, positional)) return null;
			i += 1;
			continue;
		}
		if (token.style === "long") {
			const nextIndex = consumeLongOptionToken({
				args,
				index: i,
				flag: token.flag,
				inlineValue: token.inlineValue,
				allowedValueFlags,
				deniedFlags,
				knownLongFlagsSet,
				longFlagPrefixMap
			});
			if (nextIndex < 0) return null;
			i = nextIndex;
			continue;
		}
		const nextIndex = consumeShortOptionClusterToken({
			args,
			index: i,
			cluster: token.cluster,
			flags: token.flags,
			allowedValueFlags,
			deniedFlags
		});
		if (nextIndex < 0) return null;
		i = nextIndex;
	}
	return positional;
}
function validateSafeBinArgv(args, profile, options) {
	const positional = collectPositionalTokens(args, profile);
	if (!positional) return false;
	if (!validatePositionalCount(positional, profile)) return false;
	return validateSafeBinSemantics({
		binName: options?.binName,
		positional
	});
}
//#endregion
//#region src/infra/exec-safe-bin-trust.ts
const DEFAULT_SAFE_BIN_TRUSTED_DIRS = ["/bin", "/usr/bin"];
let trustedSafeBinCache = null;
function swapAsciiCase(value) {
	return value.replace(/[A-Za-z]/g, (char) => {
		const lower = char.toLowerCase();
		return char === lower ? char.toUpperCase() : lower;
	});
}
function sameFsObject(a, b) {
	return a.dev === b.dev && a.ino === b.ino;
}
function pathCaseInsensitive(value) {
	let candidate = value;
	for (;;) {
		const swapped = swapAsciiCase(candidate);
		if (swapped !== candidate) try {
			const original = fs.statSync(candidate);
			try {
				return sameFsObject(original, fs.statSync(swapped));
			} catch {
				return false;
			}
		} catch {}
		const parent = path.dirname(candidate);
		if (parent === candidate) return process.platform === "win32";
		candidate = parent;
	}
}
function normalizeTrustComparisonPath(value) {
	const resolved = path.resolve(value);
	return pathCaseInsensitive(resolved) ? resolved.toLowerCase() : resolved;
}
function normalizeTrustedDir(value, forComparison = true) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return forComparison ? normalizeTrustComparisonPath(trimmed) : path.resolve(trimmed);
}
function normalizeTrustedSafeBinDirs(entries) {
	if (!Array.isArray(entries)) return [];
	const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	return Array.from(new Set(normalized));
}
function resolveTrustedSafeBinDirs(entries, forComparison = true) {
	const resolved = entries.map((entry) => normalizeTrustedDir(entry, forComparison)).filter((entry) => Boolean(entry));
	return Array.from(new Set(resolved)).toSorted();
}
function hasPathSelector(value) {
	return value.includes("/") || value.includes("\\");
}
function isExecutableSafeBinFile(value) {
	try {
		if (!fs.statSync(value).isFile()) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(value, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function resolveTrustedSafeBinTargetDirs(entries, safeBins, forComparison = true) {
	const dirs = [];
	const bins = Array.from(new Set(safeBins.map((entry) => entry.trim()).filter((entry) => entry && !hasPathSelector(entry)))).toSorted();
	if (bins.length === 0) return dirs;
	for (const entry of normalizeTrustedSafeBinDirs(entries)) {
		const dir = path.resolve(entry);
		for (const bin of bins) {
			const candidate = path.join(dir, bin);
			if (!isExecutableSafeBinFile(candidate)) continue;
			try {
				const normalized = normalizeTrustedDir(path.dirname(fs.realpathSync(candidate)), forComparison);
				if (normalized) dirs.push(normalized);
			} catch {}
		}
	}
	return Array.from(new Set(dirs)).toSorted();
}
function buildTrustedSafeBinCacheKey(entries, safeBins, targetDirs) {
	return `${resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries)).join("")}\u0002${Array.from(new Set(safeBins.map((entry) => entry.trim()).filter(Boolean))).toSorted().join("")}\u0002${targetDirs.join("")}`;
}
function getTrustedSafeBinDirs(params = {}) {
	const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
	const extraDirs = params.extraDirs ?? [];
	const safeBins = params.safeBins ?? [];
	const entries = [...normalizeTrustedSafeBinDirs(baseDirs), ...normalizeTrustedSafeBinDirs(extraDirs)];
	const targetDirs = resolveTrustedSafeBinTargetDirs(entries, safeBins);
	const key = buildTrustedSafeBinCacheKey(entries, safeBins, targetDirs);
	if (!params.refresh && trustedSafeBinCache?.key === key) return trustedSafeBinCache.dirs;
	const dirs = new Set([...resolveTrustedSafeBinDirs(entries), ...targetDirs]);
	trustedSafeBinCache = {
		key,
		dirs
	};
	return dirs;
}
function isTrustedSafeBinPath(params) {
	const trustedDirs = params.trustedDirs ?? getTrustedSafeBinDirs();
	const resolvedDir = normalizeTrustComparisonPath(path.dirname(path.resolve(params.resolvedPath)));
	return trustedDirs.has(resolvedDir);
}
function listWritableExplicitTrustedSafeBinDirs(entries) {
	if (process.platform === "win32") return [];
	const resolved = resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries), false);
	const hits = [];
	for (const dir of resolved) {
		let stat;
		try {
			stat = fs.statSync(dir);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		const mode = stat.mode & 511;
		const groupWritable = (mode & 16) !== 0;
		const worldWritable = (mode & 2) !== 0;
		if (!groupWritable && !worldWritable) continue;
		hits.push({
			dir,
			groupWritable,
			worldWritable
		});
	}
	return hits;
}
//#endregion
export { resolveSafeBinProfiles as A, resolveExecutable as C, DEFAULT_SAFE_BINS as D, resolveExecWrapperTrustPlan as E, SAFE_BIN_PROFILES as O, resolvePolicyTargetTrustPath as S, resolveExecutablePath as T, resolveExecutionTargetResolution as _, validateSafeBinArgv as a, resolvePolicyTargetCandidatePath as b, matchAllowlist as c, resolveApprovalAuditCandidatePath as d, resolveApprovalAuditTrustPath as f, resolveExecutionTargetCandidatePath as g, resolveExecutableTrustPath as h, normalizeTrustedSafeBinDirs as i, normalizeSafeBinProfileFixtures as k, parseExecArgvToken as l, resolveCommandResolutionFromArgv as m, isTrustedSafeBinPath as n, listRiskyConfiguredSafeBins as o, resolveCommandResolution as p, listWritableExplicitTrustedSafeBinDirs as r, normalizeSafeBinName as s, getTrustedSafeBinDirs as t, resolveAllowlistCandidatePath as u, resolveExecutionTargetTrustPath as v, resolveExecutableFromPathEnv as w, resolvePolicyTargetResolution as x, resolvePolicyAllowlistCandidatePath as y };
