import { ZodDiscriminatedUnionDef, ZodLiteralDef, ZodTypeAny, ZodUnionDef } from 'zod/v3';
import { JsonSchema7Type, parseDef } from '../parseDef';
import { Refs } from '../Refs';

export const primitiveMappings = {
  ZodString: 'string',
  ZodNumber: 'number',
  ZodBigInt: 'integer',
  ZodBoolean: 'boolean',
  ZodNull: 'null',
} as const;
type ZodPrimitive = keyof typeof primitiveMappings;
type JsonSchema7Primitive = (typeof primitiveMappings)[keyof typeof primitiveMappings];

export type JsonSchema7UnionType = JsonSchema7PrimitiveUnionType | JsonSchema7AnyOfType;

type JsonSchema7PrimitiveUnionType =
  | {
      type: JsonSchema7Primitive | JsonSchema7Primitive[];
    }
  | {
      type: JsonSchema7Primitive | JsonSchema7Primitive[];
      enum: (string | number | bigint | boolean | null)[];
    };

type JsonSchema7AnyOfType = {
  anyOf: JsonSchema7Type[];
};

export function parseUnionDef(
  def: ZodUnionDef | ZodDiscriminatedUnionDef<any, any>,
  refs: Refs,
): JsonSchema7PrimitiveUnionType | JsonSchema7AnyOfType | undefined {
  if (refs.target === 'openApi3') return asAnyOf(def, refs);

  const options: readonly ZodTypeAny[] =
    def.options instanceof Map ? Array.from(def.options.values()) : def.options;

  // This blocks tries to look ahead a bit to produce nicer looking schemas with type array instead of anyOf.
  if (
    options.every((x) => x._def.typeName in primitiveMappings && (!x._def.checks || !x._def.checks.length))
  ) {
    // all types in union are primitive and lack checks, so might as well squash into {type: [...]}

    const types = options.reduce((types: JsonSchema7Primitive[], x) => {
      const type = primitiveMappings[x._def.typeName as ZodPrimitive]; //Can be safely casted due to row 43
      return type && !types.includes(type) ? [...types, type] : types;
    }, []);

    return {
      type: types.length > 1 ? types : types[0]!,
    };
  } else if (options.every((x) => x._def.typeName === 'ZodLiteral' && !x.description)) {
    // all options literals

    const types = options.reduce((acc: JsonSchema7Primitive[], x: { _def: ZodLiteralDef }) => {
      const type = typeof x._def.value;
      switch (type) {
        case 'string':
        case 'number':
        case 'boolean':
          return [...acc, type];
        case 'bigint':
          return [...acc, 'integer' as const];
        case 'object':
          if (x._def.value === null) return [...acc, 'null' as const];
        case 'symbol':
        case 'undefined':
        case 'function':
        default:
          return acc;
      }
    }, []);

    if (types.length === options.length) {
      // all the literals are primitive, as far as null can be considered primitive

      const uniqueTypes = types.filter((x, i, a) => a.indexOf(x) === i);
      return {
        type: uniqueTypes.length > 1 ? uniqueTypes : uniqueTypes[0]!,
        enum: options.reduce(
          (acc, x) => {
            return acc.includes(x._def.value) ? acc : [...acc, x._def.value];
          },
          [] as (string | number | bigint | boolean | null)[],
        ),
      };
    }
  } else if (options.every((x) => x._def.typeName === 'ZodEnum')) {
    return {
      type: 'string',
      enum: options.reduce(
        (acc: string[], x) => [...acc, ...x._def.values.filter((x: string) => !acc.includes(x))],
        [],
      ),
    };
  }

  return asAnyOf(def, refs);
}

const asAnyOf = (
  def: ZodUnionDef | ZodDiscriminatedUnionDef<any, any>,
  refs: Refs,
): JsonSchema7PrimitiveUnionType | JsonSchema7AnyOfType | undefined => {
  const anyOf = ((def.options instanceof Map ? Array.from(def.options.values()) : def.options) as any[])
    .map((x, i) =>
      parseDef(x._def, {
        ...refs,
        currentPath: [...refs.currentPath, 'anyOf', `${i}`],
      }),
    )
    .filter(
      (x): x is JsonSchema7Type =>
        !!x && (!refs.strictUnions || (typeof x === 'object' && Object.keys(x).length > 0)),
    );

  return anyOf.length ? { anyOf } : undefined;
};
