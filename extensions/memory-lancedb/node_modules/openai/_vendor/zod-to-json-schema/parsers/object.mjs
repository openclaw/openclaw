import { parseDef } from "../parseDef.mjs";
function decideAdditionalProperties(def, refs) {
    if (refs.removeAdditionalStrategy === 'strict') {
        return def.catchall._def.typeName === 'ZodNever' ?
            def.unknownKeys !== 'strict'
            : parseDef(def.catchall._def, {
                ...refs,
                currentPath: [...refs.currentPath, 'additionalProperties'],
            }) ?? true;
    }
    else {
        return def.catchall._def.typeName === 'ZodNever' ?
            def.unknownKeys === 'passthrough'
            : parseDef(def.catchall._def, {
                ...refs,
                currentPath: [...refs.currentPath, 'additionalProperties'],
            }) ?? true;
    }
}
export function parseObjectDef(def, refs) {
    const result = {
        type: 'object',
        ...Object.entries(def.shape()).reduce((acc, [propName, propDef]) => {
            if (propDef === undefined || propDef._def === undefined)
                return acc;
            const propertyPath = [...refs.currentPath, 'properties', propName];
            const parsedDef = parseDef(propDef._def, {
                ...refs,
                currentPath: propertyPath,
                propertyPath,
            });
            if (parsedDef === undefined)
                return acc;
            if (refs.openaiStrictMode &&
                propDef.isOptional() &&
                !propDef.isNullable() &&
                typeof propDef._def?.defaultValue === 'undefined') {
                throw new Error(`Zod field at \`${propertyPath.join('/')}\` uses \`.optional()\` without \`.nullable()\` which is not supported by the API. See: https://platform.openai.com/docs/guides/structured-outputs?api-mode=responses#all-fields-must-be-required`);
            }
            return {
                properties: {
                    ...acc.properties,
                    [propName]: parsedDef,
                },
                required: propDef.isOptional() && !refs.openaiStrictMode ? acc.required : [...acc.required, propName],
            };
        }, { properties: {}, required: [] }),
        additionalProperties: decideAdditionalProperties(def, refs),
    };
    if (!result.required.length)
        delete result.required;
    return result;
}
//# sourceMappingURL=object.mjs.map