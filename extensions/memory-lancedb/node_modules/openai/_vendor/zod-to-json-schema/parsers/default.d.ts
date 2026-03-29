import { ZodDefaultDef } from 'zod/v3';
import { JsonSchema7Type } from "../parseDef.js";
import { Refs } from "../Refs.js";
export declare function parseDefaultDef(_def: ZodDefaultDef, refs: Refs): JsonSchema7Type & {
    default: any;
};
//# sourceMappingURL=default.d.ts.map