import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { t as expandHomePrefix } from "./home-dir-iZwpu-40.js";
import { C as DEFAULT_SAFE_BINS, S as resolveExecWrapperTrustPlan, _ as resolvePolicyTargetCandidatePath, a as validateSafeBinArgv, c as matchAllowlist, h as resolveExecutionTargetResolution, m as resolveExecutionTargetCandidatePath, n as isTrustedSafeBinPath, p as resolveCommandResolutionFromArgv, v as resolvePolicyTargetResolution, w as SAFE_BIN_PROFILES } from "./exec-safe-bin-trust-C58pNRL_.js";
import { E as splitShellArgs, T as normalizeExecutableToken, c as isShellWrapperExecutable, f as POSIX_INLINE_COMMAND_FLAGS, g as isDispatchWrapperExecutable, m as resolveInlineCommandMatch, n as POWERSHELL_WRAPPERS, r as extractBindableShellWrapperInlineCommand } from "./shell-wrapper-resolution-CN1bWvVT.js";
import { a as detectInlineEvalArgv, l as isInterpreterLikeAllowlistPattern } from "./risks-Bk6GvAYC.js";
import path from "node:path";
//#region src/infra/exec-approvals-analysis.ts
const DISALLOWED_PIPELINE_TOKENS = new Set([
	">",
	"<",
	"`",
	"\n",
	"\r",
	"(",
	")"
]);
const DOUBLE_QUOTE_ESCAPES = new Set([
	"\\",
	"\"",
	"$",
	"`"
]);
const MAX_UNQUOTED_HEREDOC_CONTINUATION_LINES = 1024;
const MAX_UNQUOTED_HEREDOC_LOGICAL_LINE_LENGTH = 64 * 1024;
const WINDOWS_UNSUPPORTED_TOKENS = new Set([
	"&",
	"|",
	"<",
	">",
	"^",
	"(",
	")",
	"%",
	"!",
	"`",
	"\n",
	"\r"
]);
function isDoubleQuoteEscape(next) {
	return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}
function isEscapedLineContinuation(next) {
	return next === "\n" || next === "\r";
}
function isShellCommentStart(source, index) {
	if (source[index] !== "#") return false;
	if (index === 0) return true;
	const prev = source[index - 1];
	return Boolean(prev && /\s/.test(prev));
}
function splitShellPipeline(command) {
	const parseHeredocDelimiter = (source, start) => {
		let i = start;
		while (i < source.length && (source[i] === " " || source[i] === "	")) i += 1;
		if (i >= source.length) return null;
		const first = source[i];
		if (first === "'" || first === "\"") {
			const quote = first;
			i += 1;
			let delimiter = "";
			while (i < source.length) {
				const ch = source[i];
				if (ch === "\n" || ch === "\r") return null;
				if (quote === "\"" && ch === "\\" && i + 1 < source.length) {
					delimiter += source[i + 1];
					i += 2;
					continue;
				}
				if (ch === quote) return {
					delimiter,
					end: i + 1,
					quoted: true
				};
				delimiter += ch;
				i += 1;
			}
			return null;
		}
		let delimiter = "";
		while (i < source.length) {
			const ch = source[i];
			if (/\s/.test(ch) || ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">") break;
			delimiter += ch;
			i += 1;
		}
		if (!delimiter) return null;
		return {
			delimiter,
			end: i,
			quoted: false
		};
	};
	const segments = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let emptySegment = false;
	const pendingHeredocs = [];
	let inHeredocBody = false;
	let heredocLine = "";
	let unquotedHeredocLogicalChunks = [];
	let unquotedHeredocLogicalLength = 0;
	const pushPart = () => {
		const trimmed = buf.trim();
		if (trimmed) segments.push(trimmed);
		buf = "";
	};
	const isEscapedInHeredocLine = (line, index) => {
		let slashes = 0;
		for (let i = index - 1; i >= 0 && line[i] === "\\"; i -= 1) slashes += 1;
		return slashes % 2 === 1;
	};
	const hasUnquotedHeredocExpansionToken = (line) => {
		for (let i = 0; i < line.length; i += 1) {
			const ch = line[i];
			if (ch === "`" && !isEscapedInHeredocLine(line, i)) return true;
			if (ch === "$" && !isEscapedInHeredocLine(line, i)) {
				const next = line[i + 1];
				if (next === "(" || next === "{" || next === "[" || next !== void 0 && (/^[A-Za-z_]$/.test(next) || /^[0-9]$/.test(next) || "@*?!$#-".includes(next))) return true;
			}
		}
		return false;
	};
	const stripUnquotedHeredocLineContinuation = (line) => {
		let trailingSlashes = 0;
		for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i -= 1) trailingSlashes += 1;
		if (trailingSlashes % 2 === 1) return {
			line: line.slice(0, -1),
			continues: true
		};
		return {
			line,
			continues: false
		};
	};
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		const next = command[i + 1];
		if (inHeredocBody) {
			if (ch === "\n" || ch === "\r") {
				const current = pendingHeredocs[0];
				if (current) {
					const line = current.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
					if (current.quoted) {
						if (line === current.delimiter) pendingHeredocs.shift();
					} else if (line === current.delimiter && unquotedHeredocLogicalChunks.length === 0) pendingHeredocs.shift();
					else {
						const continued = stripUnquotedHeredocLineContinuation(line);
						unquotedHeredocLogicalChunks.push(continued.line);
						if (unquotedHeredocLogicalChunks.length > MAX_UNQUOTED_HEREDOC_CONTINUATION_LINES) return {
							ok: false,
							reason: "heredoc continuation too long",
							segments: []
						};
						unquotedHeredocLogicalLength += continued.line.length;
						if (unquotedHeredocLogicalLength > MAX_UNQUOTED_HEREDOC_LOGICAL_LINE_LENGTH) return {
							ok: false,
							reason: "heredoc logical line too large",
							segments: []
						};
						if (!continued.continues) {
							if (hasUnquotedHeredocExpansionToken(unquotedHeredocLogicalChunks.join(""))) return {
								ok: false,
								reason: "shell expansion in unquoted heredoc",
								segments: []
							};
							unquotedHeredocLogicalChunks = [];
							unquotedHeredocLogicalLength = 0;
						}
					}
				}
				heredocLine = "";
				if (pendingHeredocs.length === 0) inHeredocBody = false;
				if (ch === "\r" && next === "\n") i += 1;
			} else heredocLine += ch;
			continue;
		}
		if (escaped) {
			buf += ch;
			escaped = false;
			emptySegment = false;
			continue;
		}
		if (!inSingle && !inDouble && ch === "\\") {
			escaped = true;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && isEscapedLineContinuation(next)) return {
				ok: false,
				reason: "unsupported shell token: newline",
				segments: []
			};
			if (ch === "\\" && isDoubleQuoteEscape(next)) {
				buf += ch;
				buf += next;
				i += 1;
				emptySegment = false;
				continue;
			}
			if (ch === "$" && next === "(") return {
				ok: false,
				reason: "unsupported shell token: $()",
				segments: []
			};
			if (ch === "`") return {
				ok: false,
				reason: "unsupported shell token: `",
				segments: []
			};
			if (ch === "\n" || ch === "\r") return {
				ok: false,
				reason: "unsupported shell token: newline",
				segments: []
			};
			if (ch === "\"") inDouble = false;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			buf += ch;
			emptySegment = false;
			continue;
		}
		if (isShellCommentStart(command, i)) break;
		if ((ch === "\n" || ch === "\r") && pendingHeredocs.length > 0) {
			inHeredocBody = true;
			heredocLine = "";
			if (ch === "\r" && next === "\n") i += 1;
			continue;
		}
		if (ch === "|" && next === "|") return {
			ok: false,
			reason: "unsupported shell token: ||",
			segments: []
		};
		if (ch === "|" && next === "&") return {
			ok: false,
			reason: "unsupported shell token: |&",
			segments: []
		};
		if (ch === "|") {
			emptySegment = true;
			pushPart();
			continue;
		}
		if (ch === "&" || ch === ";") return {
			ok: false,
			reason: `unsupported shell token: ${ch}`,
			segments: []
		};
		if (ch === "<" && next === "<") {
			buf += "<<";
			emptySegment = false;
			i += 1;
			let scanIndex = i + 1;
			let stripTabs = false;
			if (command[scanIndex] === "-") {
				stripTabs = true;
				buf += "-";
				scanIndex += 1;
			}
			const parsed = parseHeredocDelimiter(command, scanIndex);
			if (parsed) {
				pendingHeredocs.push({
					delimiter: parsed.delimiter,
					stripTabs,
					quoted: parsed.quoted
				});
				buf += command.slice(scanIndex, parsed.end);
				i = parsed.end - 1;
			}
			continue;
		}
		if (DISALLOWED_PIPELINE_TOKENS.has(ch)) return {
			ok: false,
			reason: `unsupported shell token: ${ch}`,
			segments: []
		};
		if (ch === "$" && next === "(") return {
			ok: false,
			reason: "unsupported shell token: $()",
			segments: []
		};
		buf += ch;
		emptySegment = false;
	}
	if (inHeredocBody && pendingHeredocs.length > 0) {
		const current = pendingHeredocs[0];
		const line = current.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
		if (!current.quoted && unquotedHeredocLogicalChunks.length > 0) {
			const continued = stripUnquotedHeredocLineContinuation(line);
			if (hasUnquotedHeredocExpansionToken([...unquotedHeredocLogicalChunks, continued.line].join(""))) return {
				ok: false,
				reason: "shell expansion in unquoted heredoc",
				segments: []
			};
		} else if (line === current.delimiter) {
			pendingHeredocs.shift();
			unquotedHeredocLogicalChunks = [];
			unquotedHeredocLogicalLength = 0;
			if (pendingHeredocs.length === 0) inHeredocBody = false;
		}
	}
	if (pendingHeredocs.length > 0 || inHeredocBody) return {
		ok: false,
		reason: "unterminated heredoc",
		segments: []
	};
	if (escaped || inSingle || inDouble) return {
		ok: false,
		reason: "unterminated shell quote/escape",
		segments: []
	};
	pushPart();
	if (emptySegment || segments.length === 0) return {
		ok: false,
		reason: segments.length === 0 ? "empty command" : "empty pipeline segment",
		segments: []
	};
	return {
		ok: true,
		segments
	};
}
const WINDOWS_ALWAYS_UNSAFE_TOKENS = new Set([
	"\n",
	"\r",
	"%",
	"`"
]);
function findWindowsUnsupportedToken(command) {
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\"") {
			inDouble = !inDouble;
			continue;
		}
		if (ch === "$") {
			const next = command[i + 1];
			if (next !== void 0 && /[A-Za-z_{(?$]/.test(next)) return "$";
			continue;
		}
		if (WINDOWS_UNSUPPORTED_TOKENS.has(ch)) {
			if (inDouble && !WINDOWS_ALWAYS_UNSAFE_TOKENS.has(ch)) continue;
			if (ch === "\n" || ch === "\r") return "newline";
			return ch;
		}
	}
	return null;
}
function tokenizeWindowsSegment(segment) {
	const tokens = [];
	let buf = "";
	let inDouble = false;
	let inSingle = false;
	let wasQuoted = false;
	const pushToken = () => {
		if (buf.length > 0 || wasQuoted) {
			tokens.push(buf);
			buf = "";
		}
		wasQuoted = false;
	};
	for (let i = 0; i < segment.length; i += 1) {
		const ch = segment[i];
		if (ch === "\"" && !inSingle) {
			if (!inDouble) wasQuoted = true;
			inDouble = !inDouble;
			continue;
		}
		if (ch === "'" && !inDouble) {
			if (inSingle && segment[i + 1] === "'") {
				buf += "'";
				i += 1;
				continue;
			}
			if (!inSingle) wasQuoted = true;
			inSingle = !inSingle;
			continue;
		}
		if (!inDouble && !inSingle && /\s/.test(ch)) {
			pushToken();
			continue;
		}
		buf += ch;
	}
	if (inDouble || inSingle) return null;
	pushToken();
	return tokens.length > 0 ? tokens : null;
}
/**
* Recursively strip transparent Windows shell wrappers from a command string.
*
* LLMs generate commands with arbitrary nesting of shell wrappers:
*   powershell -NoProfile -Command "& node 'C:\path' --count 3"
*   cmd /c "node C:\path --count 3"
*   & node C:\path --count 3
*
* All of these should resolve to: node C:\path --count 3
*
* Recognised wrappers (applied repeatedly until stable):
*   - PowerShell call-operator: `& exe args`
*   - cmd.exe pass-through:    `cmd /c "..."` or `cmd /c ...`
*   - PowerShell invocation:   `powershell [-flags] -Command "..."`
*/
function stripWindowsShellWrapper(command) {
	const MAX_DEPTH = 5;
	let result = command;
	for (let i = 0; i < MAX_DEPTH; i++) {
		const prev = result;
		result = stripWindowsShellWrapperOnce(result.trim());
		if (result === prev) break;
	}
	return result;
}
function stripWindowsShellWrapperOnce(command) {
	const psCallMatch = command.match(/^&\s+(.+)$/s);
	if (psCallMatch) return psCallMatch[1];
	const psFlags = /(?:-(?!c(?:ommand)?\b|-command\b)\w+(?:\s+(?!-)(?:"[^"]*(?:""[^"]*)*"|'[^']*(?:''[^']*)*'|\S+))?\s+)*/i.source;
	const psCommandFlag = `(?:-command|-c|--command)`;
	const psInvokeMatch = command.match(new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+${psFlags}${psCommandFlag}\\s+"(.+)"$`, "is"));
	if (psInvokeMatch) return psInvokeMatch[1].replace(/""/g, "\"");
	const psInvokeSingleQuote = command.match(new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+${psFlags}${psCommandFlag}\\s+'(.+)'$`, "is"));
	if (psInvokeSingleQuote) return psInvokeSingleQuote[1].replace(/''/g, "'");
	const psInvokeNoQuote = command.match(new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+${psFlags}${psCommandFlag}\\s+(.+)$`, "is"));
	if (psInvokeNoQuote) return psInvokeNoQuote[1];
	return command;
}
function analyzeWindowsShellCommand(params) {
	const effective = stripWindowsShellWrapper(params.command.trim());
	const unsupported = findWindowsUnsupportedToken(effective);
	if (unsupported) return {
		ok: false,
		reason: `unsupported windows shell token: ${unsupported}`,
		segments: []
	};
	const argv = tokenizeWindowsSegment(effective);
	if (!argv || argv.length === 0) return {
		ok: false,
		reason: "unable to parse windows command",
		segments: []
	};
	return {
		ok: true,
		segments: [{
			raw: params.command,
			argv,
			resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env)
		}]
	};
}
function isWindowsPlatform(platform) {
	return normalizeLowercaseStringOrEmpty(platform).startsWith("win");
}
function parseSegmentsFromParts(parts, cwd, env) {
	const segments = [];
	for (const raw of parts) {
		const argv = splitShellArgs(raw);
		if (!argv || argv.length === 0) return null;
		segments.push({
			raw,
			argv,
			resolution: resolveCommandResolutionFromArgv(argv, cwd, env)
		});
	}
	return segments;
}
/**
* Splits a command string by chain operators (&&, ||, ;) while preserving the operators.
* Returns null when no chain is present or when the chain is malformed.
*/
function splitCommandChainWithOperators(command) {
	const parts = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let foundChain = false;
	let invalidChain = false;
	const pushPart = (opToNext) => {
		const trimmed = buf.trim();
		buf = "";
		if (!trimmed) return false;
		parts.push({
			part: trimmed,
			opToNext
		});
		return true;
	};
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		const next = command[i + 1];
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (!inSingle && !inDouble && ch === "\\") {
			escaped = true;
			buf += ch;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			buf += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && isEscapedLineContinuation(next)) {
				invalidChain = true;
				break;
			}
			if (ch === "\\" && isDoubleQuoteEscape(next)) {
				buf += ch;
				buf += next;
				i += 1;
				continue;
			}
			if (ch === "\"") inDouble = false;
			buf += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			buf += ch;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			buf += ch;
			continue;
		}
		if (isShellCommentStart(command, i)) break;
		if (ch === "&" && next === "&") {
			if (!pushPart("&&")) invalidChain = true;
			i += 1;
			foundChain = true;
			continue;
		}
		if (ch === "|" && next === "|") {
			if (!pushPart("||")) invalidChain = true;
			i += 1;
			foundChain = true;
			continue;
		}
		if (ch === ";") {
			if (!pushPart(";")) invalidChain = true;
			foundChain = true;
			continue;
		}
		buf += ch;
	}
	if (!foundChain) return null;
	const trimmed = buf.trim();
	if (!trimmed) return null;
	parts.push({
		part: trimmed,
		opToNext: null
	});
	if (invalidChain || parts.length === 0) return null;
	return parts;
}
function shellEscapeSingleArg(value) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
const WINDOWS_UNSAFE_CMD_META = /[%`]|\$(?=[A-Za-z_{(?$])/;
function windowsEscapeArg(value) {
	if (value === "") return {
		ok: true,
		escaped: "\"\""
	};
	if (WINDOWS_UNSAFE_CMD_META.test(value)) return { ok: false };
	if (/^[a-zA-Z0-9_./:~\\=-]+$/.test(value)) return {
		ok: true,
		escaped: value
	};
	return {
		ok: true,
		escaped: `"${value.replace(/"/g, "\"\"")}"`
	};
}
function rebuildWindowsShellCommandFromSource(params) {
	const source = stripWindowsShellWrapper(params.command.trim());
	if (!source) return {
		ok: false,
		reason: "empty command"
	};
	const unsupported = findWindowsUnsupportedToken(source);
	if (unsupported) return {
		ok: false,
		reason: `unsupported windows shell token: ${unsupported}`
	};
	const rendered = params.renderSegment(source, 0);
	if (!rendered.ok) return {
		ok: false,
		reason: rendered.reason
	};
	return {
		ok: true,
		command: `& ${rendered.rendered}`,
		segmentCount: 1
	};
}
function rebuildShellCommandFromSource(params) {
	if (isWindowsPlatform(params.platform ?? null)) return rebuildWindowsShellCommandFromSource(params);
	const source = params.command.trim();
	if (!source) return {
		ok: false,
		reason: "empty command"
	};
	const chainParts = splitCommandChainWithOperators(source) ?? [{
		part: source,
		opToNext: null
	}];
	let segmentCount = 0;
	let out = "";
	for (const part of chainParts) {
		const pipelineSplit = splitShellPipeline(part.part);
		if (!pipelineSplit.ok) return {
			ok: false,
			reason: pipelineSplit.reason ?? "unable to parse pipeline"
		};
		const renderedSegments = [];
		for (const segmentRaw of pipelineSplit.segments) {
			const rendered = params.renderSegment(segmentRaw, segmentCount);
			if (!rendered.ok) return {
				ok: false,
				reason: rendered.reason
			};
			renderedSegments.push(rendered.rendered);
			segmentCount += 1;
		}
		out += renderedSegments.join(" | ");
		if (part.opToNext) out += ` ${part.opToNext} `;
	}
	return {
		ok: true,
		command: out,
		segmentCount
	};
}
/**
* Builds a shell command string that preserves pipes/chaining, but forces *arguments* to be
* literal (no globbing, no env-var expansion) by single-quoting every argv token.
*
* Used to make "safe bins" actually stdin-only even though execution happens via `shell -c`.
*/
function buildSafeShellCommand(params) {
	const isWindows = isWindowsPlatform(params.platform);
	return finalizeRebuiltShellCommand(rebuildShellCommandFromSource({
		command: params.command,
		platform: params.platform,
		renderSegment: (segmentRaw) => {
			const argv = isWindows ? tokenizeWindowsSegment(segmentRaw) ?? [] : splitShellArgs(segmentRaw) ?? [];
			if (argv.length === 0) return {
				ok: false,
				reason: "unable to parse shell segment"
			};
			if (isWindows) return renderWindowsQuotedArgv(argv);
			return {
				ok: true,
				rendered: argv.map((token) => shellEscapeSingleArg(token)).join(" ")
			};
		}
	}));
}
function renderWindowsQuotedArgv(argv) {
	const parts = [];
	for (const token of argv) {
		const result = windowsEscapeArg(token);
		if (!result.ok) return {
			ok: false,
			reason: `unsafe windows token: ${token}`
		};
		parts.push(result.escaped);
	}
	return {
		ok: true,
		rendered: parts.join(" ")
	};
}
function renderQuotedArgv(argv, platform) {
	if (isWindowsPlatform(platform)) {
		const result = renderWindowsQuotedArgv(argv);
		return result.ok ? result.rendered : null;
	}
	return argv.map((token) => shellEscapeSingleArg(token)).join(" ");
}
function finalizeRebuiltShellCommand(rebuilt, expectedSegmentCount) {
	if (!rebuilt.ok) return {
		ok: false,
		reason: rebuilt.reason
	};
	if (typeof expectedSegmentCount === "number" && rebuilt.segmentCount !== expectedSegmentCount) return {
		ok: false,
		reason: "segment count mismatch"
	};
	return {
		ok: true,
		command: rebuilt.command
	};
}
function resolvePlannedSegmentArgv(segment) {
	if (segment.resolution?.policyBlocked === true) return null;
	const baseArgv = segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0 ? segment.resolution.effectiveArgv : segment.argv;
	if (baseArgv.length === 0) return null;
	const argv = [...baseArgv];
	const execution = segment.resolution?.execution;
	const resolvedExecutable = execution?.resolvedRealPath?.trim() ?? execution?.resolvedPath?.trim() ?? "";
	if (resolvedExecutable) argv[0] = resolvedExecutable;
	return argv;
}
function renderSafeBinSegmentArgv(segment, platform) {
	const argv = resolvePlannedSegmentArgv(segment);
	if (!argv || argv.length === 0) return null;
	return renderQuotedArgv(argv, platform);
}
/**
* Rebuilds a shell command and selectively single-quotes argv tokens for segments that
* must be treated as literal (safeBins hardening) while preserving the rest of the
* shell syntax (pipes + chaining).
*/
function buildSafeBinsShellCommand(params) {
	if (params.segments.length !== params.segmentSatisfiedBy.length) return {
		ok: false,
		reason: "segment metadata mismatch"
	};
	return finalizeRebuiltShellCommand(rebuildShellCommandFromSource({
		command: params.command,
		platform: params.platform,
		renderSegment: (raw, segmentIndex) => {
			const seg = params.segments[segmentIndex];
			const by = params.segmentSatisfiedBy[segmentIndex];
			if (!seg || by === void 0) return {
				ok: false,
				reason: "segment mapping failed"
			};
			if (!(by === "safeBins")) return {
				ok: true,
				rendered: raw.trim()
			};
			const rendered = renderSafeBinSegmentArgv(seg, params.platform);
			if (!rendered) return {
				ok: false,
				reason: "segment execution plan unavailable"
			};
			return {
				ok: true,
				rendered
			};
		}
	}), params.segments.length);
}
function buildEnforcedShellCommand(params) {
	return finalizeRebuiltShellCommand(rebuildShellCommandFromSource({
		command: params.command,
		platform: params.platform,
		renderSegment: (_raw, segmentIndex) => {
			const seg = params.segments[segmentIndex];
			if (!seg) return {
				ok: false,
				reason: "segment mapping failed"
			};
			const argv = resolvePlannedSegmentArgv(seg);
			if (!argv) return {
				ok: false,
				reason: "segment execution plan unavailable"
			};
			const rendered = renderQuotedArgv(argv, params.platform);
			if (!rendered) return {
				ok: false,
				reason: "unsafe windows token in argv"
			};
			return {
				ok: true,
				rendered
			};
		}
	}), params.segments.length);
}
/**
* Splits a command string by chain operators (&&, ||, ;) while respecting quotes.
* Returns null when no chain is present or when the chain is malformed.
*/
function splitCommandChain(command) {
	const parts = splitCommandChainWithOperators(command);
	if (!parts) return null;
	return parts.map((p) => p.part);
}
function analyzeShellCommand(params) {
	if (isWindowsPlatform(params.platform)) return analyzeWindowsShellCommand(params);
	const chainParts = splitCommandChain(params.command);
	if (chainParts) {
		const chains = [];
		const allSegments = [];
		for (const part of chainParts) {
			const pipelineSplit = splitShellPipeline(part);
			if (!pipelineSplit.ok) return {
				ok: false,
				reason: pipelineSplit.reason,
				segments: []
			};
			const segments = parseSegmentsFromParts(pipelineSplit.segments, params.cwd, params.env);
			if (!segments) return {
				ok: false,
				reason: "unable to parse shell segment",
				segments: []
			};
			chains.push(segments);
			allSegments.push(...segments);
		}
		return {
			ok: true,
			segments: allSegments,
			chains
		};
	}
	const split = splitShellPipeline(params.command);
	if (!split.ok) return {
		ok: false,
		reason: split.reason,
		segments: []
	};
	const segments = parseSegmentsFromParts(split.segments, params.cwd, params.env);
	if (!segments) return {
		ok: false,
		reason: "unable to parse shell segment",
		segments: []
	};
	return {
		ok: true,
		segments
	};
}
function analyzeArgvCommand(params) {
	const argv = params.argv.filter((entry) => entry.trim().length > 0);
	if (argv.length === 0) return {
		ok: false,
		reason: "empty argv",
		segments: []
	};
	return {
		ok: true,
		segments: [{
			raw: argv.join(" "),
			argv,
			resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env)
		}]
	};
}
//#endregion
//#region src/infra/exec-approvals-allowlist.ts
function hasShellLineContinuation(command) {
	return /\\(?:\r\n|\n|\r)/.test(command);
}
function normalizeSafeBins(entries) {
	if (!Array.isArray(entries)) return /* @__PURE__ */ new Set();
	const normalized = entries.map((entry) => normalizeLowercaseStringOrEmpty(entry)).filter((entry) => entry.length > 0);
	return new Set(normalized);
}
function resolveSafeBins(entries) {
	if (entries === void 0) return normalizeSafeBins(DEFAULT_SAFE_BINS);
	return normalizeSafeBins(entries ?? []);
}
function isSafeBinUsage(params) {
	if (isWindowsPlatform(params.platform ?? process.platform)) return false;
	if (params.safeBins.size === 0) return false;
	const resolution = params.resolution;
	const execName = normalizeOptionalLowercaseString(resolution?.executableName);
	if (!execName) return false;
	if (!params.safeBins.has(execName)) return false;
	if (!resolution?.resolvedPath) return false;
	if (!(params.isTrustedSafeBinPathFn ?? isTrustedSafeBinPath)({
		resolvedPath: resolution.resolvedPath,
		trustedDirs: params.trustedSafeBinDirs
	})) return false;
	const argv = params.argv.slice(1);
	const profile = (params.safeBinProfiles ?? SAFE_BIN_PROFILES)[execName];
	if (!profile) return false;
	return validateSafeBinArgv(argv, profile, { binName: execName });
}
function isPathScopedExecutableToken(token) {
	return token.includes("/") || token.includes("\\");
}
function pickExecAllowlistContext(params) {
	return {
		allowlist: params.allowlist,
		safeBins: params.safeBins,
		safeBinProfiles: params.safeBinProfiles,
		cwd: params.cwd,
		env: params.env,
		platform: params.platform,
		trustedSafeBinDirs: params.trustedSafeBinDirs,
		skillBins: params.skillBins,
		autoAllowSkills: params.autoAllowSkills
	};
}
function normalizeSkillBinName(value) {
	const trimmed = normalizeOptionalLowercaseString(value);
	return trimmed && trimmed.length > 0 ? trimmed : null;
}
function normalizeSkillBinResolvedPath(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return null;
	const resolved = path.resolve(trimmed);
	if (process.platform === "win32") return normalizeLowercaseStringOrEmpty(resolved.replace(/\\/g, "/"));
	return resolved;
}
function buildSkillBinTrustIndex(entries) {
	const trustByName = /* @__PURE__ */ new Map();
	if (!entries || entries.length === 0) return trustByName;
	for (const entry of entries) {
		const name = normalizeSkillBinName(entry.name);
		const resolvedPath = normalizeSkillBinResolvedPath(entry.resolvedPath);
		if (!name || !resolvedPath) continue;
		const paths = trustByName.get(name) ?? /* @__PURE__ */ new Set();
		paths.add(resolvedPath);
		trustByName.set(name, paths);
	}
	return trustByName;
}
function isSkillAutoAllowedSegment(params) {
	if (!params.allowSkills) return false;
	const resolution = params.segment.resolution;
	const execution = resolveExecutionTargetResolution(resolution);
	if (!execution?.resolvedPath) return false;
	const rawExecutable = execution.rawExecutable?.trim() ?? "";
	if (!rawExecutable || isPathScopedExecutableToken(rawExecutable)) return false;
	const executableName = normalizeSkillBinName(execution.executableName);
	const resolvedPath = normalizeSkillBinResolvedPath(execution.resolvedPath);
	if (!executableName || !resolvedPath) return false;
	return Boolean(params.skillBinTrust.get(executableName)?.has(resolvedPath));
}
function resolveSkillPreludePath(rawPath, cwd) {
	const expanded = rawPath.startsWith("~") ? expandHomePrefix(rawPath) : rawPath;
	if (path.isAbsolute(expanded)) return path.resolve(expanded);
	return path.resolve(cwd?.trim() || process.cwd(), expanded);
}
function isSkillMarkdownPreludePath(filePath) {
	const lowerNormalized = normalizeLowercaseStringOrEmpty(filePath.replace(/\\/g, "/"));
	if (!lowerNormalized.endsWith("/skill.md")) return false;
	const parts = lowerNormalized.split("/").filter(Boolean);
	if (parts.length < 2) return false;
	for (let index = parts.length - 2; index >= 0; index -= 1) {
		if (parts[index] !== "skills") continue;
		const segmentsAfterSkills = parts.length - index - 1;
		if (segmentsAfterSkills === 1 || segmentsAfterSkills === 2) return true;
	}
	return false;
}
function resolveSkillMarkdownPreludeId(filePath) {
	const lowerNormalized = normalizeLowercaseStringOrEmpty(filePath.replace(/\\/g, "/"));
	if (!lowerNormalized.endsWith("/skill.md")) return null;
	const parts = lowerNormalized.split("/").filter(Boolean);
	if (parts.length < 3) return null;
	for (let index = parts.length - 2; index >= 0; index -= 1) {
		if (parts[index] !== "skills") continue;
		if (parts.length - index - 1 !== 2) continue;
		return parts[index + 1]?.trim() || null;
	}
	return null;
}
function isSkillPreludeReadSegment(segment, cwd) {
	if (normalizeLowercaseStringOrEmpty(resolveExecutionTargetResolution(segment.resolution)?.executableName) !== "cat") return false;
	if (segment.argv.length !== 2) return false;
	const rawPath = segment.argv[1]?.trim();
	if (!rawPath) return false;
	return isSkillMarkdownPreludePath(resolveSkillPreludePath(rawPath, cwd));
}
function isSkillPreludeMarkerSegment(segment) {
	if (normalizeLowercaseStringOrEmpty(resolveExecutionTargetResolution(segment.resolution)?.executableName) !== "printf") return false;
	if (segment.argv.length !== 2) return false;
	const marker = segment.argv[1];
	return marker === "\\n---CMD---\\n" || marker === "\n---CMD---\n";
}
function isSkillPreludeSegment(segment, cwd) {
	return isSkillPreludeReadSegment(segment, cwd) || isSkillPreludeMarkerSegment(segment);
}
function isSkillPreludeOnlyEvaluation(segments, cwd) {
	return segments.length > 0 && segments.every((segment) => isSkillPreludeSegment(segment, cwd));
}
function resolveSkillPreludeIds(segments, cwd) {
	const skillIds = /* @__PURE__ */ new Set();
	for (const segment of segments) {
		if (!isSkillPreludeReadSegment(segment, cwd)) continue;
		const rawPath = segment.argv[1]?.trim();
		if (!rawPath) continue;
		const skillId = resolveSkillMarkdownPreludeId(resolveSkillPreludePath(rawPath, cwd));
		if (skillId) skillIds.add(skillId);
	}
	return skillIds;
}
function resolveAllowlistedSkillWrapperId(segment) {
	const executableName = normalizeExecutableToken(resolveExecutionTargetResolution(segment.resolution)?.executableName ?? segment.argv[0] ?? "");
	if (!executableName.endsWith("-wrapper")) return null;
	return executableName.slice(0, -8).trim() || null;
}
function resolveTrustedSkillExecutionIds(params) {
	const skillIds = /* @__PURE__ */ new Set();
	if (!params.evaluation.allowlistSatisfied) return skillIds;
	for (const [index, segment] of params.analysis.segments.entries()) {
		const satisfiedBy = params.evaluation.segmentSatisfiedBy[index];
		if (satisfiedBy === "skills") {
			const execution = resolveExecutionTargetResolution(segment.resolution);
			const executableName = normalizeExecutableToken(execution?.executableName ?? execution?.rawExecutable ?? segment.argv[0] ?? "");
			if (executableName) skillIds.add(executableName);
			continue;
		}
		if (satisfiedBy !== "allowlist") continue;
		const wrapperSkillId = resolveAllowlistedSkillWrapperId(segment);
		if (wrapperSkillId) skillIds.add(wrapperSkillId);
	}
	return skillIds;
}
const MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH = 3;
function resolveShellWrapperScriptArgv(params) {
	const scriptBase = normalizeLowercaseStringOrEmpty(path.basename(params.shellScriptCandidatePath));
	const cwdBase = params.cwd && params.cwd.trim() ? params.cwd.trim() : process.cwd();
	const resolveArgPath = (a) => path.isAbsolute(a) ? a : path.resolve(cwdBase, a);
	let idx = params.effectiveArgv.findIndex((a) => resolveArgPath(a) === params.shellScriptCandidatePath);
	if (idx === -1) idx = params.effectiveArgv.findIndex((a) => normalizeLowercaseStringOrEmpty(path.basename(a)) === scriptBase);
	const scriptArgs = idx !== -1 ? params.effectiveArgv.slice(idx + 1) : [];
	return [params.shellScriptCandidatePath, ...scriptArgs];
}
function resolveSegmentAllowlistMatch(params) {
	const effectiveArgv = params.segment.resolution?.effectiveArgv && params.segment.resolution.effectiveArgv.length > 0 ? params.segment.resolution.effectiveArgv : params.segment.argv;
	const allowlistSegment = effectiveArgv === params.segment.argv ? params.segment : {
		...params.segment,
		argv: effectiveArgv
	};
	const executableResolution = resolvePolicyTargetResolution(params.segment.resolution);
	const candidatePath = resolvePolicyTargetCandidatePath(params.segment.resolution, params.context.cwd);
	const candidateResolution = candidatePath && executableResolution ? {
		...executableResolution,
		resolvedPath: candidatePath
	} : executableResolution;
	const inlineCommand = extractBindableShellWrapperInlineCommand(allowlistSegment.argv);
	const executableMatch = inlineCommand !== null && isDirectShellPositionalCarrierInvocation(inlineCommand) ? null : matchAllowlist(params.context.allowlist, candidateResolution, effectiveArgv, params.context.platform);
	const shellPositionalArgvCandidatePath = inlineCommand !== null ? resolveShellWrapperPositionalArgvCandidatePath({
		segment: allowlistSegment,
		cwd: params.context.cwd,
		env: params.context.env
	}) : void 0;
	const shellPositionalArgvMatch = shellPositionalArgvCandidatePath ? matchAllowlist(params.context.allowlist, {
		rawExecutable: shellPositionalArgvCandidatePath,
		resolvedPath: shellPositionalArgvCandidatePath,
		executableName: path.basename(shellPositionalArgvCandidatePath)
	}, void 0, params.context.platform) : null;
	const shellScriptCandidatePath = inlineCommand === null ? resolveShellWrapperScriptCandidatePath({
		segment: allowlistSegment,
		cwd: params.context.cwd
	}) : void 0;
	const shellScriptArgv = shellScriptCandidatePath ? resolveShellWrapperScriptArgv({
		shellScriptCandidatePath,
		effectiveArgv,
		cwd: params.context.cwd
	}) : null;
	const shellScriptMatch = shellScriptCandidatePath && shellScriptArgv ? matchAllowlist(params.context.allowlist, {
		rawExecutable: shellScriptCandidatePath,
		resolvedPath: shellScriptCandidatePath,
		executableName: path.basename(shellScriptCandidatePath)
	}, shellScriptArgv, params.context.platform) : null;
	return {
		effectiveArgv,
		inlineCommand,
		match: executableMatch ?? shellPositionalArgvMatch ?? shellScriptMatch
	};
}
function resolveSegmentSatisfaction(params) {
	if (params.match) return "allowlist";
	if (isSafeBinUsage({
		argv: params.effectiveArgv,
		resolution: resolveExecutionTargetResolution(params.segment.resolution),
		safeBins: params.context.safeBins,
		safeBinProfiles: params.context.safeBinProfiles,
		platform: params.context.platform,
		trustedSafeBinDirs: params.context.trustedSafeBinDirs
	})) return "safeBins";
	return isSkillAutoAllowedSegment({
		segment: params.segment,
		allowSkills: params.allowSkills,
		skillBinTrust: params.skillBinTrust
	}) ? "skills" : null;
}
function resolveInlineChainFallback(params) {
	if (params.by !== null || !params.inlineCommand) return null;
	const inlineChainParts = splitCommandChain(params.inlineCommand);
	if (!inlineChainParts || inlineChainParts.length <= 1) return null;
	return evaluateShellWrapperInlineChain({
		inlineCommand: params.inlineCommand,
		context: params.context,
		inlineDepth: params.inlineDepth + 1,
		precomputedChainParts: inlineChainParts
	});
}
function evaluateShellWrapperInlineChain(params) {
	if (params.inlineDepth >= MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH) return null;
	if (isWindowsPlatform(params.context.platform)) return null;
	const chainParts = params.precomputedChainParts ?? splitCommandChain(params.inlineCommand);
	if (!chainParts || chainParts.length <= 1) return null;
	const matches = [];
	for (const part of chainParts) {
		const analysis = analyzeShellCommand({
			command: part,
			cwd: params.context.cwd,
			env: params.context.env,
			platform: params.context.platform
		});
		if (!analysis.ok) return null;
		const result = evaluateSegments(analysis.segments, params.context, params.inlineDepth);
		if (!result.satisfied) return null;
		matches.push(...result.matches);
	}
	return {
		matches,
		satisfiedBy: "allowlist"
	};
}
function evaluateSegments(segments, params, inlineDepth = 0) {
	const matches = [];
	const skillBinTrust = buildSkillBinTrustIndex(params.skillBins);
	const allowSkills = params.autoAllowSkills === true && skillBinTrust.size > 0;
	const segmentAllowlistEntries = [];
	const segmentSatisfiedBy = [];
	return {
		satisfied: segments.every((segment) => {
			if (segment.resolution?.policyBlocked === true) {
				segmentAllowlistEntries.push(null);
				segmentSatisfiedBy.push(null);
				return false;
			}
			const { effectiveArgv, inlineCommand, match } = resolveSegmentAllowlistMatch({
				segment,
				context: params
			});
			if (match) matches.push(match);
			segmentAllowlistEntries.push(match ?? null);
			const by = resolveSegmentSatisfaction({
				match,
				segment,
				effectiveArgv,
				context: params,
				allowSkills,
				skillBinTrust
			});
			const inlineResult = resolveInlineChainFallback({
				by,
				inlineCommand,
				context: params,
				inlineDepth
			});
			if (inlineResult) {
				matches.push(...inlineResult.matches);
				segmentSatisfiedBy.push(inlineResult.satisfiedBy);
				return true;
			}
			segmentSatisfiedBy.push(by);
			return Boolean(by);
		}),
		matches,
		segmentAllowlistEntries,
		segmentSatisfiedBy
	};
}
function resolveAnalysisSegmentGroups(analysis) {
	if (analysis.chains) return analysis.chains;
	return [analysis.segments];
}
function evaluateExecAllowlist(params) {
	const allowlistMatches = [];
	const segmentAllowlistEntries = [];
	const segmentSatisfiedBy = [];
	if (!params.analysis.ok || params.analysis.segments.length === 0) return {
		allowlistSatisfied: false,
		allowlistMatches,
		segmentAllowlistEntries,
		segmentSatisfiedBy
	};
	const allowlistContext = pickExecAllowlistContext(params);
	const hasChains = Boolean(params.analysis.chains);
	for (const group of resolveAnalysisSegmentGroups(params.analysis)) {
		const result = evaluateSegments(group, allowlistContext);
		if (!result.satisfied) {
			if (!hasChains) return {
				allowlistSatisfied: false,
				allowlistMatches: result.matches,
				segmentAllowlistEntries: result.segmentAllowlistEntries,
				segmentSatisfiedBy: result.segmentSatisfiedBy
			};
			return {
				allowlistSatisfied: false,
				allowlistMatches: [],
				segmentAllowlistEntries: [],
				segmentSatisfiedBy: []
			};
		}
		allowlistMatches.push(...result.matches);
		segmentAllowlistEntries.push(...result.segmentAllowlistEntries);
		segmentSatisfiedBy.push(...result.segmentSatisfiedBy);
	}
	return {
		allowlistSatisfied: true,
		allowlistMatches,
		segmentAllowlistEntries,
		segmentSatisfiedBy
	};
}
function hasSegmentExecutableMatch(segment, predicate) {
	const execution = resolveExecutionTargetResolution(segment.resolution);
	const candidates = [
		execution?.executableName,
		execution?.rawExecutable,
		segment.argv[0]
	];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (!trimmed) continue;
		if (predicate(trimmed)) return true;
	}
	return false;
}
function isShellWrapperSegment(segment) {
	return hasSegmentExecutableMatch(segment, isShellWrapperExecutable);
}
const SHELL_WRAPPER_OPTIONS_WITH_VALUE = new Set([
	"-c",
	"--command",
	"-o",
	"-O",
	"+O"
]);
const SHELL_WRAPPER_DISQUALIFYING_SCRIPT_OPTIONS = [
	"--rcfile",
	"--init-file",
	"--startup-file"
];
function hasDisqualifyingShellWrapperScriptOption(token) {
	return SHELL_WRAPPER_DISQUALIFYING_SCRIPT_OPTIONS.some((option) => token === option || token.startsWith(`${option}=`));
}
const POWERSHELL_OPTIONS_WITH_VALUE_RE = /^-(?:executionpolicy|ep|windowstyle|w|workingdirectory|wd|inputformat|outputformat|settingsfile|configurationfile|version|v|psconsolefile|pscf|encodedcommand|en|enc|encodedarguments|ea)$/i;
function resolveShellWrapperScriptCandidatePath(params) {
	if (!isShellWrapperSegment(params.segment)) return;
	const argv = params.segment.argv;
	if (!Array.isArray(argv) || argv.length < 2) return;
	const wrapperName = normalizeExecutableToken(argv[0] ?? "");
	const isPowerShell = POWERSHELL_WRAPPERS.has(wrapperName);
	let idx = 1;
	while (idx < argv.length) {
		const token = argv[idx]?.trim() ?? "";
		if (!token) {
			idx += 1;
			continue;
		}
		if (token === "--") {
			idx += 1;
			break;
		}
		if (token === "-c" || token === "--command") return;
		if (!isPowerShell && /^-[^-]*c[^-]*$/i.test(token)) return;
		if (token === "-s" || !isPowerShell && /^-[^-]*s[^-]*$/i.test(token)) return;
		if (hasDisqualifyingShellWrapperScriptOption(token)) return;
		if (SHELL_WRAPPER_OPTIONS_WITH_VALUE.has(token)) {
			idx += 2;
			continue;
		}
		if (isPowerShell && POWERSHELL_OPTIONS_WITH_VALUE_RE.test(token)) {
			idx += 2;
			continue;
		}
		if (token.startsWith("-") || token.startsWith("+")) {
			idx += 1;
			continue;
		}
		break;
	}
	const scriptToken = argv[idx]?.trim();
	if (!scriptToken) return;
	if (path.isAbsolute(scriptToken)) return scriptToken;
	const expanded = scriptToken.startsWith("~") ? expandHomePrefix(scriptToken) : scriptToken;
	const base = params.cwd && params.cwd.trim().length > 0 ? params.cwd : process.cwd();
	return path.resolve(base, expanded);
}
function resolveShellWrapperPositionalArgvCandidatePath(params) {
	if (!isShellWrapperSegment(params.segment)) return;
	const argv = params.segment.argv;
	if (!Array.isArray(argv) || argv.length < 4) return;
	const wrapper = normalizeExecutableToken(argv[0] ?? "");
	if (![
		"ash",
		"bash",
		"dash",
		"fish",
		"ksh",
		"sh",
		"zsh"
	].includes(wrapper)) return;
	const inlineMatch = resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, { allowCombinedC: true });
	if (inlineMatch.valueTokenIndex === null || !inlineMatch.command) return;
	if (!isDirectShellPositionalCarrierInvocation(inlineMatch.command)) return;
	const carriedExecutable = argv.slice(inlineMatch.valueTokenIndex + 1).map((token) => token.trim()).find((token) => token.length > 0);
	if (!carriedExecutable) return;
	const carriedName = normalizeExecutableToken(carriedExecutable);
	if (isDispatchWrapperExecutable(carriedName) || isShellWrapperExecutable(carriedName)) return;
	return resolveExecutionTargetCandidatePath(resolveCommandResolutionFromArgv([carriedExecutable], params.cwd, params.env), params.cwd);
}
function isDirectShellPositionalCarrierInvocation(command) {
	const trimmed = command.trim();
	if (trimmed.length === 0) return false;
	const shellWhitespace = String.raw`[^\S\r\n]+`;
	const positionalZero = String.raw`(?:\$(?:0|\{0\})|"\$(?:0|\{0\})")`;
	const positionalArg = String.raw`(?:\$(?:[@*]|[1-9]|\{[@*1-9]\})|"\$(?:[@*]|[1-9]|\{[@*1-9]\})")`;
	return new RegExp(`^(?:exec${shellWhitespace}(?:--${shellWhitespace})?)?${positionalZero}(?:${shellWhitespace}${positionalArg})*$`, "u").test(trimmed);
}
function escapeRegExpLiteral(input) {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildScriptArgPatternFromArgv(argv, scriptPath, cwd, platform) {
	if (!isWindowsPlatform(platform ?? process.platform)) return;
	const scriptBase = normalizeLowercaseStringOrEmpty(path.basename(scriptPath));
	const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
	const resolveArgPath = (arg) => path.isAbsolute(arg) ? arg : path.resolve(base, arg);
	let scriptIdx = argv.findIndex((arg) => resolveArgPath(arg) === scriptPath);
	if (scriptIdx === -1) scriptIdx = argv.findIndex((arg) => normalizeLowercaseStringOrEmpty(path.basename(arg)) === scriptBase);
	const normalized = (scriptIdx !== -1 ? argv.slice(scriptIdx + 1) : []).map((a) => a.replace(/\//g, "\\"));
	if (normalized.length === 0) return "^\0\0$";
	return `^${normalized.map(escapeRegExpLiteral).join("\0")}\x00$`;
}
function buildArgPatternFromArgv(argv, platform) {
	if (!isWindowsPlatform(platform ?? process.platform)) return;
	const normalized = argv.slice(1).map((a) => a.replace(/\//g, "\\"));
	if (normalized.length === 0) return "^\0\0$";
	return `^${escapeRegExpLiteral(normalized.join("\0"))}\x00$`;
}
function addAllowAlwaysPattern(out, pattern, argPattern) {
	if (!out.some((p) => p.pattern === pattern && (p.argPattern ?? void 0) === (argPattern ?? void 0))) out.push({
		pattern,
		argPattern
	});
}
function collectAllowAlwaysPatterns(params) {
	if (params.depth >= 3) return;
	const trustPlan = resolveExecWrapperTrustPlan(params.segment.argv);
	if (trustPlan.policyBlocked) return;
	const segment = trustPlan.argv === params.segment.argv ? params.segment : {
		raw: trustPlan.argv.join(" "),
		argv: trustPlan.argv,
		resolution: resolveCommandResolutionFromArgv(trustPlan.argv, params.cwd, params.env)
	};
	const candidatePath = resolveExecutionTargetCandidatePath(segment.resolution, params.cwd);
	if (!candidatePath) return;
	if (isInterpreterLikeAllowlistPattern(candidatePath)) {
		const effectiveArgv = segment.resolution?.effectiveArgv ?? segment.argv;
		if (params.strictInlineEval !== true || detectInlineEvalArgv(effectiveArgv) !== null) return;
	}
	if (!trustPlan.shellWrapperExecutable) {
		const argPattern = buildArgPatternFromArgv(segment.argv, params.platform);
		addAllowAlwaysPattern(params.out, candidatePath, argPattern);
		return;
	}
	const inlineCommand = POWERSHELL_WRAPPERS.has(normalizeExecutableToken(segment.argv[0] ?? "")) && segment.argv.some((t) => {
		const lower = normalizeLowercaseStringOrEmpty(t);
		return lower === "-file" || lower === "-f";
	}) && !segment.argv.some((t) => {
		const lower = normalizeLowercaseStringOrEmpty(t);
		return lower === "-command" || lower === "-c" || lower === "--command";
	}) ? null : trustPlan.shellInlineCommand;
	const positionalArgvPath = inlineCommand !== null ? resolveShellWrapperPositionalArgvCandidatePath({
		segment,
		cwd: params.cwd,
		env: params.env
	}) : void 0;
	if (positionalArgvPath) {
		addAllowAlwaysPattern(params.out, positionalArgvPath);
		return;
	}
	if (!inlineCommand) {
		const scriptPath = resolveShellWrapperScriptCandidatePath({
			segment,
			cwd: params.cwd
		});
		if (scriptPath) {
			const argPattern = buildScriptArgPatternFromArgv(params.segment.argv, scriptPath, params.cwd, params.platform);
			addAllowAlwaysPattern(params.out, scriptPath, argPattern);
		}
		return;
	}
	const nested = analyzeShellCommand({
		command: inlineCommand,
		cwd: params.cwd,
		env: params.env,
		platform: params.platform
	});
	if (!nested.ok) return;
	for (const nestedSegment of nested.segments) collectAllowAlwaysPatterns({
		segment: nestedSegment,
		cwd: params.cwd,
		env: params.env,
		platform: params.platform,
		strictInlineEval: params.strictInlineEval,
		depth: params.depth + 1,
		out: params.out
	});
}
/**
* Derive persisted allowlist patterns for an "allow always" decision.
* When a command is wrapped in a shell (for example `zsh -lc "<cmd>"`),
* persist the inner executable(s) rather than the shell binary.
*/
function resolveAllowAlwaysPatternEntries(params) {
	const patterns = [];
	for (const segment of params.segments) collectAllowAlwaysPatterns({
		segment,
		cwd: params.cwd,
		env: params.env,
		platform: params.platform,
		strictInlineEval: params.strictInlineEval,
		depth: 0,
		out: patterns
	});
	return patterns;
}
function resolveAllowAlwaysPatterns(params) {
	return resolveAllowAlwaysPatternEntries(params).map((pattern) => pattern.pattern);
}
/**
* Evaluates allowlist for shell commands (including &&, ||, ;) and returns analysis metadata.
*/
function evaluateShellAllowlist(params) {
	const allowlistContext = pickExecAllowlistContext(params);
	const analysisFailure = () => ({
		analysisOk: false,
		allowlistSatisfied: false,
		allowlistMatches: [],
		segments: [],
		segmentAllowlistEntries: [],
		segmentSatisfiedBy: []
	});
	if (hasShellLineContinuation(params.command)) return analysisFailure();
	const chainParts = isWindowsPlatform(params.platform) ? null : splitCommandChainWithOperators(params.command);
	if (!chainParts) {
		const analysis = analyzeShellCommand({
			command: params.command,
			cwd: params.cwd,
			env: params.env,
			platform: params.platform
		});
		if (!analysis.ok) return analysisFailure();
		const evaluation = evaluateExecAllowlist({
			analysis,
			...allowlistContext
		});
		return {
			analysisOk: true,
			allowlistSatisfied: evaluation.allowlistSatisfied,
			allowlistMatches: evaluation.allowlistMatches,
			segments: analysis.segments,
			segmentAllowlistEntries: evaluation.segmentAllowlistEntries,
			segmentSatisfiedBy: evaluation.segmentSatisfiedBy
		};
	}
	const chainEvaluations = chainParts.map(({ part, opToNext }) => {
		const analysis = analyzeShellCommand({
			command: part,
			cwd: params.cwd,
			env: params.env,
			platform: params.platform
		});
		if (!analysis.ok) return null;
		return {
			analysis,
			evaluation: evaluateExecAllowlist({
				analysis,
				...allowlistContext
			}),
			opToNext
		};
	});
	if (chainEvaluations.some((entry) => entry === null)) return analysisFailure();
	const finalizedEvaluations = chainEvaluations;
	const allowSkillPreludeAtIndex = /* @__PURE__ */ new Set();
	const reachableSkillIds = /* @__PURE__ */ new Set();
	for (let index = finalizedEvaluations.length - 1; index >= 0; index -= 1) {
		const { analysis, evaluation, opToNext } = finalizedEvaluations[index];
		const trustedSkillIds = resolveTrustedSkillExecutionIds({
			analysis,
			evaluation
		});
		if (trustedSkillIds.size > 0) {
			for (const skillId of trustedSkillIds) reachableSkillIds.add(skillId);
			continue;
		}
		const isPreludeOnly = !evaluation.allowlistSatisfied && isSkillPreludeOnlyEvaluation(analysis.segments, params.cwd);
		const preludeSkillIds = isPreludeOnly ? resolveSkillPreludeIds(analysis.segments, params.cwd) : /* @__PURE__ */ new Set();
		const reachesTrustedSkillExecution = opToNext === "&&" && (preludeSkillIds.size === 0 ? reachableSkillIds.size > 0 : [...preludeSkillIds].some((skillId) => reachableSkillIds.has(skillId)));
		if (isPreludeOnly && reachesTrustedSkillExecution) {
			allowSkillPreludeAtIndex.add(index);
			continue;
		}
		reachableSkillIds.clear();
	}
	const allowlistMatches = [];
	const segments = [];
	const segmentAllowlistEntries = [];
	const segmentSatisfiedBy = [];
	for (const [index, { analysis, evaluation }] of finalizedEvaluations.entries()) {
		const effectiveSegmentSatisfiedBy = allowSkillPreludeAtIndex.has(index) ? analysis.segments.map(() => "skillPrelude") : evaluation.segmentSatisfiedBy;
		const effectiveSegmentAllowlistEntries = allowSkillPreludeAtIndex.has(index) ? analysis.segments.map(() => null) : evaluation.segmentAllowlistEntries;
		segments.push(...analysis.segments);
		allowlistMatches.push(...evaluation.allowlistMatches);
		segmentAllowlistEntries.push(...effectiveSegmentAllowlistEntries);
		segmentSatisfiedBy.push(...effectiveSegmentSatisfiedBy);
		if (!evaluation.allowlistSatisfied && !allowSkillPreludeAtIndex.has(index)) return {
			analysisOk: true,
			allowlistSatisfied: false,
			allowlistMatches,
			segments,
			segmentAllowlistEntries,
			segmentSatisfiedBy
		};
	}
	return {
		analysisOk: true,
		allowlistSatisfied: true,
		allowlistMatches,
		segments,
		segmentAllowlistEntries,
		segmentSatisfiedBy
	};
}
//#endregion
export { windowsEscapeArg as _, resolveAllowAlwaysPatternEntries as a, analyzeArgvCommand as c, buildSafeBinsShellCommand as d, buildSafeShellCommand as f, splitCommandChainWithOperators as g, splitCommandChain as h, normalizeSafeBins as i, analyzeShellCommand as l, resolvePlannedSegmentArgv as m, evaluateShellAllowlist as n, resolveAllowAlwaysPatterns as o, isWindowsPlatform as p, isSafeBinUsage as r, resolveSafeBins as s, evaluateExecAllowlist as t, buildEnforcedShellCommand as u };
