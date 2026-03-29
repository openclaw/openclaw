import { parseDef } from "../parseDef.mjs";
export function parsePromiseDef(def, refs) {
    return parseDef(def.type._def, refs);
}
//# sourceMappingURL=promise.mjs.map