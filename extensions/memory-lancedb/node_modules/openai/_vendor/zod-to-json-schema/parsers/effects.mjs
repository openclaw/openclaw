import { parseDef } from "../parseDef.mjs";
export function parseEffectsDef(_def, refs, forceResolution) {
    return refs.effectStrategy === 'input' ? parseDef(_def.schema._def, refs, forceResolution) : {};
}
//# sourceMappingURL=effects.mjs.map