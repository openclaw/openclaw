import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { expect } from "vitest";

export function check(
  validate: (value: unknown) => boolean,
  accepted: readonly unknown[],
  rejected: readonly unknown[] = [],
) {
  for (const value of accepted) {
    expect(validate(value)).toBe(true);
  }
  for (const value of rejected) {
    expect(validate(value)).toBe(false);
  }
}

export function schemaValidation(schema: TSchema) {
  return validation((value) => Value.Check(schema, value));
}

export function validation(validate: (value: unknown) => boolean) {
  return {
    accepts: (...values: unknown[]) => check(validate, values),
    rejects: (...values: unknown[]) => check(validate, [], values),
  };
}

export function copies<T>(value: T, length: number) {
  return Array.from({ length }, () => value);
}

export function withOverrides<T extends object>(base: T) {
  return (changes: object) => Object.assign({}, base, changes);
}
