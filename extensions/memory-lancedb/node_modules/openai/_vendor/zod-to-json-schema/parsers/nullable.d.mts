import { ZodNullableDef } from 'zod/v3';
import { JsonSchema7Type } from "../parseDef.mjs";
import { Refs } from "../Refs.mjs";
import { JsonSchema7NullType } from "./null.mjs";
export type JsonSchema7NullableType = {
    anyOf: [JsonSchema7Type, JsonSchema7NullType];
} | {
    type: [string, 'null'];
};
export declare function parseNullableDef(def: ZodNullableDef, refs: Refs): JsonSchema7NullableType | undefined;
//# sourceMappingURL=nullable.d.mts.map