import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { C as COMMAND_CARRIER_EXECUTABLES, D as resolveCarrierCommandArgv, E as parseEnvInvocationPrelude, O as normalizeExecutableToken, S as unwrapKnownDispatchWrapperInvocation, T as isEnvAssignmentToken, a as extractShellWrapperInlineCommand, c as isShellWrapperExecutable, f as POSIX_INLINE_COMMAND_FLAGS, g as resolveInlineCommandMatch, k as splitShellArgs, w as SOURCE_EXECUTABLES } from "./shell-wrapper-resolution-CehhL5X5.js";
//#region src/infra/command-analysis/inline-eval.ts
const FLAG_INTERPRETER_INLINE_EVAL_SPECS = [
	{
		names: [
			"python",
			"python2",
			"python3",
			"pypy",
			"pypy3"
		],
		exactFlags: new Set(["-c"])
	},
	{
		names: [
			"node",
			"nodejs",
			"bun",
			"deno"
		],
		exactFlags: new Set([
			"-e",
			"--eval",
			"-p",
			"--print"
		])
	},
	{
		names: [
			"awk",
			"gawk",
			"mawk",
			"nawk"
		],
		exactFlags: new Set(["-e", "--source"]),
		prefixFlags: [{
			label: "--source",
			prefix: "--source="
		}]
	},
	{
		names: ["ruby"],
		exactFlags: new Set(["-e"])
	},
	{
		names: ["perl"],
		exactFlags: new Set(["-e", "-E"])
	},
	{
		names: ["php"],
		exactFlags: new Set(["-r"])
	},
	{
		names: ["lua"],
		exactFlags: new Set(["-e"])
	},
	{
		names: ["osascript"],
		exactFlags: new Set(["-e"])
	},
	{
		names: ["find"],
		exactFlags: new Set([
			"-exec",
			"-execdir",
			"-ok",
			"-okdir"
		]),
		scanPastDoubleDash: true
	},
	{
		names: ["make", "gmake"],
		exactFlags: new Set([
			"-f",
			"--file",
			"--makefile",
			"--eval"
		]),
		rawExactFlags: new Map([["-E", "-E"]]),
		rawPrefixFlags: [{
			label: "-E",
			prefix: "-E"
		}],
		prefixFlags: [
			{
				label: "-f",
				prefix: "-f"
			},
			{
				label: "--file",
				prefix: "--file="
			},
			{
				label: "--makefile",
				prefix: "--makefile="
			},
			{
				label: "--eval",
				prefix: "--eval="
			}
		]
	},
	{
		names: ["sed", "gsed"],
		exactFlags: /* @__PURE__ */ new Set(),
		rawExactFlags: new Map([["-e", "-e"]]),
		rawPrefixFlags: [{
			label: "-e",
			prefix: "-e"
		}]
	}
];
const POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS = [
	{
		names: [
			"awk",
			"gawk",
			"mawk",
			"nawk"
		],
		fileFlags: new Set(["-f", "--file"]),
		fileFlagPrefixes: ["-f", "--file="],
		exactValueFlags: new Set([
			"-f",
			"--file",
			"-F",
			"--field-separator",
			"-v",
			"--assign",
			"-i",
			"--include",
			"-l",
			"--load",
			"-W"
		]),
		prefixValueFlags: [
			"-F",
			"--field-separator=",
			"-v",
			"--assign=",
			"--include=",
			"--load="
		],
		flag: "<program>"
	},
	{
		names: ["xargs"],
		exactValueFlags: new Set([
			"-a",
			"--arg-file",
			"-d",
			"--delimiter",
			"-E",
			"-I",
			"-L",
			"--max-lines",
			"-n",
			"--max-args",
			"-P",
			"--max-procs",
			"-s",
			"--max-chars"
		]),
		exactOptionalValueFlags: new Set(["--eof", "--replace"]),
		prefixValueFlags: [
			"-a",
			"--arg-file=",
			"-d",
			"--delimiter=",
			"-E",
			"--eof=",
			"-I",
			"--replace=",
			"-i",
			"-L",
			"--max-lines=",
			"-l",
			"-n",
			"--max-args=",
			"-P",
			"--max-procs=",
			"-s",
			"--max-chars="
		],
		flag: "<command>"
	},
	{
		names: ["sed", "gsed"],
		fileFlags: new Set(["-f", "--file"]),
		fileFlagPrefixes: ["-f", "--file="],
		exactValueFlags: new Set([
			"-f",
			"--file",
			"-l",
			"--line-length"
		]),
		exactOptionalValueFlags: new Set(["-i", "--in-place"]),
		prefixValueFlags: [
			"-f",
			"--file=",
			"--in-place=",
			"--line-length="
		],
		flag: "<program>"
	}
];
const INTERPRETER_ALLOWLIST_NAMES = new Set(FLAG_INTERPRETER_INLINE_EVAL_SPECS.flatMap((entry) => entry.names).concat(POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS.flatMap((entry) => entry.names)));
function findInterpreterSpec(executable) {
	const normalized = normalizeExecutableToken(executable);
	for (const spec of FLAG_INTERPRETER_INLINE_EVAL_SPECS) if (spec.names.includes(normalized)) return spec;
	return null;
}
function findPositionalInterpreterSpec(executable) {
	const normalized = normalizeExecutableToken(executable);
	for (const spec of POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS) if (spec.names.includes(normalized)) return spec;
	return null;
}
function createInlineEvalHit(executable, argv, flag) {
	return {
		executable,
		normalizedExecutable: normalizeExecutableToken(executable),
		flag,
		argv
	};
}
function detectInterpreterInlineEvalArgv(argv) {
	if (!Array.isArray(argv) || argv.length === 0) return null;
	const executable = argv[0]?.trim();
	if (!executable) return null;
	const spec = findInterpreterSpec(executable);
	if (spec) for (let idx = 1; idx < argv.length; idx += 1) {
		const token = argv[idx]?.trim();
		if (!token) continue;
		if (token === "--") {
			if (spec.scanPastDoubleDash) continue;
			break;
		}
		const rawExactFlag = spec.rawExactFlags?.get(token);
		if (rawExactFlag) return createInlineEvalHit(executable, argv, rawExactFlag);
		const rawPrefixFlag = spec.rawPrefixFlags?.find(({ prefix }) => token.startsWith(prefix) && token.length > prefix.length);
		if (rawPrefixFlag) return createInlineEvalHit(executable, argv, rawPrefixFlag.label);
		const lower = normalizeLowercaseStringOrEmpty(token);
		if (spec.exactFlags.has(lower)) return createInlineEvalHit(executable, argv, lower);
		const prefixFlag = spec.prefixFlags?.find(({ prefix }) => lower.startsWith(prefix) && lower.length > prefix.length);
		if (prefixFlag) return createInlineEvalHit(executable, argv, prefixFlag.label);
	}
	const positionalSpec = findPositionalInterpreterSpec(executable);
	if (!positionalSpec) return null;
	for (let idx = 1; idx < argv.length; idx += 1) {
		const token = argv[idx]?.trim();
		if (!token) continue;
		if (token === "--") {
			if (!argv[idx + 1]?.trim()) return null;
			return createInlineEvalHit(executable, argv, positionalSpec.flag);
		}
		if (positionalSpec.fileFlags?.has(token)) return null;
		if (positionalSpec.fileFlagPrefixes?.some((prefix) => token.startsWith(prefix) && token.length > prefix.length)) return null;
		if (positionalSpec.exactValueFlags?.has(token)) {
			idx += 1;
			continue;
		}
		if (positionalSpec.exactOptionalValueFlags?.has(token)) continue;
		if (positionalSpec.prefixValueFlags?.some((prefix) => token.startsWith(prefix) && token.length > prefix.length)) continue;
		if (token.startsWith("-")) continue;
		return createInlineEvalHit(executable, argv, positionalSpec.flag);
	}
	return null;
}
function describeInterpreterInlineEval(hit) {
	if (hit.flag === "<command>") return `${hit.normalizedExecutable} inline command`;
	if (hit.flag === "<program>") return `${hit.normalizedExecutable} inline program`;
	return `${hit.normalizedExecutable} ${hit.flag}`;
}
function isInterpreterLikeAllowlistPattern(pattern) {
	const trimmed = normalizeLowercaseStringOrEmpty(pattern);
	if (!trimmed) return false;
	const normalized = normalizeExecutableToken(trimmed);
	if (INTERPRETER_ALLOWLIST_NAMES.has(normalized)) return true;
	const basename = trimmed.replace(/\\/g, "/").split("/").pop() ?? trimmed;
	const strippedWildcards = (basename.endsWith(".exe") ? basename.slice(0, -4) : basename).replace(/[*?[\]{}()]/g, "");
	return INTERPRETER_ALLOWLIST_NAMES.has(strippedWildcards);
}
//#endregion
//#region src/infra/command-analysis/risks.ts
function commandArgvKey(argv) {
	return argv.join("\0");
}
function isCommandCarrierExecutable(executable, options) {
	return COMMAND_CARRIER_EXECUTABLES.has(executable) || Boolean(options?.includeExec && executable === "exec");
}
function buildCommandPayloadCandidates(argv, seenArgv = /* @__PURE__ */ new Set()) {
	const key = commandArgvKey(argv);
	if (seenArgv.has(key)) return argv.length > 0 ? [argv.join(" ")] : [];
	seenArgv.add(key);
	const assignmentStrippedArgv = stripLeadingEnvAssignments(argv);
	const carriedArgv = resolveCarrierCommandArgv(assignmentStrippedArgv, 0, { includeExec: true });
	const executableArgv = carriedArgv ?? assignmentStrippedArgv;
	const carriedCandidates = carriedArgv ? buildCommandPayloadCandidates(carriedArgv, seenArgv) : [];
	const shellWrapperPayload = extractShellWrapperInlineCommand(executableArgv);
	const shellWrapperCandidates = shellWrapperPayload ? (() => {
		const innerArgv = splitShellArgs(shellWrapperPayload);
		return innerArgv ? buildCommandPayloadCandidates(innerArgv, seenArgv) : [shellWrapperPayload];
	})() : [];
	return uniqueCommandPayloadCandidates([
		...executableArgv.length > 0 ? [executableArgv.join(" ")] : [],
		...carriedCandidates,
		...shellWrapperCandidates
	]);
}
function stripLeadingEnvAssignments(argv) {
	let index = 0;
	while (index < argv.length && isEnvAssignmentToken(argv[index] ?? "")) index += 1;
	return index > 0 ? argv.slice(index) : argv;
}
function uniqueCommandPayloadCandidates(candidates) {
	return [...new Set(candidates.filter((candidate) => candidate.trim().length > 0))];
}
function normalizeShellPositionalToken(token) {
	const match = (token.length >= 2 && token.startsWith("\"") && token.endsWith("\"") ? token.slice(1, -1) : token).match(/^\$(?:([0-9@*])|\{([0-9@*])\})$/u);
	const value = match?.[1] ?? match?.[2];
	if (value === void 0) return null;
	if (value === "@") return { kind: "all" };
	if (value === "*") return { kind: "star" };
	if (value === "0") return { kind: "zero" };
	return {
		kind: "index",
		index: Number.parseInt(value, 10)
	};
}
function resolveShellPositionalCarrierPlan(command) {
	const trimmed = command.trim();
	if (trimmed.length === 0) return null;
	const shellWhitespace = String.raw`[^\S\r\n]+`;
	const positionalZero = String.raw`(?:\$(?:0|\{0\})|"\$(?:0|\{0\})")`;
	const positionalArg = String.raw`(?:\$(?:[@*]|[1-9]|\{[@*1-9]\})|"\$(?:[@*]|[1-9]|\{[@*1-9]\})")`;
	if (!new RegExp(`^(?:exec${shellWhitespace}(?:--${shellWhitespace})?)?${positionalZero}(?:${shellWhitespace}${positionalArg})*$`, "u").test(trimmed)) return null;
	const tokens = trimmed.match(/"[^"]*"|\S+/gu) ?? [];
	let index = 0;
	if (tokens[index] === "exec") {
		index += 1;
		if (tokens[index] === "--") index += 1;
	}
	if (normalizeShellPositionalToken(tokens[index] ?? "")?.kind !== "zero") return null;
	index += 1;
	const indexes = [0];
	for (; index < tokens.length; index += 1) {
		const positional = normalizeShellPositionalToken(tokens[index] ?? "");
		if (positional === null || positional.kind === "zero" || positional.kind === "star") return null;
		if (positional.kind === "all") return { kind: "all" };
		if (positional.kind === "index") indexes.push(positional.index);
	}
	return {
		kind: "indexes",
		indexes
	};
}
function resolveShellPositionalCarrierArgv(params) {
	const positionalArgv = params.executableArgv.slice(params.valueTokenIndex + 1);
	return (params.plan.kind === "all" ? positionalArgv : params.plan.indexes.map((index) => positionalArgv[index] ?? "")).map((token) => token.trim()).filter((token) => token.length > 0);
}
function detectShellPositionalCarrierInlineEvalArgvInternal(argv, seenArgv) {
	const executableArgv = stripLeadingEnvAssignments(argv);
	const executable = normalizeExecutableToken(executableArgv[0] ?? "");
	if (!isShellWrapperExecutable(executable)) return null;
	if (![
		"ash",
		"bash",
		"dash",
		"fish",
		"ksh",
		"sh",
		"zsh"
	].includes(executable)) return null;
	const key = commandArgvKey(executableArgv);
	if (seenArgv.has(key)) return null;
	seenArgv.add(key);
	const inlineMatch = resolveInlineCommandMatch(executableArgv, POSIX_INLINE_COMMAND_FLAGS, { allowCombinedC: true });
	if (inlineMatch.valueTokenIndex === null || !inlineMatch.command) return null;
	const carrierPlan = resolveShellPositionalCarrierPlan(inlineMatch.command);
	if (!carrierPlan) return null;
	const carriedArgv = resolveShellPositionalCarrierArgv({
		executableArgv,
		valueTokenIndex: inlineMatch.valueTokenIndex,
		plan: carrierPlan
	});
	if (carriedArgv.length === 0) return null;
	return detectInlineEvalArgvInternal(carriedArgv, seenArgv);
}
function detectCarrierInlineEvalArgvInternal(argv, seenArgv) {
	const executableArgv = stripLeadingEnvAssignments(argv);
	const key = commandArgvKey(executableArgv);
	if (seenArgv.has(key)) return null;
	seenArgv.add(key);
	const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(executableArgv);
	if (dispatchUnwrap.kind === "unwrapped") return detectInlineEvalArgvInternal(dispatchUnwrap.argv, seenArgv);
	if (!isCommandCarrierExecutable(normalizeExecutableToken(executableArgv[0] ?? ""), { includeExec: true })) return null;
	const carriedArgv = resolveCarrierCommandArgv(executableArgv, 0, { includeExec: true });
	if (!carriedArgv) return null;
	return detectInlineEvalArgvInternal(carriedArgv, seenArgv);
}
function detectCarrierInlineEvalArgv(argv) {
	return detectCarrierInlineEvalArgvInternal(argv, /* @__PURE__ */ new Set());
}
function detectInlineEvalArgvInternal(argv, seenArgv) {
	if (!Array.isArray(argv)) return null;
	return detectInterpreterInlineEvalArgv(argv) ?? detectShellPositionalCarrierInlineEvalArgvInternal(argv, seenArgv) ?? detectCarrierInlineEvalArgvInternal(argv, seenArgv);
}
function detectInlineEvalArgv(argv) {
	return detectInlineEvalArgvInternal(argv, /* @__PURE__ */ new Set());
}
function detectInlineEvalInSegments(segments) {
	for (const segment of segments) {
		const hit = detectInlineEvalArgv(segment.resolution?.effectiveArgv ?? segment.argv) ?? detectInlineEvalArgv(segment.argv);
		if (hit) return hit;
	}
	return null;
}
function detectCommandCarrierArgv(argv) {
	const executable = argv[0];
	if (!executable) return [];
	const normalizedExecutable = normalizeExecutableToken(executable);
	const hits = [];
	if (normalizedExecutable === "find") {
		const flag = argv.find((arg) => [
			"-exec",
			"-execdir",
			"-ok",
			"-okdir"
		].includes(arg));
		if (flag) hits.push({
			command: executable,
			flag
		});
	}
	if (normalizedExecutable === "xargs") hits.push({ command: normalizedExecutable });
	const splitStringFlag = detectEnvSplitStringFlag(argv);
	if (splitStringFlag) hits.push({
		command: normalizedExecutable,
		flag: splitStringFlag
	});
	return hits;
}
function detectEnvSplitStringFlag(argv) {
	if (normalizeExecutableToken(argv[0] ?? "") !== "env") return null;
	const parsed = parseEnvInvocationPrelude(argv);
	if (!parsed?.splitArgv) return null;
	for (const arg of argv.slice(1, parsed.commandIndex)) {
		const token = arg.trim();
		if (token === "-S" || token === "-s") return token;
		if (token === "--split-string") return "--split-string";
		if (token.startsWith("--split-string=") || token.startsWith("-S") && token.length > 2) return token.startsWith("--") ? "--split-string" : "-S";
		if (token.startsWith("-") && !token.startsWith("--")) for (const option of token.slice(1)) {
			if (option === "S") return "-S";
			if (option === "s") return "-s";
		}
	}
	return null;
}
function detectShellWrapperThroughCarrierArgv(argv, shellCommandFlag) {
	const executable = normalizeExecutableToken(argv[0] ?? "");
	if (!isCommandCarrierExecutable(executable, { includeExec: true })) return null;
	const carriedArgv = resolveCarrierCommandArgv(argv, 0, { includeExec: true });
	if (!carriedArgv) return null;
	if (isShellWrapperExecutable(carriedArgv[0] ?? "") && shellCommandFlag(carriedArgv, 1)) return executable;
	return detectShellWrapperThroughCarrierArgv(carriedArgv, shellCommandFlag) ? executable : null;
}
function detectCarriedShellBuiltinArgv(argv) {
	if (!isCommandCarrierExecutable(normalizeExecutableToken(argv[0] ?? ""), { includeExec: true })) return null;
	const carriedArgv = resolveCarrierCommandArgv(argv, 0, { includeExec: true });
	if (!carriedArgv) return null;
	const nestedCarrierHit = detectCarriedShellBuiltinArgv(carriedArgv);
	if (nestedCarrierHit) return nestedCarrierHit;
	const carriedCommand = carriedArgv[0];
	const normalizedCarriedCommand = carriedCommand ? normalizeExecutableToken(carriedCommand) : void 0;
	if (normalizedCarriedCommand === "eval") return { kind: "eval" };
	if (normalizedCarriedCommand && SOURCE_EXECUTABLES.has(normalizedCarriedCommand)) return {
		kind: "source",
		command: normalizedCarriedCommand
	};
	return null;
}
//#endregion
export { detectInlineEvalArgv as a, describeInterpreterInlineEval as c, detectCommandCarrierArgv as i, isInterpreterLikeAllowlistPattern as l, detectCarriedShellBuiltinArgv as n, detectInlineEvalInSegments as o, detectCarrierInlineEvalArgv as r, detectShellWrapperThroughCarrierArgv as s, buildCommandPayloadCandidates as t };
