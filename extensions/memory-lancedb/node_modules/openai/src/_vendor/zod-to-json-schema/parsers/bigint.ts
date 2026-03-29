import { ZodBigIntDef } from 'zod/v3';
import { Refs } from '../Refs';
import { ErrorMessages, setResponseValueAndErrors } from '../errorMessages';

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

export function parseBigintDef(def: ZodBigIntDef, refs: Refs): JsonSchema7BigintType {
  const res: JsonSchema7BigintType = {
    type: 'integer',
    format: 'int64',
  };

  if (!def.checks) return res;

  for (const check of def.checks) {
    switch (check.kind) {
      case 'min':
        if (refs.target === 'jsonSchema7') {
          if (check.inclusive) {
            setResponseValueAndErrors(res, 'minimum', check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, 'exclusiveMinimum', check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMinimum = true as any;
          }
          setResponseValueAndErrors(res, 'minimum', check.value, check.message, refs);
        }
        break;
      case 'max':
        if (refs.target === 'jsonSchema7') {
          if (check.inclusive) {
            setResponseValueAndErrors(res, 'maximum', check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, 'exclusiveMaximum', check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMaximum = true as any;
          }
          setResponseValueAndErrors(res, 'maximum', check.value, check.message, refs);
        }
        break;
      case 'multipleOf':
        setResponseValueAndErrors(res, 'multipleOf', check.value, check.message, refs);
        break;
    }
  }
  return res;
}
