// Feishu tests cover message audit error classification.
import { describe, expect, it } from "vitest";
import { isFeishuMessageAuditRejection } from "./message-audit.js";

function sdkError(code: number): Error {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: { status: 400, data: { code } },
  });
}

describe("isFeishuMessageAuditRejection", () => {
  it("recognizes code 230028 through the Feishu API wrapper cause", () => {
    expect(
      isFeishuMessageAuditRejection(new Error("Feishu send failed", { cause: sdkError(230028) })),
    ).toBe(true);
  });

  it("does not classify other Feishu message errors", () => {
    expect(isFeishuMessageAuditRejection(sdkError(230022))).toBe(false);
    expect(isFeishuMessageAuditRejection(new Error("send failed"))).toBe(false);
  });
});
