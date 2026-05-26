import { isSetupHookTrusted } from "./skills-setup.js";

describe("isSetupHookTrusted", () => {
  it("returns false when metadata is undefined", () => {
    expect(isSetupHookTrusted(undefined)).toBe(false);
  });

  it("returns false when metadata does not have trusted flag", () => {
    expect(isSetupHookTrusted({})).toBe(false);
  });

  it("returns false when trusted is explicitly false", () => {
    expect(isSetupHookTrusted({ trusted: false })).toBe(false);
  });

  it("returns true when trusted is explicitly true", () => {
    expect(isSetupHookTrusted({ trusted: true })).toBe(true);
  });
});
