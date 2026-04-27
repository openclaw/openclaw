export function mapThinkingLevelToReasoningEffort(thinkingLevel) {
    if (thinkingLevel === "off") {
        return "none";
    }
    if (thinkingLevel === "adaptive") {
        return "medium";
    }
    if (thinkingLevel === "max") {
        return "xhigh";
    }
    return thinkingLevel;
}
