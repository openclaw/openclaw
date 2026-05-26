import { i as normalizeFastMode, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { b as escapeRegExp } from "./utils-sBTEdeml.js";
import { d as normalizeElevatedLevel, f as normalizeReasoningLevel, g as normalizeVerboseLevel, m as normalizeTraceLevel, p as normalizeThinkLevel, u as isSessionDefaultDirectiveValue } from "./thinking-DNSlsULp.js";
import { t as splitTrailingAuthProfile } from "./model-ref-profile-L6rqw6O0.js";
import { v as normalizeExecTarget } from "./exec-approvals-Bef7TPVc.js";
import { a as skipDirectiveArgPrefix, o as takeDirectiveToken, t as extractQueueDirective } from "./directive-Dz6UwJA7.js";
//#region src/auto-reply/model.ts
function extractModelDirective(body, options) {
	if (!body) return {
		cleaned: "",
		hasDirective: false
	};
	const modelMatch = body.match(/(?:^|\s)\/model(?=$|\s|:)\s*:?\s*([A-Za-z0-9_.:@-]+(?:\/[A-Za-z0-9_.:@-]+)*)?(?:\s+(?:--runtime|runtime=|harness=)\s*([A-Za-z0-9_.:-]+))?/i);
	const aliases = (options?.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
	const aliasMatch = modelMatch || aliases.length === 0 ? null : body.match(new RegExp(`(?:^|\\s)\\/(${aliases.map(escapeRegExp).join("|")})(?=$|\\s|:)(?:\\s*:\\s*)?`, "i"));
	const match = modelMatch ?? aliasMatch;
	const raw = modelMatch ? modelMatch?.[1]?.trim() : aliasMatch?.[1]?.trim();
	const rawRuntime = modelMatch?.[2]?.trim();
	let rawModel = raw;
	let rawProfile;
	if (raw) {
		const split = splitTrailingAuthProfile(raw);
		rawModel = split.model;
		rawProfile = split.profile;
	}
	return {
		cleaned: match ? body.replace(match[0], " ").replace(/\s+/g, " ").trim() : body.trim(),
		rawModel,
		rawProfile,
		rawRuntime,
		hasDirective: !!match
	};
}
//#endregion
//#region src/auto-reply/reply/exec/directive.ts
function normalizeExecSecurity(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (normalized === "deny" || normalized === "allowlist" || normalized === "full") return normalized;
}
function normalizeExecAsk(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (normalized === "off" || normalized === "on-miss" || normalized === "always") return normalized;
}
function parseExecDirectiveArgs(raw) {
	const len = raw.length;
	let i = skipDirectiveArgPrefix(raw);
	let consumed = i;
	let execHost;
	let execSecurity;
	let execAsk;
	let execNode;
	let rawExecHost;
	let rawExecSecurity;
	let rawExecAsk;
	let rawExecNode;
	let hasExecOptions = false;
	let invalidHost = false;
	let invalidSecurity = false;
	let invalidAsk = false;
	let invalidNode = false;
	const takeToken = () => {
		const res = takeDirectiveToken(raw, i);
		i = res.nextIndex;
		return res.token;
	};
	const splitToken = (token) => {
		const eq = token.indexOf("=");
		const colon = token.indexOf(":");
		const idx = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
		if (idx === -1) return null;
		const key = normalizeOptionalLowercaseString(token.slice(0, idx));
		const value = token.slice(idx + 1).trim();
		if (!key) return null;
		return {
			key,
			value
		};
	};
	for (;;) {
		if (i >= len) break;
		const token = takeToken();
		if (!token) break;
		const parsed = splitToken(token);
		if (!parsed) break;
		const { key, value } = parsed;
		if (key === "host") {
			rawExecHost = value;
			execHost = normalizeExecTarget(value) ?? void 0;
			if (!execHost) invalidHost = true;
			hasExecOptions = true;
			consumed = i;
			continue;
		}
		if (key === "security") {
			rawExecSecurity = value;
			execSecurity = normalizeExecSecurity(value);
			if (!execSecurity) invalidSecurity = true;
			hasExecOptions = true;
			consumed = i;
			continue;
		}
		if (key === "ask") {
			rawExecAsk = value;
			execAsk = normalizeExecAsk(value);
			if (!execAsk) invalidAsk = true;
			hasExecOptions = true;
			consumed = i;
			continue;
		}
		if (key === "node") {
			rawExecNode = value;
			const trimmed = value.trim();
			if (!trimmed) invalidNode = true;
			else execNode = trimmed;
			hasExecOptions = true;
			consumed = i;
			continue;
		}
		break;
	}
	return {
		consumed,
		execHost,
		execSecurity,
		execAsk,
		execNode,
		rawExecHost,
		rawExecSecurity,
		rawExecAsk,
		rawExecNode,
		hasExecOptions,
		invalidHost,
		invalidSecurity,
		invalidAsk,
		invalidNode
	};
}
function extractExecDirective(body) {
	if (!body) return {
		cleaned: "",
		hasDirective: false,
		hasExecOptions: false,
		invalidHost: false,
		invalidSecurity: false,
		invalidAsk: false,
		invalidNode: false
	};
	const match = /(?:^|\s)\/exec(?=$|\s|:)/i.exec(body);
	if (!match) return {
		cleaned: body.trim(),
		hasDirective: false,
		hasExecOptions: false,
		invalidHost: false,
		invalidSecurity: false,
		invalidAsk: false,
		invalidNode: false
	};
	const start = match.index + match[0].indexOf("/exec");
	const argsStart = start + 5;
	const parsed = parseExecDirectiveArgs(body.slice(argsStart));
	return {
		cleaned: `${body.slice(0, start)} ${body.slice(argsStart + parsed.consumed)}`.replace(/\s+/g, " ").trim(),
		hasDirective: true,
		execHost: parsed.execHost,
		execSecurity: parsed.execSecurity,
		execAsk: parsed.execAsk,
		execNode: parsed.execNode,
		rawExecHost: parsed.rawExecHost,
		rawExecSecurity: parsed.rawExecSecurity,
		rawExecAsk: parsed.rawExecAsk,
		rawExecNode: parsed.rawExecNode,
		hasExecOptions: parsed.hasExecOptions,
		invalidHost: parsed.invalidHost,
		invalidSecurity: parsed.invalidSecurity,
		invalidAsk: parsed.invalidAsk,
		invalidNode: parsed.invalidNode
	};
}
//#endregion
//#region src/auto-reply/reply/directives.ts
const compileDirectivePattern = (names, suffix = "") => {
	const namePattern = names.map(escapeRegExp).join("|");
	return new RegExp(`(?:^|\\s)\\/(?:${namePattern})(?=$|\\s|:)${suffix}`, "i");
};
const THINK_DIRECTIVE_PATTERN = compileDirectivePattern([
	"thinking",
	"think",
	"t"
]);
const VERBOSE_DIRECTIVE_PATTERN = compileDirectivePattern(["verbose", "v"]);
const TRACE_DIRECTIVE_PATTERN = compileDirectivePattern(["trace"]);
const FAST_DIRECTIVE_PATTERN = compileDirectivePattern(["fast"]);
const ELEVATED_DIRECTIVE_PATTERN = compileDirectivePattern(["elevated", "elev"]);
const REASONING_DIRECTIVE_PATTERN = compileDirectivePattern(["reasoning", "reason"]);
const STATUS_DIRECTIVE_PATTERN = compileDirectivePattern(["status"], `(?:\\s*:\\s*)?`);
const matchLevelDirective = (body, pattern) => {
	const match = body.match(pattern);
	if (!match || match.index === void 0) return null;
	const start = match.index;
	let end = match.index + match[0].length;
	let i = end;
	while (i < body.length && /\s/.test(body[i])) i += 1;
	if (body[i] === ":") {
		i += 1;
		while (i < body.length && /\s/.test(body[i])) i += 1;
	}
	const argStart = i;
	while (i < body.length && /[A-Za-z-]/.test(body[i])) i += 1;
	const rawLevel = i > argStart ? body.slice(argStart, i) : void 0;
	end = i;
	return {
		start,
		end,
		rawLevel
	};
};
const extractLevelDirective = (body, pattern, normalize) => {
	const match = matchLevelDirective(body, pattern);
	if (!match) return {
		cleaned: body.trim(),
		hasDirective: false
	};
	const rawLevel = match.rawLevel;
	const level = normalize(rawLevel);
	return {
		cleaned: body.slice(0, match.start).concat(" ").concat(body.slice(match.end)).replace(/\s+/g, " ").trim(),
		level,
		rawLevel,
		hasDirective: true
	};
};
const extractSimpleDirective = (body, pattern) => {
	const match = body.match(pattern);
	return {
		cleaned: match ? body.replace(match[0], " ").replace(/\s+/g, " ").trim() : body.trim(),
		hasDirective: Boolean(match)
	};
};
function extractThinkDirective(body) {
	if (!body) return {
		cleaned: "",
		hasDirective: false
	};
	const extracted = extractLevelDirective(body, THINK_DIRECTIVE_PATTERN, normalizeThinkLevel);
	return {
		cleaned: extracted.cleaned,
		thinkLevel: extracted.level,
		rawLevel: extracted.rawLevel,
		hasDirective: extracted.hasDirective
	};
}
function extractVerboseDirective(body) {
	if (!body) return {
		cleaned: "",
		hasDirective: false
	};
	const extracted = extractLevelDirective(body, VERBOSE_DIRECTIVE_PATTERN, normalizeVerboseLevel);
	return {
		cleaned: extracted.cleaned,
		verboseLevel: extracted.level,
		rawLevel: extracted.rawLevel,
		hasDirective: extracted.hasDirective
	};
}
function extractTraceDirective(body) {
	if (!body) return {
		cleaned: "",
		hasDirective: false
	};
	const extracted = extractLevelDirective(body, TRACE_DIRECTIVE_PATTERN, normalizeTraceLevel);
	return {
		cleaned: extracted.cleaned,
		traceLevel: extracted.level,
		rawLevel: extracted.rawLevel,
		hasDirective: extracted.hasDirective
	};
}
function extractFastDirective(body) {
	if (!body) return {
		cleaned: "",
		hasDirective: false
	};
	const extracted = extractLevelDirective(body, FAST_DIRECTIVE_PATTERN, normalizeFastMode);
	return {
		cleaned: extracted.cleaned,
		fastMode: extracted.level,
		rawLevel: extracted.rawLevel,
		hasDirective: extracted.hasDirective
	};
}
function extractElevatedDirective(body) {
	if (!body) return {
		cleaned: "",
		hasDirective: false
	};
	const extracted = extractLevelDirective(body, ELEVATED_DIRECTIVE_PATTERN, normalizeElevatedLevel);
	return {
		cleaned: extracted.cleaned,
		elevatedLevel: extracted.level,
		rawLevel: extracted.rawLevel,
		hasDirective: extracted.hasDirective
	};
}
function extractReasoningDirective(body) {
	if (!body) return {
		cleaned: "",
		hasDirective: false
	};
	const extracted = extractLevelDirective(body, REASONING_DIRECTIVE_PATTERN, normalizeReasoningLevel);
	return {
		cleaned: extracted.cleaned,
		reasoningLevel: extracted.level,
		rawLevel: extracted.rawLevel,
		hasDirective: extracted.hasDirective
	};
}
function extractStatusDirective(body) {
	if (!body) return {
		cleaned: "",
		hasDirective: false
	};
	return extractSimpleDirective(body, STATUS_DIRECTIVE_PATTERN);
}
//#endregion
//#region src/auto-reply/reply/directive-handling.parse.ts
function parseInlineDirectives(body, options) {
	const { cleaned: thinkCleaned, thinkLevel, rawLevel: rawThinkLevel, hasDirective: hasThinkDirective } = extractThinkDirective(body);
	const { cleaned: verboseCleaned, verboseLevel, rawLevel: rawVerboseLevel, hasDirective: hasVerboseDirective } = extractVerboseDirective(thinkCleaned);
	const { cleaned: traceCleaned, traceLevel, rawLevel: rawTraceLevel, hasDirective: hasTraceDirective } = extractTraceDirective(verboseCleaned);
	const { cleaned: fastCleaned, fastMode, rawLevel: rawFastMode, hasDirective: hasFastDirective } = extractFastDirective(traceCleaned);
	const { cleaned: reasoningCleaned, reasoningLevel, rawLevel: rawReasoningLevel, hasDirective: hasReasoningDirective } = extractReasoningDirective(fastCleaned);
	const { cleaned: elevatedCleaned, elevatedLevel, rawLevel: rawElevatedLevel, hasDirective: hasElevatedDirective } = options?.disableElevated ? {
		cleaned: reasoningCleaned,
		elevatedLevel: void 0,
		rawLevel: void 0,
		hasDirective: false
	} : extractElevatedDirective(reasoningCleaned);
	const { cleaned: execCleaned, execHost, execSecurity, execAsk, execNode, rawExecHost, rawExecSecurity, rawExecAsk, rawExecNode, hasExecOptions, invalidHost: invalidExecHost, invalidSecurity: invalidExecSecurity, invalidAsk: invalidExecAsk, invalidNode: invalidExecNode, hasDirective: hasExecDirective } = extractExecDirective(elevatedCleaned);
	const { cleaned: statusCleaned, hasDirective: hasStatusDirective } = options?.allowStatusDirective !== false ? extractStatusDirective(execCleaned) : {
		cleaned: execCleaned,
		hasDirective: false
	};
	const { cleaned: modelCleaned, rawModel, rawProfile, rawRuntime, hasDirective: hasModelDirective } = extractModelDirective(statusCleaned, { aliases: options?.modelAliases });
	const { cleaned: queueCleaned, queueMode, queueReset, rawMode, debounceMs, cap, dropPolicy, rawDebounce, rawCap, rawDrop, hasDirective: hasQueueDirective, hasOptions: hasQueueOptions } = extractQueueDirective(modelCleaned);
	return {
		cleaned: queueCleaned,
		hasThinkDirective,
		thinkLevel,
		rawThinkLevel,
		clearThinkLevel: hasThinkDirective && isSessionDefaultDirectiveValue(rawThinkLevel),
		hasVerboseDirective,
		verboseLevel,
		rawVerboseLevel,
		hasTraceDirective,
		traceLevel,
		rawTraceLevel,
		hasFastDirective,
		fastMode,
		rawFastMode,
		clearFastMode: hasFastDirective && isSessionDefaultDirectiveValue(rawFastMode),
		hasReasoningDirective,
		reasoningLevel,
		rawReasoningLevel,
		hasElevatedDirective,
		elevatedLevel,
		rawElevatedLevel,
		hasExecDirective,
		execHost,
		execSecurity,
		execAsk,
		execNode,
		rawExecHost,
		rawExecSecurity,
		rawExecAsk,
		rawExecNode,
		hasExecOptions,
		invalidExecHost,
		invalidExecSecurity,
		invalidExecAsk,
		invalidExecNode,
		hasStatusDirective,
		hasModelDirective,
		rawModelDirective: rawModel,
		rawModelProfile: rawProfile,
		rawModelRuntime: rawRuntime,
		hasQueueDirective,
		queueMode,
		queueReset,
		rawQueueMode: rawMode,
		debounceMs,
		cap,
		dropPolicy,
		rawDebounce,
		rawCap,
		rawDrop,
		hasQueueOptions
	};
}
//#endregion
export { parseInlineDirectives as t };
