import { describe, expect, it } from "vitest";
import {
  normalizeSubagentRolePreset,
  resolveSubagentRolePresetDefaults,
} from "./subagent-capabilities.js";

describe("subagent role presets", () => {
  it("normalizes supported role presets", () => {
    expect(normalizeSubagentRolePreset(" Planner ")).toBe("planner");
    expect(normalizeSubagentRolePreset("builder")).toBe("builder");
    expect(normalizeSubagentRolePreset("EVALUATOR")).toBe("evaluator");
  });

  it("rejects unknown role presets", () => {
    expect(normalizeSubagentRolePreset("worker")).toBeUndefined();
    expect(normalizeSubagentRolePreset(undefined)).toBeUndefined();
  });

  it("resolves planner / builder / evaluator defaults", () => {
    expect(resolveSubagentRolePresetDefaults("planner")).toEqual({
      promptMode: "plan",
      toolBias: "read-heavy",
      verificationPosture: "acceptance-first",
      artifactWriteScope: "planner-artifacts",
    });
    expect(resolveSubagentRolePresetDefaults("builder")).toEqual({
      promptMode: "build",
      toolBias: "edit-exec",
      verificationPosture: "self-check-before-handoff",
      artifactWriteScope: "builder-artifacts",
    });
    expect(resolveSubagentRolePresetDefaults("evaluator")).toEqual({
      promptMode: "evaluate",
      toolBias: "inspect-verify",
      verificationPosture: "skeptical-review",
      artifactWriteScope: "evaluator-artifacts",
    });
  });
});
