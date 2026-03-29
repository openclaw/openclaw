"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMapDef = parseMapDef;
const parseDef_1 = require("../parseDef.js");
const record_1 = require("./record.js");
function parseMapDef(def, refs) {
    if (refs.mapStrategy === 'record') {
        return (0, record_1.parseRecordDef)(def, refs);
    }
    const keys = (0, parseDef_1.parseDef)(def.keyType._def, {
        ...refs,
        currentPath: [...refs.currentPath, 'items', 'items', '0'],
    }) || {};
    const values = (0, parseDef_1.parseDef)(def.valueType._def, {
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
//# sourceMappingURL=map.js.map