import { describe, expect, it } from "vitest";
import type { WorkspaceBootstrapFile } from "../workspace.js";
import { buildBootstrapContextFiles } from "./bootstrap.js";

const makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: "AGENTS.md",
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});

describe("bootstrap truncation warning", () => {
  it("shows per-file limit when truncated within per-file budget", () => {
    const files = [makeFile({ name: "MEMORY.md", content: "x".repeat(500) })];
    const warnings: string[] = [];
    buildBootstrapContextFiles(files, {
      maxChars: 200,
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("per-file limit 200");
    expect(warnings[0]).not.toContain("total remaining");
  });

  it("shows total budget detail when per-file budget is reduced by earlier files", () => {
    const files = [
      makeFile({ name: "AGENTS.md", content: "a".repeat(8_000) }),
      makeFile({
        name: "MEMORY.md",
        path: "/tmp/MEMORY.md",
        content: "b".repeat(10_000),
      }),
    ];
    const warnings: string[] = [];
    buildBootstrapContextFiles(files, {
      maxChars: 20_000,
      totalMaxChars: 12_000,
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MEMORY.md");
    expect(warnings[0]).toContain("total remaining");
    expect(warnings[0]).toContain("per-file limit 20000");
    expect(warnings[0]).toContain("of 12000 total");
  });
});
