import { ZodPipelineDef } from 'zod/v3';
import { JsonSchema7Type, parseDef } from '../parseDef';
import { Refs } from '../Refs';
import { JsonSchema7AllOfType } from './intersection';

export const parsePipelineDef = (
  def: ZodPipelineDef<any, any>,
  refs: Refs,
): JsonSchema7AllOfType | JsonSchema7Type | undefined => {
  if (refs.pipeStrategy === 'input') {
    return parseDef(def.in._def, refs);
  } else if (refs.pipeStrategy === 'output') {
    return parseDef(def.out._def, refs);
  }

  const a = parseDef(def.in._def, {
    ...refs,
    currentPath: [...refs.currentPath, 'allOf', '0'],
  });
  const b = parseDef(def.out._def, {
    ...refs,
    currentPath: [...refs.currentPath, 'allOf', a ? '1' : '0'],
  });

  return {
    allOf: [a, b].filter((x): x is JsonSchema7Type => x !== undefined),
  };
};
