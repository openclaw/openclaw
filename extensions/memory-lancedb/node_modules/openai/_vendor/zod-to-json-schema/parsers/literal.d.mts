import { ZodLiteralDef } from 'zod/v3';
import { Refs } from "../Refs.mjs";
export type JsonSchema7LiteralType = {
    type: 'string' | 'number' | 'integer' | 'boolean';
    const: string | number | boolean;
} | {
    type: 'object' | 'array';
};
export declare function parseLiteralDef(def: ZodLiteralDef, refs: Refs): JsonSchema7LiteralType;
//# sourceMappingURL=literal.d.mts.map