import { describe, it, expect } from "vitest";
import { validateSkillsInstallParams } from "./index.js";

describe("skills.install schema", () => {
  it("accepts legacy dangerouslyForceUnsafeInstall=false in skills.install params", () => {
    const params = { name: "calendar", installId: "deps", dangerouslyForceUnsafeInstall: false };
    expect(validateSkillsInstallParams(params)).toBe(true);
  });

  it("accepts valid skills.install params without the flag", () => {
    const params = { name: "calendar", installId: "deps" };
    expect(validateSkillsInstallParams(params)).toBe(true);
  });

  it("rejects dangerouslyForceUnsafeInstall=true at the schema layer", () => {
    const params = { name: "calendar", installId: "deps", dangerouslyForceUnsafeInstall: true };
    expect(validateSkillsInstallParams(params)).toBe(false);
  });
});
