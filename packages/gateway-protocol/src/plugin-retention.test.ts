import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { PluginRuntimeRetentionSchema } from "./schema/plugin-retention.js";

it("keeps retention diagnostics bounded and excludes payload fields", () => {
  const reference = {
    referenceId: "fixture:1",
    kind: "work",
    reason: "prepared-generation-lease",
    acquiredAtMs: 1,
    ageMs: 2,
    cleanupState: "active",
    owner: { runId: "fixture-run" },
  };
  const snapshot = {
    instanceId: "fixture",
    pluginId: "fixture",
    generation: 1,
    acceptingCalls: true,
    replacementPending: false,
    disposing: false,
    total: 1,
    omitted: 0,
    references: [reference],
  };
  expect(Value.Check(PluginRuntimeRetentionSchema, snapshot)).toBe(true);
  for (const references of [
    Array.from({ length: 65 }, () => reference),
    [{ ...reference, owner: { prompt: "not diagnostic data" } }],
    [{ ...reference, owner: { runId: "x".repeat(257) } }],
  ]) {
    expect(Value.Check(PluginRuntimeRetentionSchema, { ...snapshot, references })).toBe(false);
  }
});
