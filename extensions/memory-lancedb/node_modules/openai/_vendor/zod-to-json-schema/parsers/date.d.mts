import { ZodDateDef } from 'zod/v3';
import { Refs } from "../Refs.mjs";
import { ErrorMessages } from "../errorMessages.mjs";
import { JsonSchema7NumberType } from "./number.mjs";
import { DateStrategy } from "../Options.mjs";
export type JsonSchema7DateType = {
    type: 'integer' | 'string';
    format: 'unix-time' | 'date-time' | 'date';
    minimum?: number;
    maximum?: number;
    errorMessage?: ErrorMessages<JsonSchema7NumberType>;
} | {
    anyOf: JsonSchema7DateType[];
};
export declare function parseDateDef(def: ZodDateDef, refs: Refs, overrideDateStrategy?: DateStrategy): JsonSchema7DateType;
//# sourceMappingURL=date.d.mts.map