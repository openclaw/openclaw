export function parseEnumDef(def) {
    return {
        type: 'string',
        enum: [...def.values],
    };
}
//# sourceMappingURL=enum.mjs.map