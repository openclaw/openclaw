import { ZodSetDef } from 'zod/v3';
import { ErrorMessages } from "../errorMessages.mjs";
import { JsonSchema7Type } from "../parseDef.mjs";
import { Refs } from "../Refs.mjs";
export type JsonSchema7SetType = {
    type: 'array';
    uniqueItems: true;
    items?: JsonSchema7Type | undefined;
    minItems?: number;
    maxItems?: number;
    errorMessage?: ErrorMessages<JsonSchema7SetType>;
};
export declare function parseSetDef(def: ZodSetDef, refs: Refs): JsonSchema7SetType;
//# sourceMappingURL=set.d.mts.map