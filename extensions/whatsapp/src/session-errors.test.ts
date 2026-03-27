import { describe, expect, it } from "vitest";
import { getStatusCode } from "./session-errors.js";

describe("session-errors", () => {
  it("extracts status from nested error.output wrappers", () => {
    const err = {
      error: {
        output: {
          statusCode: 515,
        },
      },
    };
    expect(getStatusCode(err)).toBe(515);
  });

  it("extracts status from lastDisconnect.error wrappers", () => {
    const err = {
      lastDisconnect: {
        error: {
          output: {
            statusCode: 401,
          },
        },
      },
    };
    expect(getStatusCode(err)).toBe(401);
  });
});
