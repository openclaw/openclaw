import { ZodNullableDef } from 'zod/v3';
import { JsonSchema7Type, parseDef } from '../parseDef';
import { Refs } from '../Refs';
import { JsonSchema7NullType } from './null';
import { primitiveMappings } from './union';

export type JsonSchema7NullableType =
  | {
      anyOf: [JsonSchema7Type, JsonSchema7NullType];
    }
  | {
      type: [string, 'null'];
    };

export function parseNullableDef(def: ZodNullableDef, refs: Refs): JsonSchema7NullableType | undefined {
  if (
    ['ZodString', 'ZodNumber', 'ZodBigInt', 'ZodBoolean', 'ZodNull'].includes(def.innerType._def.typeName) &&
    (!def.innerType._def.checks || !def.innerType._def.checks.length)
  ) {
    if (refs.target === 'openApi3' || refs.nullableStrategy === 'property') {
      return {
        type: primitiveMappings[def.innerType._def.typeName as keyof typeof primitiveMappings],
        nullable: true,
      } as any;
    }

    return {
      type: [primitiveMappings[def.innerType._def.typeName as keyof typeof primitiveMappings], 'null'],
    };
  }

  if (refs.target === 'openApi3') {
    const base = parseDef(def.innerType._def, {
      ...refs,
      currentPath: [...refs.currentPath],
    });

    if (base && '$ref' in base) return { allOf: [base], nullable: true } as any;

    return base && ({ ...base, nullable: true } as any);
  }

  const base = parseDef(def.innerType._def, {
    ...refs,
    currentPath: [...refs.currentPath, 'anyOf', '0'],
  });

  return base && { anyOf: [base, { type: 'null' }] };
}
