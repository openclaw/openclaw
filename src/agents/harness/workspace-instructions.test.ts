import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentWorkspaceInstructionSnapshot } from "./workspace-instructions.js";

describe("agent workspace instruction snapshots", () => {
  const workspaceDir = path.resolve("workspace-fixture");
  const instructionsPath = path.join(workspaceDir, "AGENTS.md");

  it("preserves the native instruction framing and bounded document bytes", () => {
    const instructionsFile = { path: instructionsPath, content: "  Bounded fixture rules.\n" };
    const snapshot = buildAgentWorkspaceInstructionSnapshot(
      [
        { path: path.join(workspaceDir, "SOUL.md"), content: "Persona fixture." },
        { path: path.join(workspaceDir, "project", "AGENTS.md"), content: "Project fixture." },
        instructionsFile,
      ],
      workspaceDir,
    );
    expect(snapshot).toEqual({
      files: [instructionsFile],
      instructions: [
        "## OpenClaw Agent Workspace Instructions",
        "",
        "OpenClaw loaded this bounded snapshot from the configured agent workspace.",
        "",
        `### ${instructionsPath}`,
        "",
        "  Bounded fixture rules.",
      ].join("\n"),
    });
  });

  it.each(["", " \n\t", "[MISSING] Expected at: fixture workspace"])(
    "records a successful empty capture for unusable context (%j)",
    (content) => {
      expect(
        buildAgentWorkspaceInstructionSnapshot([{ path: instructionsPath, content }], workspaceDir),
      ).toEqual({ files: [], instructions: "" });
    },
  );
});
