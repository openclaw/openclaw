import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { log } from "./pi-embedded-runner/logger.js";
function normalizeOpenAITextVerbosity(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = normalizeOptionalLowercaseString(value);
    if (normalized === "low" || normalized === "medium" || normalized === "high") {
        return normalized;
    }
    return undefined;
}
export function resolveOpenAITextVerbosity(extraParams) {
    const raw = extraParams?.textVerbosity ?? extraParams?.text_verbosity;
    const normalized = normalizeOpenAITextVerbosity(raw);
    if (raw !== undefined && normalized === undefined) {
        const rawSummary = typeof raw === "string" ? raw : typeof raw;
        log.warn(`ignoring invalid OpenAI text verbosity param: ${rawSummary}`);
    }
    return normalized;
}
