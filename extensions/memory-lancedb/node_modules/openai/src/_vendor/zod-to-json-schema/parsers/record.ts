import { ZodFirstPartyTypeKind, ZodMapDef, ZodRecordDef, ZodTypeAny } from 'zod/v3';
import { JsonSchema7Type, parseDef } from '../parseDef';
import { Refs } from '../Refs';
import { JsonSchema7EnumType } from './enum';
import { JsonSchema7ObjectType } from './object';
import { JsonSchema7StringType, parseStringDef } from './string';

type JsonSchema7RecordPropertyNamesType =
  | Omit<JsonSchema7StringType, 'type'>
  | Omit<JsonSchema7EnumType, 'type'>;

export type JsonSchema7RecordType = {
  type: 'object';
  additionalProperties: JsonSchema7Type;
  propertyNames?: JsonSchema7RecordPropertyNamesType;
};

export function parseRecordDef(
  def: ZodRecordDef<ZodTypeAny, ZodTypeAny> | ZodMapDef,
  refs: Refs,
): JsonSchema7RecordType {
  if (refs.target === 'openApi3' && def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodEnum) {
    return {
      type: 'object',
      required: def.keyType._def.values,
      properties: def.keyType._def.values.reduce(
        (acc: Record<string, JsonSchema7Type>, key: string) => ({
          ...acc,
          [key]:
            parseDef(def.valueType._def, {
              ...refs,
              currentPath: [...refs.currentPath, 'properties', key],
            }) ?? {},
        }),
        {},
      ),
      additionalProperties: false,
    } satisfies JsonSchema7ObjectType as any;
  }

  const schema: JsonSchema7RecordType = {
    type: 'object',
    additionalProperties:
      parseDef(def.valueType._def, {
        ...refs,
        currentPath: [...refs.currentPath, 'additionalProperties'],
      }) ?? {},
  };

  if (refs.target === 'openApi3') {
    return schema;
  }

  if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodString && def.keyType._def.checks?.length) {
    const keyType: JsonSchema7RecordPropertyNamesType = Object.entries(
      parseStringDef(def.keyType._def, refs),
    ).reduce((acc, [key, value]) => (key === 'type' ? acc : { ...acc, [key]: value }), {});

    return {
      ...schema,
      propertyNames: keyType,
    };
  } else if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodEnum) {
    return {
      ...schema,
      propertyNames: {
        enum: def.keyType._def.values,
      },
    };
  }

  return schema;
}
