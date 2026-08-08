/**
 * Exec timeout unit-naming tests.
 *
 * The exec timeout is in seconds while the sibling `yieldMs` and the process
 * tool's `timeout` are milliseconds. Code mode renders property names and types
 * and defers descriptions, so the field name has to carry the unit; a bare
 * `timeout` is a silent 1000x error. These tests pin that contract.
 */
import { describe, expect, it } from "vitest";
import { resolveExecTimeoutSeconds } from "./bash-tools.exec-request-preparation.js";
import { execSchema, nodeExecSchema, processSchema } from "./bash-tools.schemas.js";

/** TypeBox optional wrappers do not surface `description` on their static type. */
function describedAs(schema: unknown): string {
  return (schema as { description?: string } | undefined)?.description ?? "";
}

describe("exec timeout unit naming", () => {
  it("exposes a unit-bearing timeoutSeconds field", () => {
    expect(execSchema.properties.timeoutSeconds).toBeDefined();
    expect(describedAs(execSchema.properties.timeoutSeconds)).toMatch(/seconds/);
  });

  it("no longer exposes a unit-ambiguous timeout field", () => {
    // The whole point: a model that sees only names and types must not be
    // offered a bare `timeout` next to a millisecond-based `yieldMs`.
    expect(execSchema.properties).not.toHaveProperty("timeout");
    expect(nodeExecSchema.properties).not.toHaveProperty("timeout");
  });

  it("exposes timeoutSeconds on the node-only exec surface too", () => {
    // nodeExecSchema hand-projects its fields, so a new exec field has to be
    // added there explicitly or node callers cannot discover it.
    expect(nodeExecSchema.properties.timeoutSeconds).toBeDefined();
  });

  it("leaves the process tool's millisecond timeout untouched", () => {
    // The collision this change removes: same name, different unit, in two
    // tools used together in one workflow. process keeps its own field.
    expect(describedAs(processSchema.properties.timeout)).toMatch(/millisecond/i);
  });
});

describe("legacy exec timeout alias", () => {
  it("honors the canonical timeoutSeconds", () => {
    expect(resolveExecTimeoutSeconds({ command: "true", timeoutSeconds: 5 })).toBe(5);
  });

  it("honors a legacy timeout as the same seconds value", () => {
    // Removing the field from the schema does not reject it at runtime: the
    // exec schema accepts unknown properties. Without this alias a call built
    // against the old schema is accepted and then silently ignored, so it gets
    // the default deadline instead of the one it asked for.
    expect(resolveExecTimeoutSeconds({ command: "true", timeout: 5 })).toBe(5);
  });

  it("prefers timeoutSeconds when a call carries both", () => {
    expect(resolveExecTimeoutSeconds({ command: "true", timeoutSeconds: 5, timeout: 900 })).toBe(5);
  });

  it("ignores a non-numeric legacy timeout", () => {
    expect(resolveExecTimeoutSeconds({ command: "true", timeout: "5" })).toBeUndefined();
    expect(resolveExecTimeoutSeconds({ command: "true" })).toBeUndefined();
  });

  it("keeps the alias out of every model-facing surface", () => {
    // The alias exists for compatibility only. If it ever reaches a schema, the
    // ambiguity this change removes comes straight back.
    expect(execSchema.properties).not.toHaveProperty("timeout");
    expect(nodeExecSchema.properties).not.toHaveProperty("timeout");
  });
});
