import { ZodObjectDef } from 'zod/v3';
import { JsonSchema7Type } from "../parseDef.mjs";
import { Refs } from "../Refs.mjs";
export type JsonSchema7ObjectType = {
    type: 'object';
    properties: Record<string, JsonSchema7Type>;
    additionalProperties: boolean | JsonSchema7Type;
    required?: string[];
};
export declare function parseObjectDef(def: ZodObjectDef, refs: Refs): JsonSchema7ObjectType;
//# sourceMappingURL=object.d.mts.map