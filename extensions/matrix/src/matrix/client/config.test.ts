import { describe, expect, it } from "vitest";
import { resolveMatrixLoginSsrFPolicy } from "./config.js";

describe("resolveMatrixLoginSsrFPolicy", () => {
  it("returns browser SSRF hostname exceptions for Matrix login", () => {
    expect(
      resolveMatrixLoginSsrFPolicy({
        browser: {
          ssrfPolicy: {
            allowedHostnames: ["matrix.example.test"],
          },
        },
      } as never),
    ).toEqual({
      allowedHostnames: ["matrix.example.test"],
    });
  });

  it("returns undefined when no browser SSRF policy is configured", () => {
    expect(resolveMatrixLoginSsrFPolicy({} as never)).toBeUndefined();
  });
});
