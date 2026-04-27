function unionAllow(base, extra) {
    if (!Array.isArray(extra) || extra.length === 0) {
        return base;
    }
    if (!Array.isArray(base)) {
        return Array.from(new Set(["*", ...extra]));
    }
    if (base.length === 0) {
        return Array.from(new Set(["*", ...extra]));
    }
    return Array.from(new Set([...base, ...extra]));
}
export function pickSandboxToolPolicy(config) {
    if (!config) {
        return undefined;
    }
    const allow = Array.isArray(config.allow)
        ? unionAllow(config.allow, config.alsoAllow)
        : Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0
            ? unionAllow(undefined, config.alsoAllow)
            : undefined;
    const deny = Array.isArray(config.deny) ? config.deny : undefined;
    if (!allow && !deny) {
        return undefined;
    }
    return { allow, deny };
}
