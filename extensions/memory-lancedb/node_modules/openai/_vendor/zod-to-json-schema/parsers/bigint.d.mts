import { ZodBigIntDef } from 'zod/v3';
import { Refs } from "../Refs.mjs";
import { ErrorMessages } from "../errorMessages.mjs";
export type JsonSchema7BigintType = {
    type: 'integer';
    format: 'int64';
    minimum?: BigInt;
    exclusiveMinimum?: BigInt;
    maximum?: BigInt;
    exclusiveMaximum?: BigInt;
    multipleOf?: BigInt;
    errorMessage?: ErrorMessages<JsonSchema7BigintType>;
};
export declare function parseBigintDef(def: ZodBigIntDef, refs: Refs): JsonSchema7BigintType;
//# sourceMappingURL=bigint.d.mts.map