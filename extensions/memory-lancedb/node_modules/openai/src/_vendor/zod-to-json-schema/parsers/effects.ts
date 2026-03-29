import { ZodEffectsDef } from 'zod/v3';
import { JsonSchema7Type, parseDef } from '../parseDef';
import { Refs } from '../Refs';

export function parseEffectsDef(
  _def: ZodEffectsDef,
  refs: Refs,
  forceResolution: boolean,
): JsonSchema7Type | undefined {
  return refs.effectStrategy === 'input' ? parseDef(_def.schema._def, refs, forceResolution) : {};
}
