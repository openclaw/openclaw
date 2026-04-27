import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveOpenAIReasoningEffortForModel } from "./openai-reasoning-effort.js";
const OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS = new Set(["gpt-5.1-codex-mini"]);
function readCompatReasoningEffortMap(compat) {
    if (!compat || typeof compat !== "object") {
        return {};
    }
    const rawMap = compat.reasoningEffortMap;
    if (!rawMap || typeof rawMap !== "object") {
        return {};
    }
    return Object.fromEntries(Object.entries(rawMap).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string"));
}
export function resolveOpenAIReasoningEffortMap(model, fallbackMap = {}) {
    const provider = normalizeLowercaseStringOrEmpty(model.provider ?? "");
    const id = normalizeLowercaseStringOrEmpty(model.id ?? "");
    const builtinMap = (provider === "openai" || provider === "openai-codex") &&
        OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS.has(id)
        ? { minimal: "medium", low: "medium" }
        : {};
    return {
        ...fallbackMap,
        ...builtinMap,
        ...readCompatReasoningEffortMap(model.compat),
    };
}
export function mapOpenAIReasoningEffortForModel(params) {
    const { effort } = params;
    if (effort === undefined) {
        return effort;
    }
    return resolveOpenAIReasoningEffortForModel({
        model: params.model,
        effort,
        fallbackMap: resolveOpenAIReasoningEffortMap(params.model, params.fallbackMap),
    });
}
