"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRecordDef = parseRecordDef;
const v3_1 = require("zod/v3");
const parseDef_1 = require("../parseDef.js");
const string_1 = require("./string.js");
function parseRecordDef(def, refs) {
    if (refs.target === 'openApi3' && def.keyType?._def.typeName === v3_1.ZodFirstPartyTypeKind.ZodEnum) {
        return {
            type: 'object',
            required: def.keyType._def.values,
            properties: def.keyType._def.values.reduce((acc, key) => ({
                ...acc,
                [key]: (0, parseDef_1.parseDef)(def.valueType._def, {
                    ...refs,
                    currentPath: [...refs.currentPath, 'properties', key],
                }) ?? {},
            }), {}),
            additionalProperties: false,
        };
    }
    const schema = {
        type: 'object',
        additionalProperties: (0, parseDef_1.parseDef)(def.valueType._def, {
            ...refs,
            currentPath: [...refs.currentPath, 'additionalProperties'],
        }) ?? {},
    };
    if (refs.target === 'openApi3') {
        return schema;
    }
    if (def.keyType?._def.typeName === v3_1.ZodFirstPartyTypeKind.ZodString && def.keyType._def.checks?.length) {
        const keyType = Object.entries((0, string_1.parseStringDef)(def.keyType._def, refs)).reduce((acc, [key, value]) => (key === 'type' ? acc : { ...acc, [key]: value }), {});
        return {
            ...schema,
            propertyNames: keyType,
        };
    }
    else if (def.keyType?._def.typeName === v3_1.ZodFirstPartyTypeKind.ZodEnum) {
        return {
            ...schema,
            propertyNames: {
                enum: def.keyType._def.values,
            },
        };
    }
    return schema;
}
//# sourceMappingURL=record.js.map