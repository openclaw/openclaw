import { describe, expect, it } from "vitest";
import { isSecurityMatrixBeforeToolCallAuditEnabled } from "../security/security-matrix/before-tool-call.js";

describe("Security Matrix runtime adapter", () => {
  it("stays disabled unless the audit config is explicitly enabled", () => {
    expect(isSecurityMatrixBeforeToolCallAuditEnabled(undefined)).toBe(false);
    expect(isSecurityMatrixBeforeToolCallAuditEnabled({ security: {} })).toBe(false);
    expect(
      isSecurityMatrixBeforeToolCallAuditEnabled({
        security: { matrix: { audit: { enabled: true } } },
      }),
    ).toBe(true);
  });
});
