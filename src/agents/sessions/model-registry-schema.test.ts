import { describe, expect, it } from "vitest";
import { formatValidationPath, validateModelsConfig } from "./model-registry-schema.js";

describe("model registry validation paths", () => {
  it.each([
    {
      label: "required model fields",
      value: { providers: { "vendor/~1%2F": { models: [{}] } } },
      paths: ["providers.vendor.~1%2F.models.0.id"],
    },
    {
      label: "invalid header values",
      value: { providers: { "vendor/~1%2F": { headers: { "header/~1%2F": 1 } } } },
      paths: ["providers.vendor.~1%2F.headers.header.~1%2F"],
    },
  ])("formats escaped provider and field names for $label", ({ value, paths }) => {
    expect(validateModelsConfig.Check(value)).toBe(false);
    expect(validateModelsConfig.Errors(value).map(formatValidationPath)).toEqual(paths);
  });
});
