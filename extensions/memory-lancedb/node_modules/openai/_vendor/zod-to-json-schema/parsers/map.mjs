import { parseDef } from "../parseDef.mjs";
import { parseRecordDef } from "./record.mjs";
export function parseMapDef(def, refs) {
    if (refs.mapStrategy === 'record') {
        return parseRecordDef(def, refs);
    }
    const keys = parseDef(def.keyType._def, {
        ...refs,
        currentPath: [...refs.currentPath, 'items', 'items', '0'],
    }) || {};
    const values = parseDef(def.valueType._def, {
        ...refs,
        currentPath: [...refs.currentPath, 'items', 'items', '1'],
    }) || {};
    return {
        type: 'array',
        maxItems: 125,
        items: {
            type: 'array',
            items: [keys, values],
            minItems: 2,
            maxItems: 2,
        },
    };
}
//# sourceMappingURL=map.mjs.map