import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";

type RuntimeOptionsParams = NonNullable<Parameters<typeof resolveCodexAppServerRuntimeOptions>[0]>;

export function resolveRuntimeForTest(params: RuntimeOptionsParams = {}) {
  return resolveCodexAppServerRuntimeOptions({ env: {}, requirementsToml: null, ...params });
}

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

export function expectFields(
  value: unknown,
  label: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
  return record;
}

export function expectRuntimePolicy(
  runtime: unknown,
  fields: {
    approvalPolicy: string;
    sandbox: string;
    approvalsReviewer: string;
  },
) {
  expectFields(runtime, "runtime policy", fields);
}
