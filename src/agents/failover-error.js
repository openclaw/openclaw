import { readErrorName } from "../infra/errors.js";
import { classifyFailoverSignal, inferSignalStatus, isUnclassifiedNoBodyHttpSignal, } from "./pi-embedded-helpers/errors.js";
import { isTimeoutErrorMessage } from "./pi-embedded-helpers/errors.js";
import { isSessionWriteLockTimeoutError } from "./session-write-lock-error.js";
const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;
const MAX_FAILOVER_CAUSE_DEPTH = 25;
export class FailoverError extends Error {
    reason;
    provider;
    model;
    profileId;
    status;
    code;
    rawError;
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
    }
}
export function isFailoverError(err) {
    if (err instanceof FailoverError) {
        return true;
    }
    return Boolean(err &&
        typeof err === "object" &&
        err.name === "FailoverError" &&
        typeof err.reason === "string");
}
export function resolveFailoverStatus(reason) {
    switch (reason) {
        case "billing":
            return 402;
        case "rate_limit":
            return 429;
        case "overloaded":
            return 503;
        case "auth":
            return 401;
        case "auth_permanent":
            return 403;
        case "timeout":
            return 408;
        case "format":
            return 400;
        case "model_not_found":
            return 404;
        case "session_expired":
            return 410; // Gone - session no longer exists
        default:
            return undefined;
    }
}
function findErrorProperty(err, reader, seen = new Set()) {
    const direct = reader(err);
    if (direct !== undefined) {
        return direct;
    }
    if (!err || typeof err !== "object") {
        return undefined;
    }
    if (seen.has(err)) {
        return undefined;
    }
    seen.add(err);
    const candidate = err;
    return (findErrorProperty(candidate.error, reader, seen) ??
        findErrorProperty(candidate.cause, reader, seen));
}
function readDirectStatusCode(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const candidate = err.status ??
        err.statusCode;
    if (typeof candidate === "number") {
        return candidate;
    }
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
        return Number(candidate);
    }
    return undefined;
}
function getStatusCode(err) {
    return findErrorProperty(err, readDirectStatusCode);
}
function readDirectErrorCode(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const directCode = err.code;
    if (typeof directCode === "string") {
        const trimmed = directCode.trim();
        return trimmed ? trimmed : undefined;
    }
    const status = err.status;
    if (typeof status !== "string" || /^\d+$/.test(status)) {
        return undefined;
    }
    const trimmed = status.trim();
    return trimmed ? trimmed : undefined;
}
function getErrorCode(err) {
    return findErrorProperty(err, readDirectErrorCode);
}
function readDirectProvider(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const provider = err.provider;
    if (typeof provider !== "string") {
        return undefined;
    }
    const trimmed = provider.trim();
    return trimmed || undefined;
}
function getProvider(err) {
    return findErrorProperty(err, readDirectProvider);
}
function readDirectErrorMessage(err) {
    if (err instanceof Error) {
        return err.message || undefined;
    }
    if (typeof err === "string") {
        return err || undefined;
    }
    if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
        return String(err);
    }
    if (typeof err === "symbol") {
        return err.description ?? undefined;
    }
    if (err && typeof err === "object") {
        const message = err.message;
        if (typeof message === "string") {
            return message || undefined;
        }
    }
    return undefined;
}
function getErrorMessage(err) {
    return findErrorProperty(err, readDirectErrorMessage) ?? "";
}
function normalizeDirectErrorSignal(err) {
    const message = readDirectErrorMessage(err);
    return {
        status: readDirectStatusCode(err),
        code: readDirectErrorCode(err),
        message: message || undefined,
        provider: readDirectProvider(err),
    };
}
function hasSessionWriteLockTimeout(err, seen = new Set()) {
    if (isSessionWriteLockTimeoutError(err)) {
        return true;
    }
    if (!err || typeof err !== "object") {
        return false;
    }
    if (seen.has(err)) {
        return false;
    }
    seen.add(err);
    const candidate = err;
    return (hasSessionWriteLockTimeout(candidate.error, seen) ||
        hasSessionWriteLockTimeout(candidate.cause, seen) ||
        hasSessionWriteLockTimeout(candidate.reason, seen));
}
function hasTimeoutHint(err) {
    if (!err) {
        return false;
    }
    if (hasSessionWriteLockTimeout(err)) {
        return false;
    }
    if (readErrorName(err) === "TimeoutError") {
        return true;
    }
    const message = getErrorMessage(err);
    return Boolean(message && isTimeoutErrorMessage(message));
}
export function isTimeoutError(err) {
    if (hasTimeoutHint(err)) {
        return true;
    }
    if (!err || typeof err !== "object") {
        return false;
    }
    if (readErrorName(err) !== "AbortError") {
        return false;
    }
    if (hasSessionWriteLockTimeout(err)) {
        return false;
    }
    const message = getErrorMessage(err);
    if (message && ABORT_TIMEOUT_RE.test(message)) {
        return true;
    }
    const cause = "cause" in err ? err.cause : undefined;
    const reason = "reason" in err ? err.reason : undefined;
    return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}
function failoverReasonFromClassification(classification) {
    return classification?.kind === "reason" ? classification.reason : null;
}
function normalizeErrorSignal(err) {
    const message = getErrorMessage(err);
    return {
        status: getStatusCode(err),
        code: getErrorCode(err),
        message: message || undefined,
        provider: getProvider(err),
    };
}
function getNestedErrorCandidates(err) {
    if (!err || typeof err !== "object") {
        return [];
    }
    const candidate = err;
    return [candidate.error, candidate.cause].filter((value) => value !== undefined && value !== err);
}
function isFormatClassification(classification) {
    return classification?.kind === "reason" && classification.reason === "format";
}
function decideNestedFormatOverride(candidate, inheritedStatus, seen, depth) {
    if (depth > MAX_FAILOVER_CAUSE_DEPTH) {
        return null;
    }
    if (candidate && typeof candidate === "object") {
        if (seen.has(candidate)) {
            return null;
        }
        seen.add(candidate);
    }
    const directSignal = normalizeDirectErrorSignal(candidate);
    const nestedCandidates = getNestedErrorCandidates(candidate);
    const nestedStatus = directSignal.status ?? inheritedStatus;
    const hasDirectMessage = Boolean(directSignal.message?.trim());
    if (hasDirectMessage &&
        isUnclassifiedNoBodyHttpSignal({ ...directSignal, status: nestedStatus })) {
        return true;
    }
    if (hasDirectMessage && (nestedCandidates.length === 0 || classifyFailoverSignal(directSignal))) {
        return false;
    }
    for (const nestedCandidate of nestedCandidates) {
        const decision = decideNestedFormatOverride(nestedCandidate, nestedStatus, seen, depth + 1);
        if (decision !== null) {
            return decision;
        }
    }
    return null;
}
function resolveFailoverClassificationFromErrorInternal(err, seen, depth) {
    if (depth > MAX_FAILOVER_CAUSE_DEPTH) {
        return null;
    }
    if (err && typeof err === "object") {
        if (seen.has(err)) {
            return null;
        }
        seen.add(err);
    }
    if (isFailoverError(err)) {
        return {
            kind: "reason",
            reason: err.reason,
        };
    }
    const signal = normalizeErrorSignal(err);
    const codeReason = signal.code
        ? failoverReasonFromClassification(classifyFailoverSignal({ code: signal.code }))
        : null;
    const hasExplicitFailoverMetadata = typeof inferSignalStatus(signal) === "number" ||
        (codeReason !== null && codeReason !== "timeout");
    const hasSessionLock = hasSessionWriteLockTimeout(err);
    const classification = classifyFailoverSignal(signal);
    const nestedCandidates = getNestedErrorCandidates(err);
    if (!classification || classification.kind === "context_overflow") {
        for (const candidate of nestedCandidates) {
            const nestedClassification = resolveFailoverClassificationFromErrorInternal(candidate, seen, depth + 1);
            if (nestedClassification) {
                if (hasSessionLock && !hasExplicitFailoverMetadata) {
                    return null;
                }
                return nestedClassification;
            }
        }
    }
    if (isFormatClassification(classification)) {
        for (const candidate of nestedCandidates) {
            const shouldClearFormat = decideNestedFormatOverride(candidate, signal.status, seen, depth + 1);
            if (shouldClearFormat === true) {
                return null;
            }
            if (shouldClearFormat === false) {
                break;
            }
        }
    }
    if (classification) {
        if (hasSessionLock && !hasExplicitFailoverMetadata) {
            return null;
        }
        return classification;
    }
    if (hasSessionLock) {
        return null;
    }
    if (isTimeoutError(err)) {
        return {
            kind: "reason",
            reason: "timeout",
        };
    }
    return null;
}
function resolveFailoverClassificationFromError(err) {
    return resolveFailoverClassificationFromErrorInternal(err, new Set(), 0);
}
export function resolveFailoverReasonFromError(err) {
    return failoverReasonFromClassification(resolveFailoverClassificationFromError(err));
}
export function describeFailoverError(err) {
    if (isFailoverError(err)) {
        return {
            message: err.message,
            rawError: err.rawError,
            reason: err.reason,
            status: err.status,
            code: err.code,
        };
    }
    const signal = normalizeErrorSignal(err);
    const message = signal.message ?? String(err);
    return {
        message,
        reason: resolveFailoverReasonFromError(err) ?? undefined,
        status: signal.status,
        code: signal.code,
    };
}
export function coerceToFailoverError(err, context) {
    if (isFailoverError(err)) {
        return err;
    }
    const reason = resolveFailoverReasonFromError(err);
    if (!reason) {
        return null;
    }
    const signal = normalizeErrorSignal(err);
    const message = signal.message ?? String(err);
    const status = signal.status ?? resolveFailoverStatus(reason);
    const code = signal.code;
    return new FailoverError(message, {
        reason,
        provider: context?.provider,
        model: context?.model,
        profileId: context?.profileId,
        status,
        code,
        rawError: message,
        cause: err instanceof Error ? err : undefined,
    });
}
