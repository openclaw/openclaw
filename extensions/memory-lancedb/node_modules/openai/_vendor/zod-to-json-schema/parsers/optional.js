"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseOptionalDef = void 0;
const parseDef_1 = require("../parseDef.js");
const parseOptionalDef = (def, refs) => {
    if (refs.propertyPath &&
        refs.currentPath.slice(0, refs.propertyPath.length).toString() === refs.propertyPath.toString()) {
        return (0, parseDef_1.parseDef)(def.innerType._def, { ...refs, currentPath: refs.currentPath });
    }
    const innerSchema = (0, parseDef_1.parseDef)(def.innerType._def, {
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
exports.parseOptionalDef = parseOptionalDef;
//# sourceMappingURL=optional.js.map