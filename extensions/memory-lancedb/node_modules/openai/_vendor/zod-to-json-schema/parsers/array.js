"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArrayDef = parseArrayDef;
const v3_1 = require("zod/v3");
const errorMessages_1 = require("../errorMessages.js");
const parseDef_1 = require("../parseDef.js");
function parseArrayDef(def, refs) {
    const res = {
        type: 'array',
    };
    if (def.type?._def?.typeName !== v3_1.ZodFirstPartyTypeKind.ZodAny) {
        res.items = (0, parseDef_1.parseDef)(def.type._def, {
            ...refs,
            currentPath: [...refs.currentPath, 'items'],
        });
    }
    if (def.minLength) {
        (0, errorMessages_1.setResponseValueAndErrors)(res, 'minItems', def.minLength.value, def.minLength.message, refs);
    }
    if (def.maxLength) {
        (0, errorMessages_1.setResponseValueAndErrors)(res, 'maxItems', def.maxLength.value, def.maxLength.message, refs);
    }
    if (def.exactLength) {
        (0, errorMessages_1.setResponseValueAndErrors)(res, 'minItems', def.exactLength.value, def.exactLength.message, refs);
        (0, errorMessages_1.setResponseValueAndErrors)(res, 'maxItems', def.exactLength.value, def.exactLength.message, refs);
    }
    return res;
}
//# sourceMappingURL=array.js.map