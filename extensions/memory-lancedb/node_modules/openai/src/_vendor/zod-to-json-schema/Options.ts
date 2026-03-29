import { ZodSchema, ZodTypeDef } from 'zod/v3';
import { Refs, Seen } from './Refs';
import { JsonSchema7Type } from './parseDef';

export type Targets = 'jsonSchema7' | 'jsonSchema2019-09' | 'openApi3';

export type DateStrategy = 'format:date-time' | 'format:date' | 'string' | 'integer';

export const ignoreOverride = Symbol('Let zodToJsonSchema decide on which parser to use');

export type Options<Target extends Targets = 'jsonSchema7'> = {
  name: string | undefined;
  $refStrategy: 'root' | 'relative' | 'none' | 'seen' | 'extract-to-root';
  basePath: string[];
  effectStrategy: 'input' | 'any';
  pipeStrategy: 'input' | 'output' | 'all';
  dateStrategy: DateStrategy | DateStrategy[];
  mapStrategy: 'entries' | 'record';
  removeAdditionalStrategy: 'passthrough' | 'strict';
  nullableStrategy: 'from-target' | 'property';
  target: Target;
  strictUnions: boolean;
  definitionPath: string;
  definitions: Record<string, ZodSchema | ZodTypeDef>;
  errorMessages: boolean;
  markdownDescription: boolean;
  patternStrategy: 'escape' | 'preserve';
  applyRegexFlags: boolean;
  emailStrategy: 'format:email' | 'format:idn-email' | 'pattern:zod';
  base64Strategy: 'format:binary' | 'contentEncoding:base64' | 'pattern:zod';
  nameStrategy: 'ref' | 'duplicate-ref' | 'title';
  override?: (
    def: ZodTypeDef,
    refs: Refs,
    seen: Seen | undefined,
    forceResolution?: boolean,
  ) => JsonSchema7Type | undefined | typeof ignoreOverride;
  openaiStrictMode?: boolean;
};

const defaultOptions: Omit<Options, 'definitions' | 'basePath'> = {
  name: undefined,
  $refStrategy: 'root',
  effectStrategy: 'input',
  pipeStrategy: 'all',
  dateStrategy: 'format:date-time',
  mapStrategy: 'entries',
  nullableStrategy: 'from-target',
  removeAdditionalStrategy: 'passthrough',
  definitionPath: 'definitions',
  target: 'jsonSchema7',
  strictUnions: false,
  errorMessages: false,
  markdownDescription: false,
  patternStrategy: 'escape',
  applyRegexFlags: false,
  emailStrategy: 'format:email',
  base64Strategy: 'contentEncoding:base64',
  nameStrategy: 'ref',
};

export const getDefaultOptions = <Target extends Targets>(
  options: Partial<Options<Target>> | string | undefined,
) => {
  // We need to add `definitions` here as we may mutate it
  return (
    typeof options === 'string' ?
      {
        ...defaultOptions,
        basePath: ['#'],
        definitions: {},
        name: options,
      }
    : {
        ...defaultOptions,
        basePath: ['#'],
        definitions: {},
        ...options,
      }) as Options<Target>;
};
