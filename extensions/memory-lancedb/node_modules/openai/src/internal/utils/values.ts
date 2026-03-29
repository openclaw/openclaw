// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { OpenAIError } from '../../core/error';

// https://url.spec.whatwg.org/#url-scheme-string
const startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;

export const isAbsoluteURL = (url: string): boolean => {
  return startsWithSchemeRegexp.test(url);
};

export let isArray = (val: unknown): val is unknown[] => ((isArray = Array.isArray), isArray(val));
export let isReadonlyArray = isArray as (val: unknown) => val is readonly unknown[];

/** Returns an object if the given value isn't an object, otherwise returns as-is */
export function maybeObj(x: unknown): object {
  if (typeof x !== 'object') {
    return {};
  }

  return x ?? {};
}

// https://stackoverflow.com/a/34491287
export function isEmptyObj(obj: Object | null | undefined): boolean {
  if (!obj) return true;
  for (const _k in obj) return false;
  return true;
}

// https://eslint.org/docs/latest/rules/no-prototype-builtins
export function hasOwn<T extends object = object>(obj: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function isObj(obj: unknown): obj is Record<string, unknown> {
  return obj != null && typeof obj === 'object' && !Array.isArray(obj);
}

export const ensurePresent = <T>(value: T | null | undefined): T => {
  if (value == null) {
    throw new OpenAIError(`Expected a value to be given but received ${value} instead.`);
  }

  return value;
};

export const validatePositiveInteger = (name: string, n: unknown): number => {
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new OpenAIError(`${name} must be an integer`);
  }
  if (n < 0) {
    throw new OpenAIError(`${name} must be a positive integer`);
  }
  return n;
};

export const coerceInteger = (value: unknown): number => {
  if (typeof value === 'number') return Math.round(value);
  if (typeof value === 'string') return parseInt(value, 10);

  throw new OpenAIError(`Could not coerce ${value} (type: ${typeof value}) into a number`);
};

export const coerceFloat = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseFloat(value);

  throw new OpenAIError(`Could not coerce ${value} (type: ${typeof value}) into a number`);
};

export const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return Boolean(value);
};

export const maybeCoerceInteger = (value: unknown): number | undefined => {
  if (value == null) {
    return undefined;
  }
  return coerceInteger(value);
};

export const maybeCoerceFloat = (value: unknown): number | undefined => {
  if (value == null) {
    return undefined;
  }
  return coerceFloat(value);
};

export const maybeCoerceBoolean = (value: unknown): boolean | undefined => {
  if (value == null) {
    return undefined;
  }
  return coerceBoolean(value);
};

export const safeJSON = (text: string) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    return undefined;
  }
};
