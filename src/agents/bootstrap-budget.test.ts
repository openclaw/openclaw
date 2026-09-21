/** Tests bootstrap context truncation accounting and user-facing warning metadata. */
import { describe, expect, it } from "vitest";
import { buildBootstrapPromptWarning } from "./bootstrap-budget-warning.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapBudgetState,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarningNotice,
  buildBootstrapTruncationReportMeta,
  resolveBootstrapWarningSignaturesSeen,
} from "./bootstrap-budget.js";
import type { BootstrapInjectionStat } from "./bootstrap-budget.types.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function createTruncatedBootstrapFile(
  name: string,
  path: string,
  rawChars: number,
  injectedChars: number,
): BootstrapInjectionStat {
  return { name, path, missing: false, rawChars, injectedChars, truncated: true };
}

describe("buildBootstrapBudgetState", () => {
  it("composes configured limits, ordered injection stats, and warning state", () => {
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: "/tmp/AGENTS.md",
        content: "a".repeat(8),
        missing: false,
      },
      {
        name: "SOUL.md",
        path: "/tmp/SOUL.md",
        content: "b".repeat(8),
        missing: false,
      },
    ];

    const state = buildBootstrapBudgetState({
      config: {
        agents: { defaults: { bootstrapMaxChars: 10, bootstrapTotalMaxChars: 12 } },
      },
      files: buildBootstrapInjectionStats({
        bootstrapFiles,
        injectedFiles: [
          { path: "/tmp/AGENTS.md", content: "a".repeat(8) },
          { path: "/tmp/SOUL.md", content: "b".repeat(4) },
        ],
      }),
    });

    expect(state.bootstrapMaxChars).toBe(10);
    expect(state.bootstrapTotalMaxChars).toBe(12);
    expect(state.bootstrapPromptWarningMode).toBe("always");
    expect(state.bootstrapAnalysis.totalNearLimit).toBe(true);
    expect(state.bootstrapAnalysis.truncatedFiles[0]?.causes).toEqual(["total-limit"]);
    expect(state.bootstrapPromptWarning.warningShown).toBe(true);
  });
});

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
    expect(stats[0]?.name).toBe("AGENTS.md");
    expect(stats[0]?.rawChars).toBe(100);
    expect(stats[0]?.injectedChars).toBe(100);
    expect(stats[0]?.truncated).toBe(false);
    expect(stats[1]?.name).toBe("SOUL.md");
    expect(stats[1]?.rawChars).toBe(50);
    expect(stats[1]?.injectedChars).toBe(20);
    expect(stats[1]?.truncated).toBe(true);
  });

  it("gives a budget-dropped file zero injected chars when a sibling shares its basename", () => {
    // Extra bootstrap files can repeat a root basename (packages/*/AGENTS.md).
    // Injection identity is the source path, so a file the total budget dropped
    // must not inherit the bytes of the sibling that consumed that budget.
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: "/tmp/workspace/AGENTS.md",
        content: "a".repeat(1_000),
        missing: false,
      },
      {
        name: "AGENTS.md",
        path: "/tmp/workspace/packages/core/AGENTS.md",
        content: "b".repeat(500),
        missing: false,
      },
    ];

    const stats = buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(1_000) }],
    });
    const analysis = analyzeBootstrapBudget({
      files: stats,
      bootstrapMaxChars: 20_000,
      bootstrapTotalMaxChars: 1_000,
    });

    expect(stats[1]).toMatchObject({
      path: "/tmp/workspace/packages/core/AGENTS.md",
      rawChars: 500,
      injectedChars: 0,
      truncated: true,
    });
    expect(analysis.totals.injectedChars).toBe(1_000);
    expect(analysis.truncatedFiles.map((file) => file.path)).toEqual([
      "/tmp/workspace/packages/core/AGENTS.md",
    ]);
    expect(analysis.truncatedFiles[0]?.causes).toEqual(["total-limit"]);
  });

  it("derives names for path-only files supplied by bootstrap hooks", () => {
    const pathOnlyFile = {
      path: "/tmp/SELF_IMPROVEMENT_REMINDER.md",
      content: "remember",
      missing: false,
    } as unknown as WorkspaceBootstrapFile;
    const injectedFiles = [
      {
        path: "/tmp/SELF_IMPROVEMENT_REMINDER.md",
        content: "remember",
      },
    ];

    const stats = buildBootstrapInjectionStats({
      bootstrapFiles: [pathOnlyFile],
      injectedFiles,
    });
    const analysis = analyzeBootstrapBudget({
      files: stats,
      bootstrapMaxChars: 20_000,
      bootstrapTotalMaxChars: 60_000,
    });

    expect(analysis.files).toEqual([
      expect.objectContaining({
        name: "SELF_IMPROVEMENT_REMINDER.md",
        path: "/tmp/SELF_IMPROVEMENT_REMINDER.md",
        injectedChars: 8,
        truncated: false,
      }),
    ]);
  });
});

describe("analyzeBootstrapBudget", () => {
  it("reports causes while excluding missing-file markers from file totals", () => {
    const analysis = analyzeBootstrapBudget({
      files: [
        createTruncatedBootstrapFile("AGENTS.md", "/tmp/AGENTS.md", 150, 120),
        {
          name: "IDENTITY.md",
          path: "/tmp/IDENTITY.md",
          missing: true,
          rawChars: 0,
          injectedChars: 40,
          truncated: false,
        },
        createTruncatedBootstrapFile("SOUL.md", "/tmp/SOUL.md", 50, 40),
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    expect(analysis.hasTruncation).toBe(true);
    expect(analysis.totalNearLimit).toBe(false);
    expect(analysis.truncatedFiles).toHaveLength(2);
    expect(analysis.totals).toMatchObject({ rawChars: 200, injectedChars: 160 });
    expect(analysis.files[1]).toMatchObject({ nearLimit: false, causes: [] });
    const agents = analysis.truncatedFiles.find((file) => file.name === "AGENTS.md");
    const soul = analysis.truncatedFiles.find((file) => file.name === "SOUL.md");
    expect(agents?.causes).toContain("per-file-limit");
    expect(agents?.causes).not.toContain("total-limit");
    expect(soul?.causes).toContain("total-limit");
  });

  it("does not force a total-limit cause when totals are within limits", () => {
    const analysis = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("AGENTS.md", "/tmp/AGENTS.md", 90, 40)],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    expect(analysis.truncatedFiles[0]?.causes).toStrictEqual([]);
  });

  it("accounts for the fixed USER.md budget", () => {
    const analysis = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("USER.md", "/tmp/USER.md", 5_000, 4_000)],
      bootstrapMaxChars: 20_000,
      bootstrapTotalMaxChars: 60_000,
    });

    expect(analysis.truncatedFiles[0]?.causes).toContain("per-file-limit");
    const lines = buildBootstrapPromptWarning({ analysis, mode: "always" }).lines;
    expect(lines).toContain("USER.md has a fixed 4000-character bootstrap cap; keep it compact.");
    expect(lines.join("\n")).not.toContain("raise agents.defaults.bootstrapMaxChars");
  });

  it("keeps USER.md advice accurate for lower per-file and exhausted total limits", () => {
    const lowerPerFile = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("USER.md", "/tmp/USER.md", 3_000, 2_000)],
      bootstrapMaxChars: 2_000,
      bootstrapTotalMaxChars: 60_000,
    });
    const lowerLines = buildBootstrapPromptWarning({
      analysis: lowerPerFile,
      mode: "always",
    }).lines;
    expect(lowerLines.join("\n")).not.toContain("fixed 4000-character");
    expect(lowerLines.join("\n")).toContain("raise agents.defaults.bootstrapMaxChars");

    const exhaustedTotal = analyzeBootstrapBudget({
      files: [
        {
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          missing: false,
          rawChars: 2_000,
          injectedChars: 2_000,
          truncated: false,
        },
        createTruncatedBootstrapFile("USER.md", "/tmp/USER.md", 5_000, 0),
      ],
      bootstrapMaxChars: 20_000,
      bootstrapTotalMaxChars: 2_040,
    });
    const exhaustedLines = buildBootstrapPromptWarning({
      analysis: exhaustedTotal,
      mode: "always",
    }).lines;
    expect(exhaustedTotal.truncatedFiles[0]?.causes).toContain("total-limit");
    expect(exhaustedLines.join("\n")).toContain("fixed 4000-character");
    expect(exhaustedLines.join("\n")).toContain("bootstrapTotalMaxChars");

    const laterExhaustion = analyzeBootstrapBudget({
      files: [
        createTruncatedBootstrapFile("USER.md", "/tmp/USER.md", 5_000, 4_000),
        createTruncatedBootstrapFile("SOUL.md", "/tmp/SOUL.md", 100, 0),
      ],
      bootstrapMaxChars: 20_000,
      bootstrapTotalMaxChars: 4_040,
    });
    const user = laterExhaustion.truncatedFiles.find((file) => file.name === "USER.md");
    const soul = laterExhaustion.truncatedFiles.find((file) => file.name === "SOUL.md");
    expect(user?.causes).toStrictEqual(["per-file-limit"]);
    expect(soul?.causes).toContain("total-limit");
  });
});

describe("bootstrap prompt warnings", () => {
  it("handles malformed truncation entries without names", () => {
    const analysis = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("TEMP.md", "/tmp/unknown", 10, 1)],
      bootstrapMaxChars: 5,
      bootstrapTotalMaxChars: 5,
    });
    (analysis.truncatedFiles[0] as { name?: string }).name = undefined;

    const lines = buildBootstrapPromptWarning({
      analysis,
      mode: "always",
    }).lines;
    expect(lines.join("\n")).toContain("10 raw -> 1 injected");
  });

  it("builds a concise agent notice without raw truncation diagnostics", () => {
    const notice = buildBootstrapPromptWarningNotice([
      "AGENTS.md: 200 raw -> 0 injected",
      "If unintentional, raise agents.defaults.bootstrapMaxChars.",
    ]);

    expect(notice).toContain("[Bootstrap truncation warning]");
    expect(notice).toContain("Treat Project Context as partial");
    expect(notice).not.toContain("raw ->");
    expect(notice).not.toContain("bootstrapMaxChars");
  });

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

    expect(resolveBootstrapWarningSignaturesSeen(undefined)).toStrictEqual([]);
  });

  it("ignores single-signature fallback when warning mode is off", () => {
    expect(
      resolveBootstrapWarningSignaturesSeen({
        bootstrapTruncation: {
          warningMode: "off",
          promptWarningSignature: "off-mode-signature",
        },
      }),
    ).toStrictEqual([]);

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
      files: [createTruncatedBootstrapFile("AGENTS.md", "/tmp/AGENTS.md", 150, 100)],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const first = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    expect(first.warningShown).toBe(true);
    expect(first.signature).toBeTypeOf("string");
    expect(first.signature).not.toBe("");
    // Signatures carry only stable truncation inputs so once-mode warnings dedupe
    // without tying prompt cache bytes to volatile warning prose.
    const signature = JSON.parse(first.signature ?? "{}") as {
      bootstrapMaxChars?: unknown;
      bootstrapTotalMaxChars?: unknown;
      files?: Array<{
        path?: unknown;
        rawChars?: unknown;
        injectedChars?: unknown;
        causes?: unknown;
      }>;
    };
    expect(signature.bootstrapMaxChars).toBe(120);
    expect(signature.bootstrapTotalMaxChars).toBe(200);
    expect(signature.files).toStrictEqual([
      {
        causes: ["per-file-limit"],
        injectedChars: 100,
        path: "/tmp/AGENTS.md",
        rawChars: 150,
      },
    ]);
    expect(first.lines.join("\n")).toContain("AGENTS.md");

    const second = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
      seenSignatures: first.warningSignaturesSeen,
    });
    expect(second.warningShown).toBe(false);
    expect(second.lines).toStrictEqual([]);
  });

  it("dedupes once mode across non-consecutive repeated signatures", () => {
    const analysisA = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("A.md", "/tmp/A.md", 150, 100)],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const analysisB = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("B.md", "/tmp/B.md", 150, 100)],
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
        createTruncatedBootstrapFile("A.md", "/tmp/A.md", 10, 1),
        createTruncatedBootstrapFile("B.md", "/tmp/B.md", 10, 1),
        createTruncatedBootstrapFile("C.md", "/tmp/C.md", 10, 1),
      ],
      bootstrapMaxChars: 20,
      bootstrapTotalMaxChars: 10,
    });
    const lines = buildBootstrapPromptWarning({
      analysis,
      mode: "always",
      maxFiles: 2,
    }).lines;
    expect(lines).toContain("+1 more truncated file(s).");
  });

  it("warns explicitly when AGENTS.md bootstrap policy is truncated", () => {
    const analysis = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("AGENTS.md", "/tmp/AGENTS.md", 150, 100)],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const lines = buildBootstrapPromptWarning({
      analysis,
      mode: "always",
    }).lines;

    expect(lines).toContain(
      "AGENTS.md was truncated; read the full AGENTS.md before relying on scoped policy.",
    );
  });

  it("disambiguates duplicate file names in warning lines", () => {
    const analysis = analyzeBootstrapBudget({
      files: [
        createTruncatedBootstrapFile("AGENTS.md", "/tmp/a/AGENTS.md", 150, 100),
        createTruncatedBootstrapFile("AGENTS.md", "/tmp/b/AGENTS.md", 140, 100),
      ],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 300,
    });
    const lines = buildBootstrapPromptWarning({
      analysis,
      mode: "always",
    }).lines;
    expect(lines.join("\n")).toContain("AGENTS.md (/tmp/a/AGENTS.md)");
    expect(lines.join("\n")).toContain("AGENTS.md (/tmp/b/AGENTS.md)");
  });

  it("respects off/always warning modes", () => {
    const analysis = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("AGENTS.md", "/tmp/AGENTS.md", 150, 100)],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const seen = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    const off = buildBootstrapPromptWarning({
      analysis,
      mode: "off",
      seenSignatures: seen.warningSignaturesSeen,
      previousSignature: seen.signature,
    });
    expect(off.warningShown).toBe(false);
    expect(off.lines).toStrictEqual([]);

    const always = buildBootstrapPromptWarning({
      analysis,
      mode: "always",
      seenSignatures: seen.warningSignaturesSeen,
      previousSignature: seen.signature,
    });
    expect(always.warningShown).toBe(true);
    expect(always.lines).toStrictEqual([
      "AGENTS.md: 150 raw -> 100 injected (~33% removed; max/file).",
      "AGENTS.md was truncated; read the full AGENTS.md before relying on scoped policy.",
      "If unintentional, raise agents.defaults.bootstrapMaxChars and/or agents.defaults.bootstrapTotalMaxChars.",
    ]);
  });

  it("uses file path in signature to avoid collisions for duplicate names", () => {
    const left = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("AGENTS.md", "/tmp/a/AGENTS.md", 150, 100)],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const right = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("AGENTS.md", "/tmp/b/AGENTS.md", 150, 100)],
      bootstrapMaxChars: 120,
      bootstrapTotalMaxChars: 200,
    });
    const leftWarning = buildBootstrapPromptWarning({ analysis: left, mode: "once" });
    const rightWarning = buildBootstrapPromptWarning({ analysis: right, mode: "once" });
    expect(leftWarning.signature).not.toBe(rightWarning.signature);
  });

  it("builds truncation report metadata from analysis + warning decision", () => {
    const analysis = analyzeBootstrapBudget({
      files: [createTruncatedBootstrapFile("AGENTS.md", "/tmp/AGENTS.md", 150, 100)],
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
    expect(meta.nearLimitFiles).toBe(1);
    expect(meta.promptWarningSignature).toBe(warning.signature);
    expect(meta.warningSignaturesSeen).toEqual([warning.signature]);
  });
});
