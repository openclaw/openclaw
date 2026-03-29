import { ZodObjectDef } from 'zod/v3';
import { JsonSchema7Type, parseDef } from '../parseDef';
import { Refs } from '../Refs';

function decideAdditionalProperties(def: ZodObjectDef, refs: Refs) {
  if (refs.removeAdditionalStrategy === 'strict') {
    return def.catchall._def.typeName === 'ZodNever' ?
        def.unknownKeys !== 'strict'
      : parseDef(def.catchall._def, {
          ...refs,
          currentPath: [...refs.currentPath, 'additionalProperties'],
        }) ?? true;
  } else {
    return def.catchall._def.typeName === 'ZodNever' ?
        def.unknownKeys === 'passthrough'
      : parseDef(def.catchall._def, {
          ...refs,
          currentPath: [...refs.currentPath, 'additionalProperties'],
        }) ?? true;
  }
}

export type JsonSchema7ObjectType = {
  type: 'object';
  properties: Record<string, JsonSchema7Type>;
  additionalProperties: boolean | JsonSchema7Type;
  required?: string[];
};

export function parseObjectDef(def: ZodObjectDef, refs: Refs) {
  const result: JsonSchema7ObjectType = {
    type: 'object',
    ...Object.entries(def.shape()).reduce(
      (
        acc: {
          properties: Record<string, JsonSchema7Type>;
          required: string[];
        },
        [propName, propDef],
      ) => {
        if (propDef === undefined || propDef._def === undefined) return acc;
        const propertyPath = [...refs.currentPath, 'properties', propName];
        const parsedDef = parseDef(propDef._def, {
          ...refs,
          currentPath: propertyPath,
          propertyPath,
        });
        if (parsedDef === undefined) return acc;
        if (
          refs.openaiStrictMode &&
          propDef.isOptional() &&
          !propDef.isNullable() &&
          typeof propDef._def?.defaultValue === 'undefined'
        ) {
          throw new Error(
            `Zod field at \`${propertyPath.join(
              '/',
            )}\` uses \`.optional()\` without \`.nullable()\` which is not supported by the API. See: https://platform.openai.com/docs/guides/structured-outputs?api-mode=responses#all-fields-must-be-required`,
          );
        }
        return {
          properties: {
            ...acc.properties,
            [propName]: parsedDef,
          },
          required:
            propDef.isOptional() && !refs.openaiStrictMode ? acc.required : [...acc.required, propName],
        };
      },
      { properties: {}, required: [] },
    ),
    additionalProperties: decideAdditionalProperties(def, refs),
  };
  if (!result.required!.length) delete result.required;
  return result;
}
