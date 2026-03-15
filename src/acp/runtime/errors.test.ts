import { describe, expect, it } from "vitest";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "./errors.js";

describe("withAcpRuntimeErrorBoundary", () => {
  it("wraps generic errors with fallback code and source message", async () => {
    await expect(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw new Error("boom");
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    ).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: "ACP_TURN_FAILED",
      message: "boom",
    });
  });

  it("passes through existing ACP runtime errors", async () => {
    const existing = new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing");
    await expect(
      withAcpRuntimeErrorBoundary({
        run: async () => {
          throw existing;
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
      }),
    ).rejects.toBe(existing);
  });
});
