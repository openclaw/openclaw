import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
const ALL_OPENAI_REASONING_EFFORTS = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
];
const GPT_5_REASONING_EFFORTS = ["minimal", "low", "medium", "high"];
const GPT_51_REASONING_EFFORTS = ["none", "low", "medium", "high"];
const GPT_52_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
const GPT_CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const GPT_PRO_REASONING_EFFORTS = ["medium", "high", "xhigh"];
const GPT_5_PRO_REASONING_EFFORTS = ["high"];
const GPT_51_CODEX_MAX_REASONING_EFFORTS = ["none", "medium", "high", "xhigh"];
const GPT_51_CODEX_MINI_REASONING_EFFORTS = ["medium"];
const GENERIC_REASONING_EFFORTS = ["low", "medium", "high"];
function normalizeModelId(id) {
    return normalizeLowercaseStringOrEmpty(id ?? "").replace(/-\d{4}-\d{2}-\d{2}$/u, "");
}
export function normalizeOpenAIReasoningEffort(effort) {
    return effort === "minimal" ? "minimal" : effort;
}
function readCompatReasoningEfforts(compat) {
    if (!compat || typeof compat !== "object") {
        return undefined;
    }
    const raw = compat.supportedReasoningEfforts;
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const supported = raw.filter((value) => ALL_OPENAI_REASONING_EFFORTS.includes(value));
    return supported.length > 0 ? supported : undefined;
}
export function resolveOpenAISupportedReasoningEfforts(model) {
    const compatEfforts = readCompatReasoningEfforts(model.compat);
    if (compatEfforts) {
        return compatEfforts;
    }
    const provider = normalizeLowercaseStringOrEmpty(typeof model.provider === "string" ? model.provider : "");
    const id = normalizeModelId(typeof model.id === "string" ? model.id : undefined);
    if (id === "gpt-5.1-codex-mini") {
        return GPT_51_CODEX_MINI_REASONING_EFFORTS;
    }
    if (id === "gpt-5.1-codex-max") {
        return GPT_51_CODEX_MAX_REASONING_EFFORTS;
    }
    if (/^gpt-5(?:\.\d+)?-codex(?:-|$)/u.test(id) || provider === "openai-codex") {
        return GPT_CODEX_REASONING_EFFORTS;
    }
    if (id === "gpt-5-pro") {
        return GPT_5_PRO_REASONING_EFFORTS;
    }
    if (/^gpt-5\.[2-9](?:\.\d+)?-pro(?:-|$)/u.test(id)) {
        return GPT_PRO_REASONING_EFFORTS;
    }
    if (/^gpt-5\.[2-9](?:\.\d+)?(?:-|$)/u.test(id)) {
        return GPT_52_REASONING_EFFORTS;
    }
    if (/^gpt-5\.1(?:-|$)/u.test(id)) {
        return GPT_51_REASONING_EFFORTS;
    }
    if (/^gpt-5(?:-|$)/u.test(id)) {
        return GPT_5_REASONING_EFFORTS;
    }
    return GENERIC_REASONING_EFFORTS;
}
export function supportsOpenAIReasoningEffort(model, effort) {
    return resolveOpenAISupportedReasoningEfforts(model).includes(normalizeOpenAIReasoningEffort(effort));
}
export function resolveOpenAIReasoningEffortForModel(params) {
    const requested = normalizeOpenAIReasoningEffort(params.effort);
    const mapped = params.fallbackMap?.[requested] ?? requested;
    const normalized = normalizeOpenAIReasoningEffort(mapped);
    const supported = resolveOpenAISupportedReasoningEfforts(params.model);
    if (supported.includes(normalized)) {
        return normalized;
    }
    if (requested === "none") {
        return undefined;
    }
    if (requested === "minimal" && supported.includes("low")) {
        return "low";
    }
    if ((requested === "minimal" || requested === "low") && supported.includes("medium")) {
        return "medium";
    }
    if (requested === "xhigh" && supported.includes("high")) {
        return "high";
    }
    return supported.find((effort) => effort !== "none");
}
