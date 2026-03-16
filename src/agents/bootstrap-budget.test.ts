import { describe, expect, it } from "vitest";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  buildBootstrapTruncationSignature,
  formatBootstrapTruncationWarningLines,
  resolveBootstrapWarningSignaturesSeen,
} from "./bootstrap-budget.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

describe("buildBootstrapInjectionStats", () => {
  it("maps raw and injected sizes and marks truncation", () => {
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: "/tmp/AGENTS.md",
        content: "a".repeat(100),
        missing: false,
      },
      {
        name: "SOUL.md",
        path: "/tmp/SOUL.md",
        content: "b".repeat(50),
        missing: false,
      },
    ];
    const injectedFiles = [
      { path: "/tmp/AGENTS.md", content: "a".repeat(100) },
      { path: "/tmp/SOUL.md", content: "b".repeat(20) },
    ];
    const stats = buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles,
    });
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({
      name: "AGENTS.md",
      rawChars: 100,
      injectedChars: 100,
      truncated: false,
    });
    expect(stats[1]).toMatchObject({
      name: "SOUL.md",
      rawChars: 50,
      injectedChars: 20,
      truncated: true,
    });
  });

  it("falls back to basename of path when name is missing (#47941)", () => {
    const bootstrapFiles = [
      {
        name: undefined as unknown as string,
        path: "/workspace/SELF_IMPROVEMENT_REMINDER.md",
        content: "reminder text",
        missing: false,
      },
      {
        name: "" as unknown as string,
        path: "/workspace/NOTES.md",
        content: "notes",
        missing: false,
      },
    ] as unknown as WorkspaceBootstrapFile[];

    const injectedFiles = [
      { path: "/workspace/SELF_IMPROVEMENT_REMINDER.md", content: "reminder text" },
      { path: "/workspace/NOTES.md", content: "notes" },
    ];

    const stats = buildBootstrapInjectionStats({ bootstrapFiles, injectedFiles });
    expect(stats[0]?.name).toBe("SELF_IMPROVEMENT_REMINDER.md");
    expect(stats[1]?.name).toBe("NOTES.md");
  });
});

describe("analyzeBootstrapBudget", () => {
  it("reports per-file and total-limit causes", () => {
    const analysis = analyzeBootstrapBudget({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          missing: false,
          rawChars: 150,
          injectedChars: 120,
          truncated: true,
        },
        {
          name: "SOUL.md",
          path: "/tmp/SOUL.md",
          missing: false,
          rawChars: 90,
          injectedChars: 80,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    expect(analysis.hasTruncation).toBe(true);
    expect(analysis.totalNearLimit).toBe(true);
    expect(analysis.truncatedFiles).toHaveLength(2);
    const agents = analysis.truncatedFiles.find((file) => file.name === "AGENTS.md");
    const soul = analysis.truncatedFiles.find((file) => file.name === "SOUL.md");
    expect(agents?.causes).toContain("per-file-limit");
    expect(agents?.causes).toContain("total-limit");
    expect(soul?.causes).toContain("total-limit");
  });

  it("does not force a total-limit cause when totals are within limits", () => {
    const analysis = analyzeBootstrapBudget({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          missing: false,
          rawChars: 90,
          injectedChars: 40,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    expect(analysis.truncatedFiles[0]?.causes).toEqual([]);
  });
});

describe("bootstrap prompt warnings", () => {
  it("resolves seen signatures from report history or legacy single signature", () => {
    expect(
      resolveBootstrapWarningSignaturesSeen({
        bootstrapTruncation: {
          warningSignaturesSeen: ["sig-a", " ", "sig-b", "sig-a"],
          promptWarningSignature: "legacy-ignored",
        },
      }),
    ).toEqual(["sig-a", "sig-b"]);

    expect(
      resolveBootstrapWarningSignaturesSeen({
        bootstrapTruncation: {
          promptWarningSignature: "legacy-only",
        },
      }),
    ).toEqual(["legacy-only"]);

    expect(resolveBootstrapWarningSignaturesSeen(undefined)).toEqual([]);
  });

  it("ignores single-signature fallback when warning mode is off", () => {
    expect(
      resolveBootstrapWarningSignaturesSeen({
        bootstrapTruncation: {
          warningMode: "off",
          promptWarningSignature: "off-mode-signature",
        },
      }),
    ).toEqual([]);

    expect(
      resolveBootstrapWarningSignaturesSeen({
        bootstrapTruncation: {
          warningMode: "off",
          warningSignaturesSeen: ["prior-once-signature"],
          promptWarningSignature: "off-mode-signature",
        },
      }),
    ).toEqual(["prior-once-signature"]);
  });

  it("dedupes warnings in once mode by signature", () => {
    const analysis = analyzeBootstrapBudget({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          missing: false,
          rawChars: 150,
          injectedChars: 100,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const first = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    expect(first.warningShown).toBe(true);
    expect(first.signature).toBeTruthy();
    expect(first.lines.join("\n")).toContain("AGENTS.md");

    const second = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
      seenSignatures: first.warningSignaturesSeen,
    });
    expect(second.warningShown).toBe(false);
    expect(second.lines).toEqual([]);
  });

  it("dedupes once mode across non-consecutive repeated signatures", () => {
    const analysisA = analyzeBootstrapBudget({
      files: [
        {
          name: "A.md",
          path: "/tmp/A.md",
          missing: false,
          rawChars: 150,
          injectedChars: 100,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const analysisB = analyzeBootstrapBudget({
      files: [
        {
          name: "B.md",
          path: "/tmp/B.md",
          missing: false,
          rawChars: 150,
          injectedChars: 100,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const firstA = buildBootstrapPromptWarning({
      analysis: analysisA,
      mode: "once",
    });
    expect(firstA.warningShown).toBe(true);
    const firstB = buildBootstrapPromptWarning({
      analysis: analysisB,
      mode: "once",
      seenSignatures: firstA.warningSignaturesSeen,
    });
    expect(firstB.warningShown).toBe(true);
    const secondA = buildBootstrapPromptWarning({
      analysis: analysisA,
      mode: "once",
      seenSignatures: firstB.warningSignaturesSeen,
    });
    expect(secondA.warningShown).toBe(false);
  });

  it("includes overflow line when more files are truncated than shown", () => {
    const analysis = analyzeBootstrapBudget({
      files: [
        {
          name: "A.md",
          path: "/tmp/A.md",
          missing: false,
          rawChars: 10,
          injectedChars: 1,
          truncated: true,
        },
        {
          name: "B.md",
          path: "/tmp/B.md",
          missing: false,
          rawChars: 10,
          injectedChars: 1,
          truncated: true,
        },
        {
          name: "C.md",
          path: "/tmp/C.md",
          missing: false,
          rawChars: 10,
          injectedChars: 1,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 20,
      bootstrapTotalMaxChars: 10,
    });
    const lines = formatBootstrapTruncationWarningLines({
      analysis,
      maxFiles: 2,
    });
    expect(lines).toContain("+1 more truncated file(s).");
  });

  it("disambiguates duplicate file names in warning lines", () => {
    const analysis = analyzeBootstrapBudget({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/a/AGENTS.md",
          missing: false,
          rawChars: 150,
          injectedChars: 100,
          truncated: true,
        },
        {
          name: "AGENTS.md",
          path: "/tmp/b/AGENTS.md",
          missing: false,
          rawChars: 140,
          injectedChars: 100,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 300,
    });
    const lines = formatBootstrapTruncationWarningLines({
      analysis,
    });
    expect(lines.join("\n")).toContain("AGENTS.md (/tmp/a/AGENTS.md)");
    expect(lines.join("\n")).toContain("AGENTS.md (/tmp/b/AGENTS.md)");
  });

  it("respects off/always warning modes", () => {
    const analysis = analyzeBootstrapBudget({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          missing: false,
          rawChars: 150,
          injectedChars: 100,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const signature = buildBootstrapTruncationSignature(analysis);
    const off = buildBootstrapPromptWarning({
      analysis,
      mode: "off",
      seenSignatures: [signature ?? ""],
      previousSignature: signature,
    });
    expect(off.warningShown).toBe(false);
    expect(off.lines).toEqual([]);

    const always = buildBootstrapPromptWarning({
      analysis,
      mode: "always",
      seenSignatures: [signature ?? ""],
      previousSignature: signature,
    });
    expect(always.warningShown).toBe(true);
    expect(always.lines.length).toBeGreaterThan(0);
  });

  it("uses file path in signature to avoid collisions for duplicate names", () => {
    const left = analyzeBootstrapBudget({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/a/AGENTS.md",
          missing: false,
          rawChars: 150,
          injectedChars: 100,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const right = analyzeBootstrapBudget({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/b/AGENTS.md",
          missing: false,
          rawChars: 150,
          injectedChars: 100,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    expect(buildBootstrapTruncationSignature(left)).not.toBe(
      buildBootstrapTruncationSignature(right),
    );
  });

  it("builds truncation report metadata from analysis + warning decision", () => {
    const analysis = analyzeBootstrapBudget({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          missing: false,
          rawChars: 150,
          injectedChars: 100,
          truncated: true,
        },
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const warning = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    const meta = buildBootstrapTruncationReportMeta({
      analysis,
      warningMode: "once",
      warning,
    });
    expect(meta.warningMode).toBe("once");
    expect(meta.warningShown).toBe(true);
    expect(meta.truncatedFiles).toBe(1);
    expect(meta.nearLimitFiles).toBeGreaterThanOrEqual(1);
    expect(meta.promptWarningSignature).toBeTruthy();
    expect(meta.warningSignaturesSeen?.length).toBeGreaterThan(0);
  });
});
