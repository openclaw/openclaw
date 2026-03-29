import { parseDef } from "../parseDef.mjs";
export const parseCatchDef = (def, refs) => {
    return parseDef(def.innerType._def, refs);
};
//# sourceMappingURL=catch.mjs.map