import { ZodPipelineDef } from 'zod/v3';
import { JsonSchema7Type } from "../parseDef.mjs";
import { Refs } from "../Refs.mjs";
import { JsonSchema7AllOfType } from "./intersection.mjs";
export declare const parsePipelineDef: (def: ZodPipelineDef<any, any>, refs: Refs) => JsonSchema7AllOfType | JsonSchema7Type | undefined;
//# sourceMappingURL=pipeline.d.mts.map