import { describe, expect, it } from "vitest";
import { WIZARD_STEPS, wizardStepFields } from "./wizard.ts";

describe("wizard step definitions", () => {
  it("defines the expected number of curated steps", () => {
    expect(WIZARD_STEPS).toHaveLength(7);
  });

  it("resolves all configured fields to schema metadata", () => {
    for (const step of WIZARD_STEPS) {
      const fields = wizardStepFields(step);
      expect(fields).toHaveLength(step.fields.length);
    }
  });
});
