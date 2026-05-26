import { c as readErrorName } from "./errors-b3ZrCRlt.js";
import { n as isSessionWriteLockTimeoutError } from "./session-write-lock-error-HvDhYM6H.js";
import { c as isTimeoutErrorMessage } from "./failover-matches-C-tab7FS.js";
import { b as isUnclassifiedNoBodyHttpSignal, n as classifyFailoverSignal, o as inferSignalStatus } from "./errors-DYND-qcd.js";
//#region src/agents/failover-error.ts
const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;
const MAX_FAILOVER_CAUSE_DEPTH = 25;
var FailoverError = class extends Error {
	constructor(message, params) {
		super(message, { cause: params.cause });
		this.name = "FailoverError";
		this.reason = params.reason;
		this.provider = params.provider;
		this.model = params.model;
		this.profileId = params.profileId;
		this.status = params.status;
		this.code = params.code;
		this.rawError = params.rawError;
		this.sessionId = params.sessionId;
		this.lane = params.lane;
		this.suspend = params.suspend;
	}
};
function isFailoverError(err) {
	if (err instanceof FailoverError) return true;
	return Boolean(err && typeof err === "object" && err.name === "FailoverError" && typeof err.reason === "string");
}
function resolveFailoverStatus(reason) {
	switch (reason) {
		case "billing": return 402;
		case "server_error": return 500;
		case "rate_limit": return 429;
		case "overloaded": return 503;
		case "auth": return 401;
		case "auth_permanent": return 403;
		case "timeout": return 408;
		case "format": return 400;
		case "model_not_found": return 404;
		case "session_expired": return 410;
		default: return;
	}
}
function findErrorProperty(err, reader, seen = /* @__PURE__ */ new Set()) {
	const direct = reader(err);
	if (direct !== void 0) return direct;
	if (!err || typeof err !== "object") return;
	if (seen.has(err)) return;
	seen.add(err);
	const candidate = err;
	return findErrorProperty(candidate.error, reader, seen) ?? findErrorProperty(candidate.cause, reader, seen);
}
function readDirectStatusCode(err) {
	if (!err || typeof err !== "object") return;
	const candidate = err.status ?? err.statusCode;
	if (typeof candidate === "number") return candidate;
	if (typeof candidate === "string" && /^\d+$/.test(candidate)) return Number(candidate);
}
function getStatusCode(err) {
	return findErrorProperty(err, readDirectStatusCode);
}
function readDirectErrorCode(err) {
	if (!err || typeof err !== "object") return;
	const directCode = err.code;
	if (typeof directCode === "string") {
		const trimmed = directCode.trim();
		return trimmed ? trimmed : void 0;
	}
	const detailCode = err.detail?.code;
	if (typeof detailCode === "string") {
		const trimmed = detailCode.trim();
		return trimmed ? trimmed : void 0;
	}
	const status = err.status;
	if (typeof status !== "string" || /^\d+$/.test(status)) return;
	const trimmed = status.trim();
	return trimmed ? trimmed : void 0;
}
function getErrorCode(err) {
	return findErrorProperty(err, readDirectErrorCode);
}
function readDirectProvider(err) {
	if (!err || typeof err !== "object") return;
	const provider = err.provider;
	if (typeof provider !== "string") return;
	return provider.trim() || void 0;
}
function getProvider(err) {
	return findErrorProperty(err, readDirectProvider);
}
function readDirectErrorMessage(err) {
	if (err instanceof Error) return err.message || void 0;
	if (typeof err === "string") return err || void 0;
	if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
	if (typeof err === "symbol") return err.description ?? void 0;
	if (err && typeof err === "object") {
		const message = err.message;
		if (typeof message === "string") return message || void 0;
	}
}
function getErrorMessage(err) {
	return findErrorProperty(err, readDirectErrorMessage) ?? "";
}
function normalizeDirectErrorSignal(err) {
	const message = readDirectErrorMessage(err);
	return {
		status: readDirectStatusCode(err),
		code: readDirectErrorCode(err),
		message: message || void 0,
		provider: readDirectProvider(err)
	};
}
function hasSessionWriteLockTimeout(err, seen = /* @__PURE__ */ new Set()) {
	if (isSessionWriteLockTimeoutError(err)) return true;
	if (!err || typeof err !== "object") return false;
	if (seen.has(err)) return false;
	seen.add(err);
	const candidate = err;
	return hasSessionWriteLockTimeout(candidate.error, seen) || hasSessionWriteLockTimeout(candidate.cause, seen) || hasSessionWriteLockTimeout(candidate.reason, seen);
}
function isEmbeddedAttemptSessionTakeover(err) {
	return Boolean(err && typeof err === "object" && readErrorName(err) === "EmbeddedAttemptSessionTakeoverError");
}
function hasEmbeddedAttemptSessionTakeover(err, seen = /* @__PURE__ */ new Set()) {
	if (isEmbeddedAttemptSessionTakeover(err)) return true;
	if (!err || typeof err !== "object") return false;
	if (seen.has(err)) return false;
	seen.add(err);
	const candidate = err;
	return hasEmbeddedAttemptSessionTakeover(candidate.error, seen) || hasEmbeddedAttemptSessionTakeover(candidate.cause, seen) || hasEmbeddedAttemptSessionTakeover(candidate.reason, seen);
}
/**
* True when the error is a local runtime coordination error (session write-lock
* timeout or embedded attempt session takeover) rather than a provider/model
* failure. The model fallback chain must abort on these instead of consuming
* candidate slots — retrying any model would hit the same local condition.
* See #83510.
*/
function isNonProviderRuntimeCoordinationError(err) {
	if (!hasSessionWriteLockTimeout(err) && !hasEmbeddedAttemptSessionTakeover(err)) return false;
	if (isFailoverError(err)) return false;
	return resolveFailoverClassificationFromError(err) === null;
}
function hasTimeoutHint(err) {
	if (!err) return false;
	if (hasSessionWriteLockTimeout(err)) return false;
	if (readErrorName(err) === "TimeoutError") return true;
	const message = getErrorMessage(err);
	return Boolean(message && isTimeoutErrorMessage(message));
}
function isTimeoutError(err) {
	if (hasTimeoutHint(err)) return true;
	if (!err || typeof err !== "object") return false;
	if (readErrorName(err) !== "AbortError") return false;
	if (hasSessionWriteLockTimeout(err)) return false;
	const message = getErrorMessage(err);
	if (message && ABORT_TIMEOUT_RE.test(message)) return true;
	const cause = "cause" in err ? err.cause : void 0;
	const reason = "reason" in err ? err.reason : void 0;
	return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}
function failoverReasonFromClassification(classification) {
	return classification?.kind === "reason" ? classification.reason : null;
}
function normalizeErrorSignal(err, providerHint) {
	const message = getErrorMessage(err);
	return {
		status: getStatusCode(err),
		code: getErrorCode(err),
		message: message || void 0,
		provider: getProvider(err) ?? providerHint
	};
}
function getNestedErrorCandidates(err) {
	if (!err || typeof err !== "object") return [];
	const candidate = err;
	return [candidate.error, candidate.cause].filter((value) => value !== void 0 && value !== err);
}
function isFormatClassification(classification) {
	return classification?.kind === "reason" && classification.reason === "format";
}
function decideNestedFormatOverride(candidate, inheritedStatus, seen, depth) {
	if (depth > MAX_FAILOVER_CAUSE_DEPTH) return null;
	if (candidate && typeof candidate === "object") {
		if (seen.has(candidate)) return null;
		seen.add(candidate);
	}
	const directSignal = normalizeDirectErrorSignal(candidate);
	const nestedCandidates = getNestedErrorCandidates(candidate);
	const nestedStatus = directSignal.status ?? inheritedStatus;
	const hasDirectMessage = Boolean(directSignal.message?.trim());
	if (hasDirectMessage && isUnclassifiedNoBodyHttpSignal({
		...directSignal,
		status: nestedStatus
	})) return true;
	if (hasDirectMessage && (nestedCandidates.length === 0 || classifyFailoverSignal(directSignal))) return false;
	for (const nestedCandidate of nestedCandidates) {
		const decision = decideNestedFormatOverride(nestedCandidate, nestedStatus, seen, depth + 1);
		if (decision !== null) return decision;
	}
	return null;
}
function resolveFailoverClassificationFromErrorInternal(err, seen, depth, providerHint) {
	if (depth > MAX_FAILOVER_CAUSE_DEPTH) return null;
	if (err && typeof err === "object") {
		if (seen.has(err)) return null;
		seen.add(err);
	}
	if (isFailoverError(err)) return {
		kind: "reason",
		reason: err.reason
	};
	const signal = normalizeErrorSignal(err, providerHint);
	const codeReason = signal.code ? failoverReasonFromClassification(classifyFailoverSignal({ code: signal.code })) : null;
	const hasExplicitFailoverMetadata = typeof inferSignalStatus(signal) === "number" || codeReason !== null && codeReason !== "timeout";
	const hasSessionLock = hasSessionWriteLockTimeout(err);
	const classification = classifyFailoverSignal(signal);
	const nestedCandidates = getNestedErrorCandidates(err);
	if (!classification || classification.kind === "context_overflow") for (const candidate of nestedCandidates) {
		const nestedClassification = resolveFailoverClassificationFromErrorInternal(candidate, seen, depth + 1, providerHint);
		if (nestedClassification) {
			if (hasSessionLock && !hasExplicitFailoverMetadata) return null;
			return nestedClassification;
		}
	}
	if (isFormatClassification(classification)) for (const candidate of nestedCandidates) {
		const shouldClearFormat = decideNestedFormatOverride(candidate, signal.status, seen, depth + 1);
		if (shouldClearFormat === true) return null;
		if (shouldClearFormat === false) break;
	}
	if (classification) {
		if (hasSessionLock && !hasExplicitFailoverMetadata) return null;
		return classification;
	}
	if (hasSessionLock) return null;
	if (isTimeoutError(err)) return {
		kind: "reason",
		reason: "timeout"
	};
	return null;
}
function resolveFailoverClassificationFromError(err, providerHint) {
	return resolveFailoverClassificationFromErrorInternal(err, /* @__PURE__ */ new Set(), 0, providerHint);
}
function resolveFailoverReasonFromError(err, providerHint) {
	return failoverReasonFromClassification(resolveFailoverClassificationFromError(err, providerHint));
}
function describeFailoverError(err) {
	if (isFailoverError(err)) return {
		message: err.message,
		rawError: err.rawError,
		reason: err.reason,
		status: err.status,
		code: err.code,
		provider: err.provider,
		model: err.model,
		profileId: err.profileId,
		sessionId: err.sessionId,
		lane: err.lane
	};
	const signal = normalizeErrorSignal(err);
	return {
		message: signal.message ?? String(err),
		reason: resolveFailoverReasonFromError(err) ?? void 0,
		status: signal.status,
		code: signal.code,
		provider: signal.provider
	};
}
function coerceToFailoverError(err, context) {
	if (isFailoverError(err)) return err;
	const reason = resolveFailoverReasonFromError(err, context?.provider);
	if (!reason) return null;
	const signal = normalizeErrorSignal(err);
	const message = signal.message ?? String(err);
	const status = signal.status ?? resolveFailoverStatus(reason);
	const code = signal.code;
	const shouldSuspend = Boolean(context?.sessionId) && (reason === "rate_limit" || reason === "billing");
	return new FailoverError(message, {
		reason,
		provider: context?.provider ?? signal.provider,
		model: context?.model,
		profileId: context?.profileId,
		sessionId: context?.sessionId,
		lane: context?.lane,
		status,
		code,
		rawError: message,
		cause: err instanceof Error ? err : void 0,
		suspend: shouldSuspend
	});
}
//#endregion
export { isNonProviderRuntimeCoordinationError as a, resolveFailoverStatus as c, isFailoverError as i, coerceToFailoverError as n, isTimeoutError as o, describeFailoverError as r, resolveFailoverReasonFromError as s, FailoverError as t };
