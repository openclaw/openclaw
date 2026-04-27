export function readPiModelContextTokens(model) {
    const value = model?.contextTokens;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
