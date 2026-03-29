export const zodDef = (zodSchema) => {
    return '_def' in zodSchema ? zodSchema._def : zodSchema;
};
export function isEmptyObj(obj) {
    if (!obj)
        return true;
    for (const _k in obj)
        return false;
    return true;
}
//# sourceMappingURL=util.mjs.map