import { Refs } from '../Refs';

export type JsonSchema7NullType = {
  type: 'null';
};

export function parseNullDef(refs: Refs): JsonSchema7NullType {
  return refs.target === 'openApi3' ?
      ({
        enum: ['null'],
        nullable: true,
      } as any)
    : {
        type: 'null',
      };
}
