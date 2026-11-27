import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";

export type DeliveryParams = Omit<
  Parameters<typeof import("../replies.js").deliverReplies>[0],
  "replies"
> & {
  replies: ReplyPayload[];
};

export const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

export function expectMockCallArgFields(
  mock: unknown,
  index: number,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireRecord(requireMockCall(mock, index, "call")[0], "params"), fields);
}
