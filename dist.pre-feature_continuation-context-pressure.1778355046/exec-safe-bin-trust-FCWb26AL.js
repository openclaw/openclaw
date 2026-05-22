import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { t as expandHomePrefix } from "./home-dir-g5LU3LmA.js";
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
	return compileGlobRegex(normalizedPattern).test(normalizedTarget);
}
//#endregion
//#region src/utils/shell-argv.ts
const DOUBLE_QUOTE_ESCAPES = new Set([
	"\\",
	"\"",
	"$",
	"`",
	"\n",
	"\r"
]);
function isDoubleQuoteEscape(next) {
	return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}
function splitShellArgs(raw) {
	const tokens = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	const pushToken = () => {
		if (buf.length > 0) {
			tokens.push(buf);
			buf = "";
		}
	};
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (!inSingle && !inDouble && ch === "\\") {
			escaped = true;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else buf += ch;
			continue;
		}
		if (inDouble) {
			const next = raw[i + 1];
			if (ch === "\\" && isDoubleQuoteEscape(next)) {
				buf += next;
				i += 1;
				continue;
			}
			if (ch === "\"") inDouble = false;
			else buf += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			continue;
		}
		if (ch === "#" && buf.length === 0) break;
		if (/\s/.test(ch)) {
			pushToken();
			continue;
		}
		buf += ch;
	}
	if (escaped || inSingle || inDouble) return null;
	pushToken();
	return tokens;
}
//#endregion
//#region src/infra/exec-wrapper-tokens.ts
const WINDOWS_EXECUTABLE_SUFFIXES = [
	".exe",
	".cmd",
	".bat",
	".com"
];
function stripWindowsExecutableSuffix(value) {
	for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) if (value.endsWith(suffix)) return value.slice(0, -suffix.length);
	return value;
}
function basenameLower(token) {
	const win = path.win32.basename(token);
	const posix = path.posix.basename(token);
	return normalizeLowercaseStringOrEmpty(win.length < posix.length ? win : posix);
}
function normalizeExecutableToken(token) {
	return stripWindowsExecutableSuffix(basenameLower(token));
}
//#endregion
//#region src/infra/command-carriers.ts
const COMMAND_CARRIER_EXECUTABLES = new Set([
	"sudo",
	"doas",
	"env",
	"command",
	"builtin"
]);
const MAX_ENV_SPLIT_PAYLOAD_DEPTH = 32;
const COMMAND_EXECUTING_OPTIONS = new Set(["-p"]);
const COMMAND_QUERY_OPTIONS = new Set(["-v", "-V"]);
const ENV_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-P",
	"-S",
	"-s",
	"-u",
	"--argv0",
	"--block-signal",
	"--chdir",
	"--default-signal",
	"--ignore-signal",
	"--split-string",
	"--unset"
]);
const ENV_SPLIT_STRING_OPTIONS = new Set([
	"-S",
	"-s",
	"--split-string"
]);
const ENV_STANDALONE_OPTIONS = new Set([
	"-0",
	"-i",
	"--ignore-environment",
	"--null"
]);
const SUDO_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-D",
	"-g",
	"-h",
	"-p",
	"-R",
	"-T",
	"-U",
	"-u",
	"--chdir",
	"--chroot",
	"--close-from",
	"--command-timeout",
	"--group",
	"--host",
	"--other-user",
	"--prompt",
	"--role",
	"--type",
	"--user"
]);
const SUDO_STANDALONE_OPTIONS = new Set([
	"-A",
	"-B",
	"-b",
	"-E",
	"-H",
	"-i",
	"-k",
	"-N",
	"-n",
	"-P",
	"-S",
	"-s",
	"--askpass",
	"--background",
	"--bell",
	"--login",
	"--no-update",
	"--non-interactive",
	"--preserve-env",
	"--preserve-groups",
	"--reset-home",
	"--reset-timestamp",
	"--set-home",
	"--shell",
	"--stdin"
]);
const SUDO_NON_EXEC_OPTIONS = new Set([
	"-K",
	"-l",
	"-V",
	"-v",
	"-e",
	"--edit",
	"--help",
	"--list",
	"--remove-timestamp",
	"--validate",
	"--version"
]);
const DOAS_OPTIONS_WITH_VALUE = new Set([
	"-a",
	"-C",
	"-u"
]);
const DOAS_STANDALONE_OPTIONS = new Set([
	"-L",
	"-n",
	"-s"
]);
const EXEC_OPTIONS_WITH_VALUE = new Set(["-a"]);
const EXEC_STANDALONE_OPTIONS = new Set(["-c", "-l"]);
function isEnvAssignmentToken(token) {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
}
function optionName(token) {
	return token.split("=", 1)[0] ?? token;
}
function parseCarrierOptionToken(token, standaloneOptions, optionsWithValue, nonExecutingOptions = /* @__PURE__ */ new Set()) {
	if (token.startsWith("--")) {
		const name = optionName(token);
		if (standaloneOptions.has(name) || optionsWithValue.has(name) || nonExecutingOptions.has(name)) {
			const valueDelimiter = token.indexOf("=");
			return [{
				name,
				hasInlineValue: valueDelimiter >= 0,
				inlineValue: valueDelimiter >= 0 ? token.slice(valueDelimiter + 1) : void 0
			}];
		}
		return null;
	}
	if (!/^-[A-Za-z0-9]/u.test(token)) return null;
	const options = [];
	for (let index = 1; index < token.length; index += 1) {
		const name = `-${token[index] ?? ""}`;
		if (optionsWithValue.has(name)) {
			options.push({
				name,
				hasInlineValue: index < token.length - 1,
				inlineValue: index < token.length - 1 ? token.slice(index + 1) : void 0
			});
			return options;
		}
		if (standaloneOptions.has(name) || nonExecutingOptions.has(name)) {
			options.push({
				name,
				hasInlineValue: false
			});
			continue;
		}
		return null;
	}
	return options.length > 0 ? options : null;
}
function knownCarrierOptionConsumesNextValue(options, optionsWithValue, nonExecutingOptions = /* @__PURE__ */ new Set()) {
	let consumesNextValue = false;
	for (const option of options) {
		if (nonExecutingOptions.has(option.name)) return null;
		if (optionsWithValue.has(option.name)) consumesNextValue = !option.hasInlineValue;
	}
	return consumesNextValue;
}
function stripSudoEnvAssignmentsFromCommandArgv(executable, argv) {
	if (executable !== "sudo") return argv.length > 0 ? argv : null;
	let index = 0;
	while (index < argv.length && isEnvAssignmentToken(argv[index] ?? "")) index += 1;
	return index < argv.length ? argv.slice(index) : null;
}
function findParsedCarrierOption(options, names) {
	return options.find((option) => names.has(option.name));
}
function resolveEnvSplitPayload(payload, trailingArgv, depth) {
	const innerArgv = splitShellArgs(payload);
	if (!innerArgv || innerArgv.length === 0) return null;
	const carriedArgv = [...innerArgv, ...trailingArgv];
	return resolveEnvCarriedArgv(["env", ...carriedArgv], depth + 1) ?? carriedArgv;
}
function parseEnvInvocationPrelude(argv, depth = 0) {
	if (depth > MAX_ENV_SPLIT_PAYLOAD_DEPTH || normalizeExecutableToken(argv[0] ?? "") !== "env") return null;
	let usesModifiers = false;
	const assignmentKeys = [];
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (!token) return null;
		if (isEnvAssignmentToken(token)) {
			usesModifiers = true;
			const delimiter = token.indexOf("=");
			if (delimiter > 0) assignmentKeys.push(token.slice(0, delimiter));
			continue;
		}
		if (token === "--" || token === "-") return index + 1 < argv.length ? {
			assignmentKeys,
			commandIndex: index + 1,
			usesModifiers
		} : null;
		if (token.startsWith("-")) {
			const option = parseCarrierOptionToken(token, ENV_STANDALONE_OPTIONS, ENV_OPTIONS_WITH_VALUE);
			if (!option) return null;
			usesModifiers = true;
			const splitStringOption = findParsedCarrierOption(option, ENV_SPLIT_STRING_OPTIONS);
			if (splitStringOption) {
				const payloadIndex = splitStringOption.inlineValue === void 0 ? index + 1 : index;
				const payload = splitStringOption.inlineValue ?? argv[payloadIndex];
				const trailingIndex = payloadIndex + 1;
				const splitArgv = typeof payload === "string" ? resolveEnvSplitPayload(payload, argv.slice(trailingIndex), depth) : null;
				return splitArgv ? {
					assignmentKeys,
					commandIndex: trailingIndex,
					splitArgv,
					usesModifiers
				} : null;
			}
			if (knownCarrierOptionConsumesNextValue(option, ENV_OPTIONS_WITH_VALUE)) index += 1;
			continue;
		}
		return {
			assignmentKeys,
			commandIndex: index,
			usesModifiers
		};
	}
	return null;
}
function envInvocationUsesModifiers(argv) {
	return parseEnvInvocationPrelude(argv)?.usesModifiers ?? normalizeExecutableToken(argv[0] ?? "") === "env";
}
function unwrapEnvInvocation(argv) {
	const parsed = parseEnvInvocationPrelude(argv);
	return parsed ? parsed.splitArgv ?? argv.slice(parsed.commandIndex) : null;
}
function resolveEnvCarriedArgv(argv, depth = 0) {
	const parsed = parseEnvInvocationPrelude(argv, depth);
	return parsed ? parsed.splitArgv ?? argv.slice(parsed.commandIndex) : null;
}
function resolveCommandBuiltinCarriedArgv(argv) {
	const executable = normalizeExecutableToken(argv[0] ?? "");
	if (executable !== "command" && executable !== "builtin") return null;
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--") return argv.slice(index + 1);
		if (!token.startsWith("-")) return argv.slice(index);
		const normalized = optionName(token);
		if (COMMAND_QUERY_OPTIONS.has(normalized)) return null;
		if (!COMMAND_EXECUTING_OPTIONS.has(normalized)) return null;
	}
	return null;
}
function resolveSudoLikeCarriedArgv(argv) {
	const executable = normalizeExecutableToken(argv[0] ?? "");
	const standaloneOptions = executable === "sudo" ? SUDO_STANDALONE_OPTIONS : executable === "doas" ? DOAS_STANDALONE_OPTIONS : null;
	const optionsWithValue = executable === "sudo" ? SUDO_OPTIONS_WITH_VALUE : executable === "doas" ? DOAS_OPTIONS_WITH_VALUE : null;
	if (!standaloneOptions || !optionsWithValue) return null;
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--") return stripSudoEnvAssignmentsFromCommandArgv(executable, argv.slice(index + 1));
		if (!token.startsWith("-")) return stripSudoEnvAssignmentsFromCommandArgv(executable, argv.slice(index));
		const option = parseCarrierOptionToken(token, standaloneOptions, optionsWithValue, executable === "sudo" ? SUDO_NON_EXEC_OPTIONS : void 0);
		if (!option) return null;
		const consumeNextValue = knownCarrierOptionConsumesNextValue(option, optionsWithValue, executable === "sudo" ? SUDO_NON_EXEC_OPTIONS : void 0);
		if (consumeNextValue === null) return null;
		if (consumeNextValue) index += 1;
	}
	return null;
}
function resolveExecCarriedArgv(argv) {
	if (normalizeExecutableToken(argv[0] ?? "") !== "exec") return null;
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--") return argv.slice(index + 1);
		if (!token.startsWith("-")) return argv.slice(index);
		const option = parseCarrierOptionToken(token, EXEC_STANDALONE_OPTIONS, EXEC_OPTIONS_WITH_VALUE);
		if (!option) return null;
		if (knownCarrierOptionConsumesNextValue(option, EXEC_OPTIONS_WITH_VALUE)) index += 1;
	}
	return null;
}
function resolveCarrierCommandArgv(argv, depth = 0, options) {
	switch (normalizeExecutableToken(argv[0] ?? "")) {
		case "env": return resolveEnvCarriedArgv(argv, depth);
		case "command":
		case "builtin": return resolveCommandBuiltinCarriedArgv(argv);
		case "sudo":
		case "doas": return resolveSudoLikeCarriedArgv(argv);
		case "exec": return options?.includeExec ? resolveExecCarriedArgv(argv) : null;
		default: return null;
	}
}
const NICE_OPTIONS_WITH_VALUE = new Set([
	"-n",
	"--adjustment",
	"--priority"
]);
const CAFFEINATE_OPTIONS_WITH_VALUE = new Set(["-t", "-w"]);
const STDBUF_OPTIONS_WITH_VALUE = new Set([
	"-i",
	"--input",
	"-o",
	"--output",
	"-e",
	"--error"
]);
const TIME_FLAG_OPTIONS = new Set([
	"-a",
	"--append",
	"-h",
	"--help",
	"-l",
	"-p",
	"-q",
	"--quiet",
	"-v",
	"--verbose",
	"-V",
	"--version"
]);
const TIME_OPTIONS_WITH_VALUE = new Set([
	"-f",
	"--format",
	"-o",
	"--output"
]);
const BSD_SCRIPT_FLAG_OPTIONS = new Set([
	"-a",
	"-d",
	"-k",
	"-p",
	"-q",
	"-r"
]);
const BSD_SCRIPT_OPTIONS_WITH_VALUE = new Set(["-F", "-t"]);
const SANDBOX_EXEC_OPTIONS_WITH_VALUE = new Set([
	"-f",
	"-p",
	"-d"
]);
const TIMEOUT_FLAG_OPTIONS = new Set([
	"--foreground",
	"--preserve-status",
	"-v",
	"--verbose"
]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set([
	"-k",
	"--kill-after",
	"-s",
	"--signal"
]);
const XCRUN_FLAG_OPTIONS = new Set([
	"-k",
	"--kill-cache",
	"-l",
	"--log",
	"-n",
	"--no-cache",
	"-r",
	"--run",
	"-v",
	"--verbose"
]);
function isArchSelectorToken(token) {
	return /^-[A-Za-z0-9_]+$/.test(token);
}
function isKnownArchSelectorToken(token) {
	return token === "-arm64" || token === "-arm64e" || token === "-i386" || token === "-x86_64" || token === "-x86_64h";
}
function isKnownArchNameToken(token) {
	return isKnownArchSelectorToken(`-${token}`);
}
function scanWrapperInvocation(argv, params) {
	let idx = 1;
	let expectsOptionValue = false;
	while (idx < argv.length) {
		const token = argv[idx]?.trim() ?? "";
		if (!token) {
			idx += 1;
			continue;
		}
		if (expectsOptionValue) {
			expectsOptionValue = false;
			idx += 1;
			continue;
		}
		if (params.separators?.has(token)) {
			idx += 1;
			break;
		}
		const directive = params.onToken(token, normalizeLowercaseStringOrEmpty(token));
		if (directive === "stop") break;
		if (directive === "invalid") return null;
		if (directive === "consume-next") expectsOptionValue = true;
		idx += 1;
	}
	if (expectsOptionValue) return null;
	const commandIndex = params.adjustCommandIndex ? params.adjustCommandIndex(idx, argv) : idx;
	if (commandIndex === null || commandIndex >= argv.length) return null;
	return argv.slice(commandIndex);
}
function extractEnvAssignmentKeysFromDispatchWrappers(argv, maxDepth = 4) {
	let current = argv;
	const assignmentKeys = [];
	for (let depth = 0; depth < maxDepth; depth += 1) {
		const unwrap = unwrapKnownDispatchWrapperInvocation(current);
		if (unwrap.kind !== "unwrapped" || unwrap.argv.length === 0) break;
		if (unwrap.wrapper === "env") {
			const parsed = parseEnvInvocationPrelude(current);
			if (parsed) assignmentKeys.push(...parsed.assignmentKeys);
		}
		current = unwrap.argv;
	}
	return Array.from(new Set(assignmentKeys)).toSorted((a, b) => a.localeCompare(b));
}
function unwrapDashOptionInvocation(argv, params) {
	return scanWrapperInvocation(argv, {
		separators: new Set(["--"]),
		onToken: (token, lower) => {
			if (!token.startsWith("-") || token === "-") return "stop";
			const [flag] = lower.split("=", 2);
			return params.onFlag(flag, lower);
		},
		adjustCommandIndex: params.adjustCommandIndex
	});
}
function unwrapNiceInvocation(argv) {
	return unwrapDashOptionInvocation(argv, { onFlag: (flag, lower) => {
		if (/^-\d+$/.test(lower)) return "continue";
		if (NICE_OPTIONS_WITH_VALUE.has(flag)) return lower.includes("=") || lower !== flag ? "continue" : "consume-next";
		if (lower.startsWith("-n") && lower.length > 2) return "continue";
		return "invalid";
	} });
}
function unwrapCaffeinateInvocation(argv) {
	return unwrapDashOptionInvocation(argv, { onFlag: (flag, lower) => {
		if (flag === "-d" || flag === "-i" || flag === "-m" || flag === "-s" || flag === "-u") return "continue";
		if (CAFFEINATE_OPTIONS_WITH_VALUE.has(flag)) return lower !== flag || lower.includes("=") ? "continue" : "consume-next";
		return "invalid";
	} });
}
function unwrapNohupInvocation(argv) {
	return scanWrapperInvocation(argv, {
		separators: new Set(["--"]),
		onToken: (token, lower) => {
			if (!token.startsWith("-") || token === "-") return "stop";
			return lower === "--help" || lower === "--version" ? "continue" : "invalid";
		}
	});
}
function unwrapSandboxExecInvocation(argv) {
	return unwrapDashOptionInvocation(argv, { onFlag: (flag, lower) => {
		if (SANDBOX_EXEC_OPTIONS_WITH_VALUE.has(flag)) return lower !== flag || lower.includes("=") ? "continue" : "consume-next";
		return "invalid";
	} });
}
function unwrapStdbufInvocation(argv) {
	return unwrapDashOptionInvocation(argv, { onFlag: (flag, lower) => {
		if (!STDBUF_OPTIONS_WITH_VALUE.has(flag)) return "invalid";
		return lower.includes("=") ? "continue" : "consume-next";
	} });
}
function unwrapTimeInvocation(argv) {
	return unwrapDashOptionInvocation(argv, { onFlag: (flag, lower) => {
		if (TIME_FLAG_OPTIONS.has(flag)) return "continue";
		if (TIME_OPTIONS_WITH_VALUE.has(flag)) return lower.includes("=") ? "continue" : "consume-next";
		return "invalid";
	} });
}
function supportsScriptPositionalCommand(platform = process.platform) {
	return platform === "darwin" || platform === "freebsd";
}
function unwrapScriptInvocation(argv) {
	if (!supportsScriptPositionalCommand()) return null;
	return scanWrapperInvocation(argv, {
		separators: new Set(["--"]),
		onToken: (token, lower) => {
			if (!lower.startsWith("-") || lower === "-") return "stop";
			const [flag] = token.split("=", 2);
			if (BSD_SCRIPT_OPTIONS_WITH_VALUE.has(flag)) return token.includes("=") ? "continue" : "consume-next";
			if (BSD_SCRIPT_FLAG_OPTIONS.has(flag)) return "continue";
			return "invalid";
		},
		adjustCommandIndex: (commandIndex, currentArgv) => {
			let sawTranscript = false;
			for (let idx = commandIndex; idx < currentArgv.length; idx += 1) {
				if (!(currentArgv[idx]?.trim() ?? "")) continue;
				if (!sawTranscript) {
					sawTranscript = true;
					continue;
				}
				return idx;
			}
			return null;
		}
	});
}
function unwrapTimeoutInvocation(argv) {
	return unwrapDashOptionInvocation(argv, {
		onFlag: (flag, lower) => {
			if (TIMEOUT_FLAG_OPTIONS.has(flag)) return "continue";
			if (TIMEOUT_OPTIONS_WITH_VALUE.has(flag)) return lower.includes("=") ? "continue" : "consume-next";
			return "invalid";
		},
		adjustCommandIndex: (commandIndex, currentArgv) => {
			const wrappedCommandIndex = commandIndex + 1;
			return wrappedCommandIndex < currentArgv.length ? wrappedCommandIndex : null;
		}
	});
}
function unwrapArchInvocation(argv) {
	let expectsArchName = false;
	return scanWrapperInvocation(argv, { onToken: (token, lower) => {
		if (expectsArchName) {
			expectsArchName = false;
			return isKnownArchNameToken(lower) ? "continue" : "invalid";
		}
		if (!token.startsWith("-") || token === "-") return "stop";
		if (lower === "-32" || lower === "-64") return "continue";
		if (lower === "-arch") {
			expectsArchName = true;
			return "continue";
		}
		if (lower === "-c" || lower === "-d" || lower === "-e" || lower === "-h") return "invalid";
		return isArchSelectorToken(token) && isKnownArchSelectorToken(lower) ? "continue" : "invalid";
	} });
}
function supportsArchDispatchWrapper(platform = process.platform) {
	return platform === "darwin";
}
function supportsXcrunDispatchWrapper(platform = process.platform) {
	return platform === "darwin";
}
function unwrapXcrunInvocation(argv) {
	return scanWrapperInvocation(argv, { onToken: (token, lower) => {
		if (!token.startsWith("-") || token === "-") return "stop";
		if (XCRUN_FLAG_OPTIONS.has(lower)) return "continue";
		return "invalid";
	} });
}
const DISPATCH_WRAPPER_SPEC_BY_NAME = new Map([
	{
		name: "arch",
		unwrap: (argv, platform) => supportsArchDispatchWrapper(platform) ? unwrapArchInvocation(argv) : null,
		transparentUsage: (_argv, platform) => supportsArchDispatchWrapper(platform)
	},
	{
		name: "caffeinate",
		unwrap: unwrapCaffeinateInvocation,
		transparentUsage: true
	},
	{ name: "chrt" },
	{ name: "doas" },
	{
		name: "env",
		unwrap: unwrapEnvInvocation,
		transparentUsage: (argv) => !envInvocationUsesModifiers(argv)
	},
	{ name: "ionice" },
	{
		name: "nice",
		unwrap: unwrapNiceInvocation,
		transparentUsage: true
	},
	{
		name: "nohup",
		unwrap: unwrapNohupInvocation,
		transparentUsage: true
	},
	{
		name: "sandbox-exec",
		unwrap: unwrapSandboxExecInvocation,
		transparentUsage: true
	},
	{
		name: "script",
		unwrap: unwrapScriptInvocation,
		transparentUsage: true
	},
	{ name: "setsid" },
	{
		name: "stdbuf",
		unwrap: unwrapStdbufInvocation,
		transparentUsage: true
	},
	{ name: "sudo" },
	{ name: "taskset" },
	{
		name: "time",
		unwrap: unwrapTimeInvocation,
		transparentUsage: true
	},
	{
		name: "timeout",
		unwrap: unwrapTimeoutInvocation,
		transparentUsage: true
	},
	{
		name: "xcrun",
		unwrap: (argv, platform) => supportsXcrunDispatchWrapper(platform) ? unwrapXcrunInvocation(argv) : null,
		transparentUsage: (_argv, platform) => supportsXcrunDispatchWrapper(platform)
	}
].map((spec) => [spec.name, spec]));
function blockDispatchWrapper(wrapper) {
	return {
		kind: "blocked",
		wrapper
	};
}
function unwrapDispatchWrapper(wrapper, unwrapped) {
	return unwrapped ? {
		kind: "unwrapped",
		wrapper,
		argv: unwrapped
	} : blockDispatchWrapper(wrapper);
}
function isDispatchWrapperExecutable(token) {
	return DISPATCH_WRAPPER_SPEC_BY_NAME.has(normalizeExecutableToken(token));
}
function unwrapKnownDispatchWrapperInvocation(argv, platform = process.platform) {
	const token0 = argv[0]?.trim();
	if (!token0) return { kind: "not-wrapper" };
	const wrapper = normalizeExecutableToken(token0);
	const spec = DISPATCH_WRAPPER_SPEC_BY_NAME.get(wrapper);
	if (!spec) return { kind: "not-wrapper" };
	return spec.unwrap ? unwrapDispatchWrapper(wrapper, spec.unwrap(argv, platform)) : blockDispatchWrapper(wrapper);
}
function unwrapDispatchWrappersForResolution(argv, maxDepth = 4, platform = process.platform) {
	return resolveDispatchWrapperTrustPlan(argv, maxDepth, platform).argv;
}
function isSemanticDispatchWrapperUsage(wrapper, argv, platform = process.platform) {
	const spec = DISPATCH_WRAPPER_SPEC_BY_NAME.get(wrapper);
	if (!spec?.unwrap) return true;
	const transparentUsage = spec.transparentUsage;
	if (typeof transparentUsage === "function") return !transparentUsage(argv, platform);
	return transparentUsage !== true;
}
function blockedDispatchWrapperPlan(params) {
	return {
		argv: params.argv,
		wrappers: params.wrappers,
		policyBlocked: true,
		blockedWrapper: params.blockedWrapper
	};
}
function resolveDispatchWrapperTrustPlan(argv, maxDepth = 4, platform = process.platform) {
	let current = argv;
	const wrappers = [];
	for (let depth = 0; depth < maxDepth; depth += 1) {
		const unwrap = unwrapKnownDispatchWrapperInvocation(current, platform);
		if (unwrap.kind === "blocked") return blockedDispatchWrapperPlan({
			argv: current,
			wrappers,
			blockedWrapper: unwrap.wrapper
		});
		if (unwrap.kind !== "unwrapped" || unwrap.argv.length === 0) break;
		wrappers.push(unwrap.wrapper);
		if (isSemanticDispatchWrapperUsage(unwrap.wrapper, current, platform)) return blockedDispatchWrapperPlan({
			argv: current,
			wrappers,
			blockedWrapper: unwrap.wrapper
		});
		current = unwrap.argv;
	}
	if (wrappers.length >= maxDepth) {
		const overflow = unwrapKnownDispatchWrapperInvocation(current, platform);
		if (overflow.kind === "blocked" || overflow.kind === "unwrapped") return blockedDispatchWrapperPlan({
			argv: current,
			wrappers,
			blockedWrapper: overflow.wrapper
		});
	}
	return {
		argv: current,
		wrappers,
		policyBlocked: false
	};
}
function hasDispatchEnvManipulation(argv) {
	const unwrap = unwrapKnownDispatchWrapperInvocation(argv);
	return unwrap.kind === "unwrapped" && unwrap.wrapper === "env" && envInvocationUsesModifiers(argv);
}
//#endregion
//#region src/infra/shell-inline-command.ts
const POSIX_INLINE_COMMAND_FLAGS = new Set([
	"-lc",
	"-c",
	"--command"
]);
const POWERSHELL_INLINE_COMMAND_FLAGS = new Set([
	"-c",
	"-command",
	"--command",
	"-f",
	"-file",
	"-encodedcommand",
	"-enc",
	"-e"
]);
function resolveInlineCommandMatch(argv, flags, options = {}) {
	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]?.trim();
		if (!token) continue;
		const lower = normalizeLowercaseStringOrEmpty(token);
		if (lower === "--") break;
		if (flags.has(lower)) {
			const valueTokenIndex = i + 1 < argv.length ? i + 1 : null;
			const command = argv[i + 1]?.trim();
			return {
				command: command ? command : null,
				valueTokenIndex
			};
		}
		if (options.allowCombinedC && /^-[^-]*c[^-]*$/i.test(token)) {
			const commandIndex = lower.indexOf("c");
			const inline = token.slice(commandIndex + 1).trim();
			if (inline) return {
				command: inline,
				valueTokenIndex: i
			};
			const valueTokenIndex = i + 1 < argv.length ? i + 1 : null;
			const command = argv[i + 1]?.trim();
			return {
				command: command ? command : null,
				valueTokenIndex
			};
		}
	}
	return {
		command: null,
		valueTokenIndex: null
	};
}
//#endregion
//#region src/infra/shell-wrapper-resolution.ts
const POSIX_SHELL_WRAPPER_NAMES = [
	"ash",
	"bash",
	"dash",
	"fish",
	"ksh",
	"sh",
	"zsh"
];
const WINDOWS_CMD_WRAPPER_NAMES = ["cmd"];
const POWERSHELL_WRAPPER_NAMES = ["powershell", "pwsh"];
const SHELL_MULTIPLEXER_WRAPPER_NAMES = ["busybox", "toybox"];
function withWindowsExeAliases(names) {
	const expanded = /* @__PURE__ */ new Set();
	for (const name of names) {
		expanded.add(name);
		expanded.add(`${name}.exe`);
	}
	return Array.from(expanded);
}
const POSIX_SHELL_WRAPPERS = new Set(POSIX_SHELL_WRAPPER_NAMES);
const POWERSHELL_WRAPPERS = new Set(withWindowsExeAliases(POWERSHELL_WRAPPER_NAMES));
const POSIX_SHELL_WRAPPER_CANONICAL = new Set(POSIX_SHELL_WRAPPER_NAMES);
const WINDOWS_CMD_WRAPPER_CANONICAL = new Set(WINDOWS_CMD_WRAPPER_NAMES);
const POWERSHELL_WRAPPER_CANONICAL = new Set(POWERSHELL_WRAPPER_NAMES);
const SHELL_MULTIPLEXER_WRAPPER_CANONICAL = new Set(SHELL_MULTIPLEXER_WRAPPER_NAMES);
const SHELL_WRAPPER_CANONICAL = new Set([
	...POSIX_SHELL_WRAPPER_NAMES,
	...WINDOWS_CMD_WRAPPER_NAMES,
	...POWERSHELL_WRAPPER_NAMES
]);
const SHELL_WRAPPER_SPECS = [
	{
		kind: "posix",
		names: POSIX_SHELL_WRAPPER_CANONICAL
	},
	{
		kind: "cmd",
		names: WINDOWS_CMD_WRAPPER_CANONICAL
	},
	{
		kind: "powershell",
		names: POWERSHELL_WRAPPER_CANONICAL
	}
];
function resolveShellWrapperCandidate(params) {
	if (!isWithinDispatchClassificationDepth(params.depth)) return null;
	const token0 = params.argv[0]?.trim();
	if (!token0) return null;
	const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(params.argv);
	if (dispatchUnwrap.kind === "blocked") return null;
	if (dispatchUnwrap.kind === "unwrapped") return resolveShellWrapperCandidate({
		...params,
		argv: dispatchUnwrap.argv,
		depth: params.depth + 1,
		state: params.onDispatchUnwrap?.(params.state, params.argv) ?? params.state
	});
	const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(params.argv);
	if (shellMultiplexerUnwrap.kind === "blocked") return null;
	if (shellMultiplexerUnwrap.kind === "unwrapped") return resolveShellWrapperCandidate({
		...params,
		argv: shellMultiplexerUnwrap.argv,
		depth: params.depth + 1
	});
	return {
		argv: params.argv,
		token0,
		state: params.state
	};
}
function resolveShellWrapperSpecAndArgvInternal(argv, depth) {
	const candidate = resolveShellWrapperCandidate({
		argv,
		depth,
		state: null
	});
	if (!candidate) return null;
	const wrapper = findShellWrapperSpec(normalizeExecutableToken(candidate.token0));
	if (!wrapper) return null;
	const payload = extractShellWrapperPayload(candidate.argv, wrapper);
	if (!payload) return null;
	return {
		argv: candidate.argv,
		wrapper,
		payload
	};
}
function isWithinDispatchClassificationDepth(depth) {
	return depth <= 4;
}
function isShellWrapperExecutable(token) {
	return SHELL_WRAPPER_CANONICAL.has(normalizeExecutableToken(token));
}
function isShellWrapperInvocationInternal(argv, depth) {
	const candidate = resolveShellWrapperCandidate({
		argv,
		depth,
		state: null
	});
	return candidate ? isShellWrapperExecutable(candidate.token0) : false;
}
function isShellWrapperInvocation(argv) {
	return isShellWrapperInvocationInternal(argv, 0);
}
function normalizeRawCommand(rawCommand) {
	const trimmed = rawCommand?.trim() ?? "";
	return trimmed.length > 0 ? trimmed : null;
}
function findShellWrapperSpec(baseExecutable) {
	for (const spec of SHELL_WRAPPER_SPECS) if (spec.names.has(baseExecutable)) return spec;
	return null;
}
function unwrapKnownShellMultiplexerInvocation(argv) {
	const token0 = argv[0]?.trim();
	if (!token0) return { kind: "not-wrapper" };
	const wrapper = normalizeExecutableToken(token0);
	if (!SHELL_MULTIPLEXER_WRAPPER_CANONICAL.has(wrapper)) return { kind: "not-wrapper" };
	let appletIndex = 1;
	if (argv[appletIndex]?.trim() === "--") appletIndex += 1;
	const applet = argv[appletIndex]?.trim();
	if (!applet || !isShellWrapperExecutable(applet)) return {
		kind: "blocked",
		wrapper
	};
	const unwrapped = argv.slice(appletIndex);
	if (unwrapped.length === 0) return {
		kind: "blocked",
		wrapper
	};
	return {
		kind: "unwrapped",
		wrapper,
		argv: unwrapped
	};
}
function extractPosixShellInlineCommand(argv) {
	return extractInlineCommandByFlags(argv, POSIX_INLINE_COMMAND_FLAGS, { allowCombinedC: true });
}
function extractCmdInlineCommand(argv) {
	const idx = argv.findIndex((item) => {
		const token = normalizeLowercaseStringOrEmpty(item);
		return token === "/c" || token === "/k";
	});
	if (idx === -1) return null;
	const tail = argv.slice(idx + 1);
	if (tail.length === 0) return null;
	const cmd = tail.join(" ").trim();
	return cmd.length > 0 ? cmd : null;
}
function extractPowerShellInlineCommand(argv) {
	return extractInlineCommandByFlags(argv, POWERSHELL_INLINE_COMMAND_FLAGS);
}
function extractInlineCommandByFlags(argv, flags, options = {}) {
	return resolveInlineCommandMatch(argv, flags, options).command;
}
function extractShellWrapperPayload(argv, spec) {
	switch (spec.kind) {
		case "posix": return extractPosixShellInlineCommand(argv);
		case "cmd": return extractCmdInlineCommand(argv);
		case "powershell": return extractPowerShellInlineCommand(argv);
	}
	throw new Error("Unsupported shell wrapper kind");
}
function hasEnvManipulationBeforeShellWrapperInternal(argv, depth, envManipulationSeen) {
	const candidate = resolveShellWrapperCandidate({
		argv,
		depth,
		state: envManipulationSeen,
		onDispatchUnwrap: (state, wrappedArgv) => state || hasDispatchEnvManipulation(wrappedArgv)
	});
	if (!candidate) return false;
	const wrapper = findShellWrapperSpec(normalizeExecutableToken(candidate.token0));
	if (!wrapper) return false;
	if (!extractShellWrapperPayload(candidate.argv, wrapper)) return false;
	return candidate.state;
}
function hasEnvManipulationBeforeShellWrapper(argv) {
	return hasEnvManipulationBeforeShellWrapperInternal(argv, 0, false);
}
function extractShellWrapperCommandInternal(argv, rawCommand, depth) {
	const resolved = resolveShellWrapperSpecAndArgvInternal(argv, depth);
	if (!resolved) return {
		isWrapper: false,
		command: null
	};
	return {
		isWrapper: true,
		command: rawCommand ?? resolved.payload
	};
}
function resolveShellWrapperTransportArgv(argv) {
	return resolveShellWrapperSpecAndArgvInternal(argv, 0)?.argv ?? null;
}
function extractShellWrapperInlineCommand(argv) {
	const extracted = extractShellWrapperCommandInternal(argv, null, 0);
	return extracted.isWrapper ? extracted.command : null;
}
function extractShellWrapperCommand(argv, rawCommand) {
	return extractShellWrapperCommandInternal(argv, normalizeRawCommand(rawCommand), 0);
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
	return {
		argv,
		policyArgv,
		wrapperChain,
		policyBlocked,
		blockedWrapper,
		shellWrapperExecutable,
		shellInlineCommand: shellWrapperExecutable ? extractShellWrapperInlineCommand(argv) : null
	};
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
	if (path.isAbsolute(expanded)) return expanded;
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
	const entries = pathEnv.split(path.delimiter).filter(Boolean);
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
function resolvePolicyTargetCandidatePath(resolution, cwd) {
	return resolveExecutableCandidatePathFromResolution(isCommandResolution(resolution) ? resolution.policy : resolution, cwd);
}
function resolveApprovalAuditCandidatePath(resolution, cwd) {
	return resolvePolicyTargetCandidatePath(resolution, cwd);
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
function hasPathSelector(value) {
	return value.includes("/") || value.includes("\\") || value.includes("~");
}
function matchesExecutableBasenamePattern(pattern, resolution) {
	if (hasPathSelector(resolution.rawExecutable)) return false;
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
	const resolvedPath = resolution.resolvedPath;
	const useArgPattern = normalizeLowercaseStringOrEmpty(platform ?? process.platform).startsWith("win");
	let pathOnlyMatch = null;
	for (const entry of entries) {
		const pattern = entry.pattern?.trim();
		if (!pattern) continue;
		if (!(hasPathSelector(pattern) ? matchesExecAllowlistPattern(pattern, resolvedPath) : pattern !== "*" && matchesExecutableBasenamePattern(pattern, resolution))) continue;
		if (!useArgPattern) return entry;
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
const NO_FLAGS = /* @__PURE__ */ new Set();
function isSafeLiteralToken(value) {
	if (!value || value === "-") return true;
	return !hasGlobToken(value) && !isPathLikeToken(value);
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
function normalizeTrustedDir(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return path.resolve(trimmed);
}
function normalizeTrustedSafeBinDirs(entries) {
	if (!Array.isArray(entries)) return [];
	const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	return Array.from(new Set(normalized));
}
function resolveTrustedSafeBinDirs(entries) {
	const resolved = entries.map((entry) => normalizeTrustedDir(entry)).filter((entry) => Boolean(entry));
	return Array.from(new Set(resolved)).toSorted();
}
function buildTrustedSafeBinCacheKey(entries) {
	return resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries)).join("");
}
function buildTrustedSafeBinDirs(params = {}) {
	const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
	const extraDirs = params.extraDirs ?? [];
	return new Set(resolveTrustedSafeBinDirs([...normalizeTrustedSafeBinDirs(baseDirs), ...normalizeTrustedSafeBinDirs(extraDirs)]));
}
function getTrustedSafeBinDirs(params = {}) {
	const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
	const extraDirs = params.extraDirs ?? [];
	const key = buildTrustedSafeBinCacheKey([...baseDirs, ...extraDirs]);
	if (!params.refresh && trustedSafeBinCache?.key === key) return trustedSafeBinCache.dirs;
	const dirs = buildTrustedSafeBinDirs({
		baseDirs,
		extraDirs
	});
	trustedSafeBinCache = {
		key,
		dirs
	};
	return dirs;
}
function isTrustedSafeBinPath(params) {
	const trustedDirs = params.trustedDirs ?? getTrustedSafeBinDirs();
	const resolvedDir = path.dirname(path.resolve(params.resolvedPath));
	return trustedDirs.has(resolvedDir);
}
function listWritableExplicitTrustedSafeBinDirs(entries) {
	if (process.platform === "win32") return [];
	const resolved = resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries));
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
export { unwrapKnownShellMultiplexerInvocation as A, parseEnvInvocationPrelude as B, POWERSHELL_WRAPPERS as C, isShellWrapperExecutable as D, hasEnvManipulationBeforeShellWrapper as E, isDispatchWrapperExecutable as F, SAFE_BIN_PROFILES as G, normalizeExecutableToken as H, unwrapDispatchWrappersForResolution as I, normalizeSafeBinProfileFixtures as K, unwrapKnownDispatchWrapperInvocation as L, POWERSHELL_INLINE_COMMAND_FLAGS as M, resolveInlineCommandMatch as N, isShellWrapperInvocation as O, extractEnvAssignmentKeysFromDispatchWrappers as P, COMMAND_CARRIER_EXECUTABLES as R, POSIX_SHELL_WRAPPERS as S, extractShellWrapperInlineCommand as T, splitShellArgs as U, resolveCarrierCommandArgv as V, DEFAULT_SAFE_BINS as W, resolvePolicyTargetCandidatePath as _, validateSafeBinArgv as a, resolveExecutablePath as b, matchAllowlist as c, resolveApprovalAuditCandidatePath as d, resolveCommandResolution as f, resolvePolicyAllowlistCandidatePath as g, resolveExecutionTargetResolution as h, normalizeTrustedSafeBinDirs as i, POSIX_INLINE_COMMAND_FLAGS as j, resolveShellWrapperTransportArgv as k, parseExecArgvToken as l, resolveExecutionTargetCandidatePath as m, isTrustedSafeBinPath as n, listRiskyConfiguredSafeBins as o, resolveCommandResolutionFromArgv as p, resolveSafeBinProfiles as q, listWritableExplicitTrustedSafeBinDirs as r, normalizeSafeBinName as s, getTrustedSafeBinDirs as t, resolveAllowlistCandidatePath as u, resolvePolicyTargetResolution as v, extractShellWrapperCommand as w, resolveExecWrapperTrustPlan as x, resolveExecutableFromPathEnv as y, isEnvAssignmentToken as z };
