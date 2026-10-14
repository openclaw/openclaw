import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { ModelsListResultSchema } from "./model-catalog.js";

it.each(["model", "runtime"])(
  "validates separate CLI compatibility diagnostics on a %s",
  (location) => {
    const diagnostic = {
      available: false,
      runtimeCompatibilityReason: "CLI 1.0 requires an update to 2.0. Refresh Models to retry.",
      runtimeCompatibilityNextCheckAt: 2_000_000_000_000,
    };
    const result = (fields: Record<string, unknown>) => ({
      models: [
        {
          provider: "fixture",
          id: "new-model",
          name: "New model",
          ...(location === "model"
            ? fields
            : {
                runtimeChoices: [
                  { agentRuntime: { id: "fixture-cli", source: "model" }, ...fields },
                ],
              }),
        },
      ],
    });
    expect(Value.Check(ModelsListResultSchema, result(diagnostic))).toBe(true);
    const { runtimeCompatibilityNextCheckAt: _nextCheck, ...withoutRetryTime } = diagnostic;
    expect(Value.Check(ModelsListResultSchema, result(withoutRetryTime))).toBe(true);
    for (const runtimeCompatibilityReason of ["", 123]) {
      expect(
        Value.Check(ModelsListResultSchema, result({ ...diagnostic, runtimeCompatibilityReason })),
      ).toBe(false);
    }
    for (const runtimeCompatibilityNextCheckAt of [-1, 1.5, "2033-05-18T03:33:20.000Z"]) {
      expect(
        Value.Check(
          ModelsListResultSchema,
          result({ ...diagnostic, runtimeCompatibilityNextCheckAt }),
        ),
      ).toBe(false);
    }
  },
);
