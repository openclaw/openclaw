export function supportsModelTools(model) {
    const compat = model.compat && typeof model.compat === "object"
        ? model.compat
        : undefined;
    return compat?.supportsTools !== false;
}
