import { ZodFirstPartyTypeKind } from 'zod/v3';
import { parseDef } from "../parseDef.mjs";
import { parseStringDef } from "./string.mjs";
export function parseRecordDef(def, refs) {
    if (refs.target === 'openApi3' && def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodEnum) {
        return {
            type: 'object',
            required: def.keyType._def.values,
            properties: def.keyType._def.values.reduce((acc, key) => ({
                ...acc,
                [key]: parseDef(def.valueType._def, {
                    ...refs,
                    currentPath: [...refs.currentPath, 'properties', key],
                }) ?? {},
            }), {}),
            additionalProperties: false,
        };
    }
    const schema = {
        type: 'object',
        additionalProperties: parseDef(def.valueType._def, {
            ...refs,
            currentPath: [...refs.currentPath, 'additionalProperties'],
        }) ?? {},
    };
    if (refs.target === 'openApi3') {
        return schema;
    }
    if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodString && def.keyType._def.checks?.length) {
        const keyType = Object.entries(parseStringDef(def.keyType._def, refs)).reduce((acc, [key, value]) => (key === 'type' ? acc : { ...acc, [key]: value }), {});
        return {
            ...schema,
            propertyNames: keyType,
        };
    }
    else if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodEnum) {
        return {
            ...schema,
            propertyNames: {
                enum: def.keyType._def.values,
            },
        };
    }
    return schema;
}
//# sourceMappingURL=record.mjs.map