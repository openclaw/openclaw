import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import path from "node:path";
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
const SOURCE_EXECUTABLES = new Set([".", "source"]);
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
function expandPowerShellSwitchPrefixForms(match, smallestMatch) {
	const forms = [];
	for (let length = smallestMatch.length; length <= match.length; length += 1) {
		const prefix = match.slice(0, length);
		forms.push(`-${prefix}`, `--${prefix}`, `/${prefix}`);
	}
	return forms;
}
function expandPowerShellSwitchForms(names) {
	return names.flatMap((name) => {
		const normalized = normalizeLowercaseStringOrEmpty(name);
		return [
			`-${normalized}`,
			`--${normalized}`,
			`/${normalized}`
		];
	});
}
const POWERSHELL_COMMAND_FLAGS = [
	...expandPowerShellSwitchPrefixForms("command", "c"),
	...expandPowerShellSwitchPrefixForms("commandwithargs", "cwa"),
	...expandPowerShellSwitchForms(["cwa"])
];
const POWERSHELL_FILE_FLAGS = expandPowerShellSwitchPrefixForms("file", "f");
const POWERSHELL_INLINE_FILE_FLAGS = new Set(POWERSHELL_FILE_FLAGS);
const POWERSHELL_INLINE_COMMAND_FLAGS = new Set([
	...POWERSHELL_COMMAND_FLAGS,
	...POWERSHELL_FILE_FLAGS,
	...expandPowerShellSwitchPrefixForms("encodedcommand", "e"),
	...expandPowerShellSwitchPrefixForms("ec", "e")
]);
const POWERSHELL_INLINE_REST_COMMAND_FLAGS = new Set(POWERSHELL_COMMAND_FLAGS);
const POWERSHELL_OPTIONS_WITH_SEPARATE_VALUES = new Set([
	...expandPowerShellSwitchPrefixForms("configurationfile", "conf"),
	...expandPowerShellSwitchPrefixForms("configurationname", "config"),
	...expandPowerShellSwitchPrefixForms("custompipename", "cus"),
	...expandPowerShellSwitchPrefixForms("encodedarguments", "encodeda"),
	...expandPowerShellSwitchPrefixForms("executionpolicy", "ex"),
	...expandPowerShellSwitchPrefixForms("inputformat", "inp"),
	...expandPowerShellSwitchPrefixForms("outputformat", "o"),
	...expandPowerShellSwitchPrefixForms("psconsolefile", "pscf"),
	...expandPowerShellSwitchPrefixForms("settingsfile", "settings"),
	...expandPowerShellSwitchPrefixForms("token", "to"),
	...expandPowerShellSwitchPrefixForms("utctimestamp", "utc"),
	...expandPowerShellSwitchPrefixForms("version", "v"),
	...expandPowerShellSwitchPrefixForms("windowstyle", "w"),
	...expandPowerShellSwitchPrefixForms("workingdirectory", "w"),
	...expandPowerShellSwitchForms([
		"ea",
		"ep",
		"if",
		"of",
		"wd"
	])
]);
const POSIX_SHELL_OPTIONS_WITH_SEPARATE_VALUES = new Set([
	"--init-file",
	"--rcfile",
	"-O",
	"-o",
	"+O",
	"+o"
]);
function isCombinedCommandFlag(token) {
	return parseCombinedCommandFlag(token) !== null;
}
function countSeparateValueOptionChars(token) {
	let count = 0;
	for (let index = 1; index < token.length; index += 1) {
		const char = token[index];
		if (char === "o" || char === "O") count += 1;
	}
	return count;
}
function parseCombinedCommandFlag(token) {
	if (token.length < 2 || token[0] !== "-" || token[1] === "-") return null;
	const optionChars = token.slice(1);
	const commandFlagIndex = optionChars.indexOf("c");
	if (commandFlagIndex === -1 || optionChars.includes("-")) return null;
	const suffix = optionChars.slice(commandFlagIndex + 1);
	if (suffix && !/^[A-Za-z]+$/.test(suffix)) return {
		attachedCommand: suffix,
		separateValueCount: 0
	};
	return {
		attachedCommand: null,
		separateValueCount: countSeparateValueOptionChars(token)
	};
}
function combinedSeparateValueOptionCount(token) {
	if (token.length < 2 || token[0] !== "-" && token[0] !== "+" || token[1] === "-" || token.slice(1).includes("-")) return 0;
	return countSeparateValueOptionChars(token);
}
function consumesSeparateValue(token) {
	return POSIX_SHELL_OPTIONS_WITH_SEPARATE_VALUES.has(token);
}
function isPosixInteractiveModeOption(token) {
	return token === "--interactive" || isPosixShortOption(token, "i");
}
function isPosixShortOption(token, option) {
	if (token.length < 2 || token[0] !== "-" || token[1] === "-") return false;
	let hasOption = false;
	for (let index = 1; index < token.length; index += 1) {
		const char = token[index];
		if (char === "-") return false;
		if (char === option) hasOption = true;
	}
	return hasOption;
}
function advancePosixInlineOptionScan(token) {
	const combinedValueCount = combinedSeparateValueOptionCount(token);
	if (combinedValueCount > 0) return 1 + combinedValueCount;
	if (consumesSeparateValue(token)) return 2;
	return 1;
}
function isPowerShellOptionToken(token) {
	return token.startsWith("-") || /^\/[A-Za-z][A-Za-z0-9]*$/.test(token);
}
function resolveInlineCommandMatch(argv, flags, options = {}) {
	for (let i = 1; i < argv.length;) {
		const token = argv[i]?.trim();
		if (!token) {
			i += 1;
			continue;
		}
		const lower = normalizeLowercaseStringOrEmpty(token);
		if (lower === "--") break;
		const comparableToken = options.allowCombinedC ? token : lower;
		if (flags.has(comparableToken)) {
			const valueTokenIndex = i + 1 < argv.length ? i + 1 : null;
			if (options.restValueFlags?.has(comparableToken)) {
				const command = argv.slice(i + 1).map((arg) => arg.trim()).join(" ").trim();
				return {
					command: command ? command : null,
					valueTokenIndex
				};
			}
			const command = argv[i + 1]?.trim();
			return {
				command: command ? command : null,
				valueTokenIndex
			};
		}
		if (options.allowCombinedC && isCombinedCommandFlag(token)) {
			const combined = parseCombinedCommandFlag(token);
			if (combined?.attachedCommand != null) return {
				command: combined.attachedCommand.trim() || null,
				valueTokenIndex: i
			};
			const valueTokenIndex = i + 1 + (combined?.separateValueCount ?? 0);
			const command = argv[valueTokenIndex]?.trim();
			return {
				command: command ? command : null,
				valueTokenIndex
			};
		}
		if (options.valueOptions?.has(lower)) {
			i += 2;
			continue;
		}
		const isOptionToken = options.isOptionToken?.(token) ?? (token.startsWith("-") || token.startsWith("+"));
		if (options.stopAtFirstNonOption && !isOptionToken) break;
		if (options.allowCombinedC && !token.startsWith("-") && !token.startsWith("+")) break;
		i += options.allowCombinedC ? advancePosixInlineOptionScan(token) : 1;
	}
	return {
		command: null,
		valueTokenIndex: null
	};
}
function resolvePowerShellInlineCommandMatch(argv) {
	return resolveInlineCommandMatch(argv, POWERSHELL_INLINE_COMMAND_FLAGS, {
		isOptionToken: isPowerShellOptionToken,
		restValueFlags: POWERSHELL_INLINE_REST_COMMAND_FLAGS,
		stopAtFirstNonOption: true,
		valueOptions: POWERSHELL_OPTIONS_WITH_SEPARATE_VALUES
	});
}
function isPowerShellInlineRestCommandFlag(token) {
	return POWERSHELL_INLINE_REST_COMMAND_FLAGS.has(normalizeLowercaseStringOrEmpty(token));
}
function isPowerShellInlineFileCommandFlag(token) {
	return POWERSHELL_INLINE_FILE_FLAGS.has(normalizeLowercaseStringOrEmpty(token));
}
function hasPosixInteractiveStartupBeforeInlineCommand(argv, flags) {
	let sawInteractiveMode = false;
	for (let i = 1; i < argv.length;) {
		const token = argv[i]?.trim();
		if (!token) {
			i += 1;
			continue;
		}
		if (token === "--") return false;
		if (isPosixInteractiveModeOption(token)) sawInteractiveMode = true;
		if (flags.has(token) || isCombinedCommandFlag(token)) return sawInteractiveMode;
		if (!token.startsWith("-") && !token.startsWith("+")) return false;
		i += advancePosixInlineOptionScan(token);
	}
	return false;
}
function hasPosixLoginStartupBeforeInlineCommand(argv, flags) {
	let sawLoginMode = false;
	for (let i = 1; i < argv.length;) {
		const token = argv[i]?.trim();
		if (!token) {
			i += 1;
			continue;
		}
		if (token === "--") return false;
		if (token === "--login" || isPosixShortOption(token, "l")) sawLoginMode = true;
		if (flags.has(token) || isCombinedCommandFlag(token)) return sawLoginMode;
		if (!token.startsWith("-") && !token.startsWith("+")) return false;
		i += advancePosixInlineOptionScan(token);
	}
	return false;
}
function hasFishInitCommandOption(argv) {
	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]?.trim();
		if (!token) continue;
		if (token === "--") return false;
		if (token === "-C" || token === "--init-command" || token.startsWith("-C") && token !== "-C" || token.startsWith("--init-command=")) return true;
		if (!token.startsWith("-") && !token.startsWith("+")) return false;
	}
	return false;
}
function hasFishAttachedCommandOption(argv) {
	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]?.trim();
		if (!token) continue;
		if (token === "--") return false;
		if (token.startsWith("-c") && token !== "-c") return true;
		if (!token.startsWith("-") && !token.startsWith("+")) return false;
	}
	return false;
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
const LOGIN_STARTUP_SHELL_WRAPPER_CANONICAL = new Set(POSIX_SHELL_WRAPPER_NAMES);
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
		return token === "/c" || token === "/k" || token === "-c" || token === "-k";
	});
	if (idx === -1) return null;
	const tail = argv.slice(idx + 1);
	if (tail.length === 0) return null;
	const cmd = tail.join(" ").trim();
	return cmd.length > 0 ? cmd : null;
}
function extractPowerShellInlineCommand(argv) {
	return resolvePowerShellInlineCommandMatch(argv).command;
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
function isLegacyLoginInlineForm(argv) {
	return argv[1]?.trim() === "-lc";
}
function isLegacyShLoginInlineForm(argv, baseExecutable) {
	return baseExecutable === "sh" && isLegacyLoginInlineForm(argv);
}
function formatShellWrapperArgv(argv) {
	return argv.map((arg) => {
		if (arg.length === 0) return "\"\"";
		return /\s|"/.test(arg) ? `"${arg.replace(/"/g, "\\\"")}"` : arg;
	}).join(" ");
}
function startupWrapperRequiresFullArgv(params) {
	if (params.spec.kind !== "posix") return false;
	if (params.baseExecutable === "fish" && hasFishInitCommandOption(params.argv)) return true;
	if (LOGIN_STARTUP_SHELL_WRAPPER_CANONICAL.has(params.baseExecutable) && hasPosixLoginStartupBeforeInlineCommand(params.argv, POSIX_INLINE_COMMAND_FLAGS)) return params.includeLegacyLoginInlineForm || !isLegacyShLoginInlineForm(params.argv, params.baseExecutable);
	return hasPosixInteractiveStartupBeforeInlineCommand(params.argv, POSIX_INLINE_COMMAND_FLAGS);
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
	const candidate = resolveShellWrapperCandidate({
		argv,
		depth,
		state: null
	});
	if (!candidate) return {
		isWrapper: false,
		command: null
	};
	const baseExecutable = normalizeExecutableToken(candidate.token0);
	const wrapper = findShellWrapperSpec(baseExecutable);
	if (!wrapper) return {
		isWrapper: false,
		command: null
	};
	const payload = extractShellWrapperPayload(candidate.argv, wrapper);
	if (!payload) return {
		isWrapper: false,
		command: null
	};
	if (wrapper.kind === "posix" && baseExecutable === "fish" && hasFishAttachedCommandOption(candidate.argv)) return {
		isWrapper: true,
		command: null
	};
	const rawMatchesPayload = rawCommand === payload;
	const rawMatchesCanonicalArgv = rawCommand === formatShellWrapperArgv(candidate.argv);
	const allowLegacyShLoginPayloadBinding = isLegacyShLoginInlineForm(candidate.argv, baseExecutable) && (rawMatchesPayload || rawMatchesCanonicalArgv);
	if (startupWrapperRequiresFullArgv({
		argv: candidate.argv,
		spec: wrapper,
		baseExecutable,
		includeLegacyLoginInlineForm: !allowLegacyShLoginPayloadBinding
	})) return {
		isWrapper: true,
		command: null
	};
	const resolved = resolveShellWrapperSpecAndArgvInternal(candidate.argv, depth);
	if (!resolved) return {
		isWrapper: false,
		command: null
	};
	return {
		isWrapper: true,
		command: rawMatchesCanonicalArgv ? resolved.payload : rawCommand ?? resolved.payload
	};
}
function resolveShellWrapperTransportArgv(argv) {
	return resolveShellWrapperSpecAndArgvInternal(argv, 0)?.argv ?? null;
}
function extractShellWrapperInlineCommand(argv) {
	return resolveShellWrapperSpecAndArgvInternal(argv, 0)?.payload ?? null;
}
function extractBindableShellWrapperInlineCommand(argv, rawCommand) {
	return extractShellWrapperCommandInternal(argv, normalizeRawCommand(rawCommand), 0).command;
}
function extractShellWrapperCommand(argv, rawCommand) {
	return extractShellWrapperCommandInternal(argv, normalizeRawCommand(rawCommand), 0);
}
function isBlockedShellWrapperCommand(argv, rawCommand) {
	const extracted = extractShellWrapperCommandInternal(argv, normalizeRawCommand(rawCommand), 0);
	return extracted.isWrapper && extracted.command === null;
}
//#endregion
export { COMMAND_CARRIER_EXECUTABLES as C, resolveCarrierCommandArgv as D, parseEnvInvocationPrelude as E, normalizeExecutableToken as O, unwrapKnownDispatchWrapperInvocation as S, isEnvAssignmentToken as T, resolvePowerShellInlineCommandMatch as _, extractShellWrapperInlineCommand as a, resolveDispatchWrapperTrustPlan as b, isShellWrapperExecutable as c, unwrapKnownShellMultiplexerInvocation as d, POSIX_INLINE_COMMAND_FLAGS as f, resolveInlineCommandMatch as g, isPowerShellInlineRestCommandFlag as h, extractShellWrapperCommand as i, splitShellArgs as k, isShellWrapperInvocation as l, isPowerShellInlineFileCommandFlag as m, POWERSHELL_WRAPPERS as n, hasEnvManipulationBeforeShellWrapper as o, advancePosixInlineOptionScan as p, extractBindableShellWrapperInlineCommand as r, isBlockedShellWrapperCommand as s, POSIX_SHELL_WRAPPERS as t, resolveShellWrapperTransportArgv as u, extractEnvAssignmentKeysFromDispatchWrappers as v, SOURCE_EXECUTABLES as w, unwrapDispatchWrappersForResolution as x, isDispatchWrapperExecutable as y };
