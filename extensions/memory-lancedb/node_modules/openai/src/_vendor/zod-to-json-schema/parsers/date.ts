import { ZodDateDef } from 'zod/v3';
import { Refs } from '../Refs';
import { ErrorMessages, setResponseValueAndErrors } from '../errorMessages';
import { JsonSchema7NumberType } from './number';
import { DateStrategy } from '../Options';

export type JsonSchema7DateType =
  | {
      type: 'integer' | 'string';
      format: 'unix-time' | 'date-time' | 'date';
      minimum?: number;
      maximum?: number;
      errorMessage?: ErrorMessages<JsonSchema7NumberType>;
    }
  | {
      anyOf: JsonSchema7DateType[];
    };

export function parseDateDef(
  def: ZodDateDef,
  refs: Refs,
  overrideDateStrategy?: DateStrategy,
): JsonSchema7DateType {
  const strategy = overrideDateStrategy ?? refs.dateStrategy;

  if (Array.isArray(strategy)) {
    return {
      anyOf: strategy.map((item, i) => parseDateDef(def, refs, item)),
    };
  }

  switch (strategy) {
    case 'string':
    case 'format:date-time':
      return {
        type: 'string',
        format: 'date-time',
      };
    case 'format:date':
      return {
        type: 'string',
        format: 'date',
      };
    case 'integer':
      return integerDateParser(def, refs);
  }
}

const integerDateParser = (def: ZodDateDef, refs: Refs) => {
  const res: JsonSchema7DateType = {
    type: 'integer',
    format: 'unix-time',
  };

  if (refs.target === 'openApi3') {
    return res;
  }

  for (const check of def.checks) {
    switch (check.kind) {
      case 'min':
        setResponseValueAndErrors(
          res,
          'minimum',
          check.value, // This is in milliseconds
          check.message,
          refs,
        );
        break;
      case 'max':
        setResponseValueAndErrors(
          res,
          'maximum',
          check.value, // This is in milliseconds
          check.message,
          refs,
        );
        break;
    }
  }

  return res;
};
