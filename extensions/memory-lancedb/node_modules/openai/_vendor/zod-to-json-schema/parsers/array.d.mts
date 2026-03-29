import { ZodArrayDef } from 'zod/v3';
import { ErrorMessages } from "../errorMessages.mjs";
import { JsonSchema7Type } from "../parseDef.mjs";
import { Refs } from "../Refs.mjs";
export type JsonSchema7ArrayType = {
    type: 'array';
    items?: JsonSchema7Type | undefined;
    minItems?: number;
    maxItems?: number;
    errorMessages?: ErrorMessages<JsonSchema7ArrayType, 'items'>;
};
export declare function parseArrayDef(def: ZodArrayDef, refs: Refs): JsonSchema7ArrayType;
//# sourceMappingURL=array.d.mts.map