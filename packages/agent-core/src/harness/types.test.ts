import { describe, expect, it } from "vitest";
import { toError } from "./types.js";

describe("toError", () => {
  it("preserves the shipped facade while using structured error coercion", () => {
    const thrown = { code: "E_TEST", detail: "structured" };

    const error = toError(thrown);

    expect(error).toMatchObject({ message: "Non-Error thrown", code: "E_TEST" });
    expect(error.cause).toBe(thrown);
  });
});
