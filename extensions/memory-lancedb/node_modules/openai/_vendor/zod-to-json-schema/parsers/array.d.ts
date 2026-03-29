import { ZodArrayDef } from 'zod/v3';
import { ErrorMessages } from "../errorMessages.js";
import { JsonSchema7Type } from "../parseDef.js";
import { Refs } from "../Refs.js";
export type JsonSchema7ArrayType = {
    type: 'array';
    items?: JsonSchema7Type | undefined;
    minItems?: number;
    maxItems?: number;
    errorMessages?: ErrorMessages<JsonSchema7ArrayType, 'items'>;
};
export declare function parseArrayDef(def: ZodArrayDef, refs: Refs): JsonSchema7ArrayType;
//# sourceMappingURL=array.d.ts.map