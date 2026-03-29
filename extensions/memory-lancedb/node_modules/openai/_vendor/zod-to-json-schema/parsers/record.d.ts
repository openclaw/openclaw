import { ZodMapDef, ZodRecordDef, ZodTypeAny } from 'zod/v3';
import { JsonSchema7Type } from "../parseDef.js";
import { Refs } from "../Refs.js";
import { JsonSchema7EnumType } from "./enum.js";
import { JsonSchema7StringType } from "./string.js";
type JsonSchema7RecordPropertyNamesType = Omit<JsonSchema7StringType, 'type'> | Omit<JsonSchema7EnumType, 'type'>;
export type JsonSchema7RecordType = {
    type: 'object';
    additionalProperties: JsonSchema7Type;
    propertyNames?: JsonSchema7RecordPropertyNamesType;
};
export declare function parseRecordDef(def: ZodRecordDef<ZodTypeAny, ZodTypeAny> | ZodMapDef, refs: Refs): JsonSchema7RecordType;
export {};
//# sourceMappingURL=record.d.ts.map