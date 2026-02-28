import { describe, expect, it } from "vitest";
import { extractToolErrorMessage } from "./pi-embedded-subscribe.tools.js";

describe("extractToolErrorMessage", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
  });

  it("normalizes permission denied errors for file-mutation tools", () => {
    expect(
      extractToolErrorMessage(
        {
          details: {
            status: "error",
            error: "EACCES: permission denied, open '/tmp/LOCKED.md'",
          },
        },
        "edit",
      ),
    ).toBe("blocked by filesystem protection policy (permission denied)");
  });
});
