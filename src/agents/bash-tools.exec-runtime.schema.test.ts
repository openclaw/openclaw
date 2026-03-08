import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import { execSchema } from "./bash-tools.exec-runtime.js";

describe("execSchema", () => {
  it("accepts empty args so tool can return a helpful error at runtime", () => {
    const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
      allErrors: true,
      strict: false,
    });
    const validate = ajv.compile(execSchema);
    expect(validate({})).toBe(true);
  });
});
