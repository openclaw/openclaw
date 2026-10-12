import { expect } from "vitest";

export function expectResolvedForwardCompatFallbackResult(params: {
  result: {
    error?: string;
    model?: unknown;
  };
  expectedModel: Record<string, unknown>;
}) {
  expect(params.result.error).toBeUndefined();
  expectModelFields(params.result.model, params.expectedModel);
}

function expectModelFields(actual: unknown, expected: Record<string, unknown>) {
  // Forward-compatible fallbacks only assert fields that define the contract;
  // unrelated catalog metadata can vary by source.
  const actualModel = actual as Record<string, unknown> | undefined;
  expect(actualModel).toBeDefined();
  for (const [key, value] of Object.entries(expected)) {
    expect(actualModel?.[key]).toEqual(value);
  }
}

export function expectUnknownModelErrorResult(
  result: {
    error?: string;
    model?: unknown;
  },
  provider: string,
  id: string,
) {
  expect(result.model).toBeUndefined();
  expect(result.error).toBe(
    `Unknown model: ${provider}/${id}. Run \`openclaw models list --refresh --provider ${provider}\` to inspect this provider's model choices, then retry with a model supported by your account.`,
  );
}
