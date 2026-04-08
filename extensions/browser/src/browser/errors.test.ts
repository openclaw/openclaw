import { describe, expect, it } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { BrowserValidationError, toBrowserErrorResponse } from "./errors.js";

describe("browser error mapping", () => {
  it("maps blocked browser targets to conflict responses", () => {
    const err = new Error(
      "Browser target is unavailable after SSRF policy blocked its navigation.",
    );
    err.name = "BlockedBrowserTargetError";

    expect(toBrowserErrorResponse(err)).toEqual({
      status: 409,
      message: "Browser target is unavailable after SSRF policy blocked its navigation.",
    });
  });

  it("preserves BrowserError mappings", () => {
    expect(toBrowserErrorResponse(new BrowserValidationError("bad input"))).toEqual({
      status: 400,
      message: "bad input",
    });
  });

  it("sanitizes SSRF policy errors before returning them to callers", () => {
    expect(
      toBrowserErrorResponse(
        new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
      ),
    ).toEqual({
      status: 400,
      message: "browser endpoint blocked by policy",
    });
  });
});
