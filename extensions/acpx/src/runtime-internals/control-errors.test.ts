import { describe, expect, it } from "vitest";
import { parseControlJsonError } from "./control-errors.js";

describe("parseControlJsonError", () => {
  it("reads structured control-command errors", () => {
    expect(
      parseControlJsonError({
        error: {
          code: "NO_SESSION",
          message: "No matching session",
          retryable: false,
        },
      }),
    ).toEqual({
      code: "NO_SESSION",
      message: "No matching session",
      retryable: false,
    });
  });

  it("returns null when payload has no error object", () => {
    expect(parseControlJsonError({ action: "session_ensured" })).toBeNull();
    expect(parseControlJsonError("bad")).toBeNull();
  });
});
