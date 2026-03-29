import { ZodMapDef, ZodRecordDef, ZodTypeAny } from 'zod/v3';
import { JsonSchema7Type } from "../parseDef.mjs";
import { Refs } from "../Refs.mjs";
import { JsonSchema7EnumType } from "./enum.mjs";
import { JsonSchema7StringType } from "./string.mjs";
type JsonSchema7RecordPropertyNamesType = Omit<JsonSchema7StringType, 'type'> | Omit<JsonSchema7EnumType, 'type'>;
export type JsonSchema7RecordType = {
    type: 'object';
    additionalProperties: JsonSchema7Type;
    propertyNames?: JsonSchema7RecordPropertyNamesType;
};
export declare function parseRecordDef(def: ZodRecordDef<ZodTypeAny, ZodTypeAny> | ZodMapDef, refs: Refs): JsonSchema7RecordType;
export {};
//# sourceMappingURL=record.d.mts.map