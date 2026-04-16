import { describe, expect, it } from "vitest";
import {
  buildFullWorkflowArgs,
  countJsonLines,
  deriveQuestionSavePath,
  friendlyError,
  manifestOutputCategories,
  normalizePathList,
  normalizeScenarios,
  summarizeQa,
} from "./workbench.js";

describe("clawmodeler workbench helpers", () => {
  it("normalizes paths from newlines and commas", () => {
    expect(normalizePathList("zones.geojson, socio.csv\nprojects.csv\n")).toEqual([
      "zones.geojson",
      "socio.csv",
      "projects.csv",
    ]);
  });

  it("defaults scenarios to baseline", () => {
    expect(normalizeScenarios("")).toEqual(["baseline"]);
    expect(normalizeScenarios("baseline, build")).toEqual(["baseline", "build"]);
  });

  it("builds the full workflow sidecar args", () => {
    expect(
      buildFullWorkflowArgs({
        workspace: "/tmp/demo",
        inputs: ["zones.geojson", "socio.csv"],
        question: "question.json",
        runId: "demo",
        scenarios: ["baseline"],
        skipBridges: true,
      }),
    ).toEqual([
      "workflow",
      "full",
      "--workspace",
      "/tmp/demo",
      "--inputs",
      "zones.geojson",
      "socio.csv",
      "--question",
      "question.json",
      "--run-id",
      "demo",
      "--scenarios",
      "baseline",
      "--skip-bridges",
    ]);
  });

  it("summarizes QA reports", () => {
    expect(summarizeQa({ export_ready: true, blockers: [] }).tone).toBe("ready");
    expect(summarizeQa({ export_ready: false, blockers: ["manifest_missing"] })).toEqual({
      label: "Export blocked",
      tone: "blocked",
      blockers: ["manifest_missing"],
    });
  });

  it("counts JSONL rows and manifest output categories", () => {
    expect(countJsonLines('{"a":1}\n\n{"b":2}\n')).toBe(2);
    expect(manifestOutputCategories({ outputs: { tables: [], maps: [], bridges: [] } })).toEqual([
      "bridges",
      "maps",
      "tables",
    ]);
  });

  it("translates engine errors into planner-friendly language", () => {
    expect(friendlyError("Error: workspace is required")).toMatch(/Pick a workspace folder/u);
    expect(friendlyError("FileNotFoundError: No such file or directory: 'zones.geojson'")).toMatch(
      /doesn't exist/u,
    );
    expect(friendlyError("PermissionError: [Errno 13] Permission denied")).toMatch(
      /can't read or write/u,
    );
    expect(friendlyError("ModuleNotFoundError: No module named 'clawmodeler_engine'")).toMatch(
      /engine isn't installed/u,
    );
    expect(friendlyError("")).toMatch(/Something went wrong/u);
    expect(friendlyError("custom short message")).toBe("custom short message");
    const longLine = "a".repeat(500);
    expect(friendlyError(longLine).length).toBeLessThanOrEqual(220);
  });

  it("derives a sensible default path for the starter question.json save dialog", () => {
    expect(deriveQuestionSavePath("/home/nat/project", "")).toBe("/home/nat/project/question.json");
    expect(deriveQuestionSavePath("/home/nat/project/", "")).toBe(
      "/home/nat/project/question.json",
    );
    expect(deriveQuestionSavePath("C:\\Users\\nat\\project", "")).toBe(
      "C:\\Users\\nat\\project\\question.json",
    );
    expect(deriveQuestionSavePath("/home/nat/project", "/tmp/custom.json")).toBe(
      "/tmp/custom.json",
    );
    expect(deriveQuestionSavePath("", "")).toBe("question.json");
  });
});
