import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { expect } from "vitest";

export function accepts(schema: TSchema, ...values: readonly unknown[]) {
  for (const value of values) {
    expect(Value.Check(schema, value)).toBe(true);
  }
}

export function rejects(schema: TSchema, ...values: readonly unknown[]) {
  for (const value of values) {
    expect(Value.Check(schema, value)).toBe(false);
  }
}

export function acceptsParams(validate: (value: unknown) => boolean, value: unknown) {
  expect(validate(value)).toBe(true);
}

export function rejectsParams(validate: (value: unknown) => boolean, value: unknown) {
  expect(validate(value)).toBe(false);
}
