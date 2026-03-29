import { parseDef } from "../parseDef.mjs";
export const parseOptionalDef = (def, refs) => {
    if (refs.propertyPath &&
        refs.currentPath.slice(0, refs.propertyPath.length).toString() === refs.propertyPath.toString()) {
        return parseDef(def.innerType._def, { ...refs, currentPath: refs.currentPath });
    }
    const innerSchema = parseDef(def.innerType._def, {
        ...refs,
        currentPath: [...refs.currentPath, 'anyOf', '1'],
    });
    return innerSchema ?
        {
            anyOf: [
                {
                    not: {},
                },
                innerSchema,
            ],
        }
        : {};
};
//# sourceMappingURL=optional.mjs.map