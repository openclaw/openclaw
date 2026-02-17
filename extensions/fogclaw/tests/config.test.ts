import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when no overrides are provided", () => {
    const config = loadConfig({});
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("merges partial overrides with defaults", () => {
    const config = loadConfig({ guardrail_mode: "block", confidence_threshold: 0.8 });

    expect(config.guardrail_mode).toBe("block");
    expect(config.confidence_threshold).toBe(0.8);
    // Unset defaults are preserved
    expect(config.enabled).toBe(true);
    expect(config.redactStrategy).toBe("token");
    expect(config.model).toBe("onnx-community/gliner_large-v2.1");
    expect(config.custom_entities).toEqual([]);
    expect(config.entityActions).toEqual({});
  });

  it("accepts all valid guardrail_mode values", () => {
    expect(() => loadConfig({ guardrail_mode: "redact" })).not.toThrow();
    expect(() => loadConfig({ guardrail_mode: "block" })).not.toThrow();
    expect(() => loadConfig({ guardrail_mode: "warn" })).not.toThrow();
  });

  it("rejects invalid guardrail_mode", () => {
    expect(() =>
      loadConfig({ guardrail_mode: "invalid" as never }),
    ).toThrowError(
      'Invalid guardrail_mode "invalid". Must be one of: redact, block, warn',
    );
  });

  it("accepts all valid redactStrategy values", () => {
    expect(() => loadConfig({ redactStrategy: "token" })).not.toThrow();
    expect(() => loadConfig({ redactStrategy: "mask" })).not.toThrow();
    expect(() => loadConfig({ redactStrategy: "hash" })).not.toThrow();
  });

  it("rejects invalid redactStrategy", () => {
    expect(() =>
      loadConfig({ redactStrategy: "plaintext" as never }),
    ).toThrowError(
      'Invalid redactStrategy "plaintext". Must be one of: token, mask, hash',
    );
  });

  it("accepts confidence_threshold at boundaries (0 and 1)", () => {
    expect(() => loadConfig({ confidence_threshold: 0 })).not.toThrow();
    expect(() => loadConfig({ confidence_threshold: 1 })).not.toThrow();
    expect(() => loadConfig({ confidence_threshold: 0.5 })).not.toThrow();
  });

  it("rejects confidence_threshold below 0", () => {
    expect(() =>
      loadConfig({ confidence_threshold: -0.1 }),
    ).toThrowError("confidence_threshold must be between 0 and 1, got -0.1");
  });

  it("rejects confidence_threshold above 1", () => {
    expect(() =>
      loadConfig({ confidence_threshold: 1.5 }),
    ).toThrowError("confidence_threshold must be between 0 and 1, got 1.5");
  });

  it("accepts valid entityActions values", () => {
    const config = loadConfig({
      entityActions: { PERSON: "redact", EMAIL: "block", SSN: "warn" },
    });
    expect(config.entityActions).toEqual({
      PERSON: "redact",
      EMAIL: "block",
      SSN: "warn",
    });
  });

  it("rejects invalid entityActions values", () => {
    expect(() =>
      loadConfig({
        entityActions: { EMAIL: "delete" as never },
      }),
    ).toThrowError(
      'Invalid action "delete" for entity type "EMAIL". Must be one of: redact, block, warn',
    );
  });

  it("preserves custom_entities from overrides", () => {
    const config = loadConfig({ custom_entities: ["EMPLOYEE_ID", "PROJECT_CODE"] });
    expect(config.custom_entities).toEqual(["EMPLOYEE_ID", "PROJECT_CODE"]);
  });

  it("preserves model from overrides", () => {
    const config = loadConfig({ model: "custom/my-model" });
    expect(config.model).toBe("custom/my-model");
  });

  it("allows disabling via enabled: false", () => {
    const config = loadConfig({ enabled: false });
    expect(config.enabled).toBe(false);
  });
});
