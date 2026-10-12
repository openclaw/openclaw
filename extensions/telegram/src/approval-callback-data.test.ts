// Telegram tests cover approval callback data plugin behavior.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import { describe, expect, it } from "vitest";
import {
  buildTelegramApprovalCallbackData,
  parseTelegramApprovalCallbackData,
  rewriteTelegramApprovalDecisionAlias,
  sanitizeTelegramCallbackData,
} from "./approval-callback-data.js";

describe("approval callback data", () => {
  it.each(["\n"])("does not corrupt callbacks ending in a line terminator", (ending) => {
    const value = `/approve plugin:abc allow-always${ending}`;
    expect(rewriteTelegramApprovalDecisionAlias(value)).toBe(value);
  });

  it("rewrites allow-always callbacks separated by any whitespace", () => {
    const approvalId = `plugin:${"a".repeat(36)}`;
    expect(rewriteTelegramApprovalDecisionAlias(`/approve\t${approvalId}\tallow-always`)).toBe(
      `/approve\t${approvalId}\talways`,
    );
  });

  it("keeps 64-byte callbacks and drops 65-byte callbacks through sanitize", () => {
    expect(sanitizeTelegramCallbackData("x".repeat(64))).toBe("x".repeat(64));
    expect(sanitizeTelegramCallbackData("x".repeat(65))).toBeUndefined();
  });

  it("uses the canonical id at the Unicode byte boundary and compacts beyond it", () => {
    const exactId = "\u{1F4F1}".repeat(13);
    const compactedId = "\u{1F4F1}".repeat(14);
    expect(
      buildTelegramApprovalCallbackData({
        type: "approval",
        approvalId: exactId,
        approvalKind: "exec",
        decision: "deny",
      }),
    ).toBe(`tga1:e:d:${exactId}`);

    const compacted = buildTelegramApprovalCallbackData({
      type: "approval",
      approvalId: compactedId,
      approvalKind: "exec",
      decision: "deny",
    });
    expect(compacted).toHaveLength(52);
    expect(parseTelegramApprovalCallbackData(compacted)).toEqual({
      type: "approval",
      approvalId: buildApprovalResolutionRef({
        approvalId: compactedId,
        approvalKind: "exec",
      }),
      approvalKind: "exec",
      decision: "deny",
    });
  });

  it.each([
    "tga2:e:o:approval-1",
    "tga1:x:o:approval-1",
    "tga1:e:x:approval-1",
    "tga1:e:o",
    `tga1:e:o:${"x".repeat(56)}`,
  ])("rejects malformed private approval callback data: %s", (callbackData) => {
    expect(parseTelegramApprovalCallbackData(callbackData)).toBeNull();
  });
});
