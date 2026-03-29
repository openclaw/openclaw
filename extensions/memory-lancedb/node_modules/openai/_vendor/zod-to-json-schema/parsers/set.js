"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSetDef = parseSetDef;
const errorMessages_1 = require("../errorMessages.js");
const parseDef_1 = require("../parseDef.js");
function parseSetDef(def, refs) {
    const items = (0, parseDef_1.parseDef)(def.valueType._def, {
        ...refs,
        currentPath: [...refs.currentPath, 'items'],
    });
    const schema = {
        type: 'array',
        uniqueItems: true,
        items,
    };
    if (def.minSize) {
        (0, errorMessages_1.setResponseValueAndErrors)(schema, 'minItems', def.minSize.value, def.minSize.message, refs);
    }
    if (def.maxSize) {
        (0, errorMessages_1.setResponseValueAndErrors)(schema, 'maxItems', def.maxSize.value, def.maxSize.message, refs);
    }
    return schema;
}
//# sourceMappingURL=set.js.map