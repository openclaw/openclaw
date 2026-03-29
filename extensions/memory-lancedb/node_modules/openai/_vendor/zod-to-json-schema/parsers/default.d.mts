import { ZodDefaultDef } from 'zod/v3';
import { JsonSchema7Type } from "../parseDef.mjs";
import { Refs } from "../Refs.mjs";
export declare function parseDefaultDef(_def: ZodDefaultDef, refs: Refs): JsonSchema7Type & {
    default: any;
};
//# sourceMappingURL=default.d.mts.map