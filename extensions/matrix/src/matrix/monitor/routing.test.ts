import { describe, expect, it } from "vitest";
import { shouldForceMatrixRoomRouting } from "./routing.js";

describe("shouldForceMatrixRoomRouting", () => {
  it("returns false when config option is disabled", () => {
    expect(
      shouldForceMatrixRoomRouting({
        forceRoomRouting: false,
        roomConfigResolved: {
          allowlistConfigured: true,
          allowed: true,
        },
      }),
    ).toBe(false);
  });

  it("returns false when allowlist is not configured", () => {
    expect(
      shouldForceMatrixRoomRouting({
        forceRoomRouting: true,
        roomConfigResolved: {
          allowlistConfigured: false,
          allowed: false,
        },
      }),
    ).toBe(false);
  });

  it("returns false when room is not allowed", () => {
    expect(
      shouldForceMatrixRoomRouting({
        forceRoomRouting: true,
        roomConfigResolved: {
          allowlistConfigured: true,
          allowed: false,
        },
      }),
    ).toBe(false);
  });

  it("returns true when enabled and room is allowlisted", () => {
    expect(
      shouldForceMatrixRoomRouting({
        forceRoomRouting: true,
        roomConfigResolved: {
          allowlistConfigured: true,
          allowed: true,
        },
      }),
    ).toBe(true);
  });
});
