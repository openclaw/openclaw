import { parseDef } from "../parseDef.mjs";
export function parseBrandedDef(_def, refs) {
    return parseDef(_def.type._def, refs);
}
//# sourceMappingURL=branded.mjs.map