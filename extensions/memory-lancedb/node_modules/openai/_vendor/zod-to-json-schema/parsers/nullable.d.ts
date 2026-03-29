import { ZodNullableDef } from 'zod/v3';
import { JsonSchema7Type } from "../parseDef.js";
import { Refs } from "../Refs.js";
import { JsonSchema7NullType } from "./null.js";
export type JsonSchema7NullableType = {
    anyOf: [JsonSchema7Type, JsonSchema7NullType];
} | {
    type: [string, 'null'];
};
export declare function parseNullableDef(def: ZodNullableDef, refs: Refs): JsonSchema7NullableType | undefined;
//# sourceMappingURL=nullable.d.ts.map