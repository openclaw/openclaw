import { b as escapeRegExp } from "./utils-927g1oFZ.js";
import { a as normalizeDiagnosticTraceparent } from "./diagnostic-trace-context-pure-DT_YEIKj.js";
import { n as normalizeContinuationTargetKey, r as normalizeContinuationTargetKeys, t as CONTINUATION_DELEGATE_FANOUT_MODES } from "./targeting-pure-BJmSjY-N.js";
//#region src/auto-reply/tokens.ts
const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
const SILENT_REPLY_TOKEN = "NO_REPLY";
const silentExactRegexByToken = /* @__PURE__ */ new Map();
const silentTrailingRegexByToken = /* @__PURE__ */ new Map();
const silentLeadingAttachedRegexByToken = /* @__PURE__ */ new Map();
function getSilentExactRegex(token) {
	const cached = silentExactRegexByToken.get(token);
	if (cached) return cached;
	const escaped = escapeRegExp(token);
	const regex = new RegExp(`^\\s*${escaped}\\s*$`, "i");
	silentExactRegexByToken.set(token, regex);
	return regex;
}
function getSilentTrailingRegex(token) {
	const cached = silentTrailingRegexByToken.get(token);
	if (cached) return cached;
	const escaped = escapeRegExp(token);
	const regex = new RegExp(`(?:^|\\s+|\\*+)${escaped}\\s*$`, "i");
	silentTrailingRegexByToken.set(token, regex);
	return regex;
}
function isSilentReplyText(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	return getSilentExactRegex(token).test(text);
}
function isSilentReplyEnvelopeText(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	const trimmed = text.trim();
	if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(token)) return false;
	try {
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const keys = Object.keys(parsed);
		return keys.length === 1 && keys[0] === "action" && typeof parsed.action === "string" && parsed.action.trim() === token;
	} catch {
		return false;
	}
}
function isSilentReplyPayloadText(text, token = SILENT_REPLY_TOKEN) {
	return isSilentReplyText(text, token) || isSilentReplyEnvelopeText(text, token);
}
/**
* Strip a trailing silent reply token from mixed-content text.
* Returns the remaining text with the token removed (trimmed).
* If the result is empty, the entire message should be treated as silent.
*/
function stripSilentToken(text, token = SILENT_REPLY_TOKEN) {
	return text.replace(getSilentTrailingRegex(token), "").trim();
}
const silentLeadingRegexByToken = /* @__PURE__ */ new Map();
function getSilentLeadingAttachedRegex(token) {
	const cached = silentLeadingAttachedRegexByToken.get(token);
	if (cached) return cached;
	const escaped = escapeRegExp(token);
	const regex = new RegExp(`^\\s*(?:${escaped}\\s+)*${escaped}(?=[\\p{L}\\p{N}])`, "iu");
	silentLeadingAttachedRegexByToken.set(token, regex);
	return regex;
}
function getSilentLeadingRegex(token) {
	const cached = silentLeadingRegexByToken.get(token);
	if (cached) return cached;
	const escaped = escapeRegExp(token);
	const regex = new RegExp(`^(?:\\s*${escaped})+\\s*`, "i");
	silentLeadingRegexByToken.set(token, regex);
	return regex;
}
/**
* Strip leading silent reply tokens from text.
* Handles cases like "NO_REPLYThe user is saying..." where the token
* is not separated from the following text.
*/
function stripLeadingSilentToken(text, token = SILENT_REPLY_TOKEN) {
	return text.replace(getSilentLeadingRegex(token), "").trim();
}
/**
* Check whether text starts with one or more leading silent reply tokens where
* the final token is glued directly to visible content.
*/
function startsWithSilentToken(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	return getSilentLeadingAttachedRegex(token).test(text);
}
function isSilentReplyPrefixText(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	const trimmed = text.trimStart();
	if (!trimmed) return false;
	if (trimmed !== trimmed.toUpperCase()) return false;
	const normalized = trimmed.toUpperCase();
	if (!normalized) return false;
	if (normalized.length < 2) return false;
	if (/[^A-Z_]/.test(normalized)) return false;
	const tokenUpper = token.toUpperCase();
	if (!tokenUpper.startsWith(normalized)) return false;
	if (normalized.includes("_")) return true;
	return tokenUpper === "NO_REPLY" && normalized === "NO";
}
function splitDirectiveAssignment(segment) {
	const separator = segment.indexOf("=");
	if (separator < 0) return null;
	return {
		key: segment.slice(0, separator).trim().toLowerCase(),
		value: segment.slice(separator + 1).trim()
	};
}
function parseDelegateDirective(segment, state) {
	const normalized = segment.trim().toLowerCase();
	if (!normalized) return { status: "invalid" };
	if (normalized === "normal") return { status: "applied" };
	if (normalized === "silent-wake" || normalized === "silent wake") {
		state.silentWake = true;
		state.silent = void 0;
		return { status: "applied" };
	}
	if (normalized === "silent") {
		state.silent = true;
		return { status: "applied" };
	}
	const assignment = splitDirectiveAssignment(segment);
	if (!assignment) return { status: "unknown" };
	if (assignment.key === "target" || assignment.key === "targetsessionkey" || assignment.key === "target_session_key") {
		const targetSessionKey = normalizeContinuationTargetKey(assignment.value);
		if (!targetSessionKey) return { status: "invalid" };
		state.targetSessionKey = targetSessionKey;
		return { status: "applied" };
	}
	if (assignment.key === "targets" || assignment.key === "targetsessionkeys" || assignment.key === "target_session_keys") {
		const targetSessionKeys = normalizeContinuationTargetKeys(assignment.value.split(","));
		if (targetSessionKeys.length === 0) return { status: "invalid" };
		state.targetSessionKeys = targetSessionKeys;
		return { status: "applied" };
	}
	if (assignment.key === "fanout" || assignment.key === "fanoutmode" || assignment.key === "fanout_mode") {
		const fanoutMode = assignment.value.trim().toLowerCase();
		if (!CONTINUATION_DELEGATE_FANOUT_MODES.includes(fanoutMode)) return { status: "invalid" };
		state.fanoutMode = fanoutMode;
		return { status: "applied" };
	}
	if (assignment.key === "traceparent" || assignment.key === "trace_parent") {
		const traceparent = normalizeDiagnosticTraceparent(assignment.value);
		if (traceparent) state.traceparent = traceparent;
		return { status: "applied" };
	}
	return { status: "unknown" };
}
function parseDelegateBodyDirectives(taskBody) {
	const segments = taskBody.split("|").map((segment) => segment.trim());
	const directives = {};
	while (segments.length > 1) {
		const parsed = parseDelegateDirective(segments.at(-1) ?? "", directives);
		if (parsed.status === "unknown") break;
		if (parsed.status === "invalid") return null;
		segments.pop();
	}
	if (directives.fanoutMode && (directives.targetSessionKey || directives.targetSessionKeys && directives.targetSessionKeys.length > 0)) return null;
	return {
		taskBody: segments.join(" | ").trim(),
		directives
	};
}
/**
* Checks if the agent response ends with a continuation signal.
* Returns the parsed signal or null if no continuation is requested.
*
* Formats:
*   CONTINUE_WORK              → continue with default delay
*   CONTINUE_WORK:30           → continue after 30 seconds
*   [[CONTINUE_DELEGATE: task]]      → spawn sub-agent with task immediately
*   [[CONTINUE_DELEGATE: task +30s]] → spawn sub-agent after 30-second delay
*   [[CONTINUE_DELEGATE: task | target=session-key]]
*   [[CONTINUE_DELEGATE: task | targets=key1,key2]]
*   [[CONTINUE_DELEGATE: task | fanout=tree]]
*
* The `+Ns` suffix on DELEGATE specifies a timer offset before the sub-agent
* spawns (delegate-as-scheduler pattern). Timers do not survive gateway restarts.
*
* DELEGATE uses bracket syntax ([[...]]) following the repo convention for tokens
* that carry body content (see reply_to, tts, line directives). Brackets naturally
* delimit the boundary, so multiline tasks work without ambiguity.
*/
function parseContinuationSignal(text) {
	if (!text) return null;
	const trimmed = text.trim();
	const delegateMatch = trimmed.match(/\[\[\s*CONTINUE_DELEGATE:\s*((?:(?!\]\])[\s\S])+?)\s*\]\]\s*$/);
	if (delegateMatch) {
		let taskBody = delegateMatch[1].trim();
		const parsedBody = parseDelegateBodyDirectives(taskBody);
		if (!parsedBody) return null;
		taskBody = parsedBody.taskBody;
		const { silent, silentWake, targetSessionKey, targetSessionKeys, fanoutMode, traceparent } = parsedBody.directives;
		let delayMs;
		const delayMatch = taskBody.match(/\s+\+(\d+)s\s*$/);
		if (delayMatch) {
			delayMs = Number.parseInt(delayMatch[1], 10) * 1e3;
			taskBody = taskBody.slice(0, -delayMatch[0].length).trimEnd();
		}
		if (taskBody) {
			const maxTaskLength = 4096;
			return {
				kind: "delegate",
				task: taskBody.length > maxTaskLength ? taskBody.slice(0, maxTaskLength) : taskBody,
				delayMs,
				silent,
				silentWake,
				...targetSessionKey ? { targetSessionKey } : {},
				...targetSessionKeys && targetSessionKeys.length > 0 ? { targetSessionKeys } : {},
				...fanoutMode ? { fanoutMode } : {},
				...traceparent ? { traceparent } : {}
			};
		}
	}
	const workMatch = trimmed.match(/\bCONTINUE_WORK(?::(\d+))?\s*$/);
	if (workMatch) {
		const delaySec = workMatch[1] ? Number.parseInt(workMatch[1], 10) : void 0;
		return {
			kind: "work",
			delayMs: delaySec !== void 0 ? delaySec * 1e3 : void 0
		};
	}
	return null;
}
/**
* Strips the continuation signal from the response text, returning the
* displayable text and the parsed signal separately.
*/
function stripContinuationSignal(text) {
	const signal = parseContinuationSignal(text);
	if (!signal) return {
		text,
		signal: null
	};
	let stripped;
	if (signal.kind === "delegate") stripped = text.replace(/\[\[\s*CONTINUE_DELEGATE:\s*(?:(?!\]\])[\s\S])+?\s*\]\]\s*$/, "");
	else stripped = text.replace(/\bCONTINUE_WORK(?::\d+)?\s*$/, "");
	stripped = stripped.trimEnd();
	return {
		text: stripped,
		signal
	};
}
//#endregion
export { isSilentReplyText as a, stripLeadingSilentToken as c, isSilentReplyPrefixText as i, stripSilentToken as l, SILENT_REPLY_TOKEN as n, startsWithSilentToken as o, isSilentReplyPayloadText as r, stripContinuationSignal as s, HEARTBEAT_TOKEN as t };
