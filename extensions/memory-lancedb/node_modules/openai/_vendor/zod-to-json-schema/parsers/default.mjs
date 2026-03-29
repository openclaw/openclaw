import { parseDef } from "../parseDef.mjs";
export function parseDefaultDef(_def, refs) {
    return {
        ...parseDef(_def.innerType._def, refs),
        default: _def.defaultValue(),
    };
}
//# sourceMappingURL=default.mjs.map