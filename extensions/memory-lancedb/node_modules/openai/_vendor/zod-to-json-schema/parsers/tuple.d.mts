import { ZodTupleDef, ZodTupleItems, ZodTypeAny } from 'zod/v3';
import { JsonSchema7Type } from "../parseDef.mjs";
import { Refs } from "../Refs.mjs";
export type JsonSchema7TupleType = {
    type: 'array';
    minItems: number;
    items: JsonSchema7Type[];
} & ({
    maxItems: number;
} | {
    additionalItems?: JsonSchema7Type | undefined;
});
export declare function parseTupleDef(def: ZodTupleDef<ZodTupleItems | [], ZodTypeAny | null>, refs: Refs): JsonSchema7TupleType;
//# sourceMappingURL=tuple.d.mts.map