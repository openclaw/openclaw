// Shared catalog assertions for the OpenAI provider tests.
import { expect } from "vitest";

export function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

export function expectCatalogEntry(
  entries: unknown,
  id: string,
  expected: Record<string, unknown>,
): void {
  expect(Array.isArray(entries)).toBe(true);
  const entry = (entries as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === id,
  );
  expectFields(entry, expected);
}

export function expectNoCatalogEntry(entries: unknown, id: string): void {
  expect(Array.isArray(entries)).toBe(true);
  const entryIds = new Set((entries as Array<Record<string, unknown>>).map((entry) => entry.id));
  expect(entryIds.has(id)).toBe(false);
}
