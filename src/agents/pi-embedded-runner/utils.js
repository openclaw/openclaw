export function mapThinkingLevel(level) {
    // pi-agent-core supports "xhigh"; OpenClaw enables it for specific models.
    if (!level) {
        return "off";
    }
    // "adaptive" maps to "medium" at the pi-agent-core layer.  The Pi SDK
    // provider then translates this to `thinking.type: "adaptive"` with
    // `output_config.effort: "medium"` for models that support it (Opus 4.6,
    // Sonnet 4.6).
    if (level === "adaptive") {
        return "medium";
    }
    return level;
}
export function describeUnknownError(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    try {
        const serialized = JSON.stringify(error);
        return serialized ?? "Unknown error";
    }
    catch {
        return "Unknown error";
    }
}
