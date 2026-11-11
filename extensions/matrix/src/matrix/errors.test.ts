import { describe, expect, it } from "vitest";
import { asDefinitiveMatrixRejection } from "./errors.js";

describe("asDefinitiveMatrixRejection", () => {
  it.each([400, 401, 403, 404, 413])("maps %s to a non-retryable no-send marker", (httpStatus) => {
    const cause = Object.assign(new Error(`MatrixError: [${httpStatus}]`), { httpStatus });
    const result = asDefinitiveMatrixRejection(cause);
    expect(result?.name).toBe("PlatformMessageNotDispatchedError");
    expect(result?.retryable).toBe(false);
    expect(result?.cause).toBe(cause);
  });

  it.each([429, 408, 500, 502])("leaves %s ambiguous", (httpStatus) => {
    const cause = Object.assign(new Error(`MatrixError: [${httpStatus}]`), { httpStatus });
    expect(asDefinitiveMatrixRejection(cause)).toBeUndefined();
  });

  it("leaves errors without a status ambiguous", () => {
    expect(asDefinitiveMatrixRejection(new Error("boom"))).toBeUndefined();
    expect(asDefinitiveMatrixRejection(null)).toBeUndefined();
  });
});
