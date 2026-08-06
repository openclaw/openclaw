/**
 * Exec timeout unit-naming tests.
 *
 * `exec.timeout` is seconds while its sibling `yieldMs` and the process tool's
 * identically named `timeout` are milliseconds. Callers that see only field
 * names - code mode defers descriptions - cannot tell them apart, so the
 * canonical field carries its unit. These tests pin that contract.
 */
import { describe, expect, it } from "vitest";
import { resolveExecTimeoutSeconds } from "./bash-tools.exec-run.js";
import { execSchema, nodeExecSchema, processSchema } from "./bash-tools.schemas.js";

describe("exec timeout unit naming", () => {
  it("exposes a unit-bearing timeoutSeconds field", () => {
    const field = execSchema.properties.timeoutSeconds;
    expect(field).toBeDefined();
    expect(String(field?.description)).toMatch(/SECONDS/);
  });

  it("keeps timeout as a deprecated alias that still documents its unit", () => {
    const legacy = execSchema.properties.timeout;
    expect(legacy).toBeDefined();
    expect(String(legacy?.description)).toMatch(/[Dd]eprecated/);
    expect(String(legacy?.description)).toMatch(/SECONDS/);
  });

  it("documents that the process tool's timeout is a different unit", () => {
    // The collision this change exists to disambiguate: same field name,
    // different unit, in two tools used together in one workflow.
    expect(String(processSchema.properties.timeout?.description)).toMatch(/millisecond/i);
  });

  it("exposes timeoutSeconds on the node-only exec surface too", () => {
    // nodeExecSchema hand-projects its fields, so a new exec field has to be
    // added there explicitly or node callers cannot discover it.
    expect(nodeExecSchema.properties.timeoutSeconds).toBeDefined();
    expect(nodeExecSchema.properties.timeout).toBeDefined();
  });

  it("prefers timeoutSeconds over the deprecated alias", () => {
    expect(resolveExecTimeoutSeconds({ timeoutSeconds: 900, timeout: 5 })).toBe(900);
  });

  it("falls back to the deprecated alias when timeoutSeconds is absent", () => {
    expect(resolveExecTimeoutSeconds({ timeout: 900 })).toBe(900);
  });

  it("returns undefined when neither is provided", () => {
    expect(resolveExecTimeoutSeconds({})).toBeUndefined();
  });
});
