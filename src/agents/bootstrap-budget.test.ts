import { describe, expect, it } from "vitest";
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

function stat(name: string, rawChars: number, injectedChars: number): BootstrapInjectionStat {
  return {
    name,
    path: `/tmp/${name}`,
    missing: false,
    rawChars,
    injectedChars,
    truncated: injectedChars < rawChars,
  };
}

function bootstrapFile(
  name: WorkspaceBootstrapFile["name"],
  content: string,
  path = `/tmp/${name}`,
): WorkspaceBootstrapFile {
  return { name, path, content, missing: false };
}

function analyze(
  files: BootstrapInjectionStat[],
  bootstrapMaxChars = 20_000,
  bootstrapTotalMaxChars = 60_000,
) {
  return analyzeBootstrapBudget({ files, bootstrapMaxChars, bootstrapTotalMaxChars });
}

type TruncationReport = NonNullable<
  Parameters<typeof resolveBootstrapWarningSignaturesSeen>[0]
>["bootstrapTruncation"];

const NOTICE = [
  "[Bootstrap truncation warning]",
  "Some workspace bootstrap files were truncated before Project Context injection.",
  "Treat Project Context as partial and read the relevant files directly if details seem missing.",
].join("\n");

describe("bootstrap budget", () => {
  it("composes configured limits, ordered injection stats, and warning state", () => {
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      bootstrapFile("AGENTS.md", "a".repeat(8)),
      bootstrapFile("SOUL.md", "b".repeat(8)),
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

    expect(state).toMatchObject({
      bootstrapMaxChars: 10,
      bootstrapTotalMaxChars: 12,
      bootstrapAnalysis: { totalNearLimit: true },
      bootstrapPromptWarning: { warningShown: true },
    });
    expect(state.bootstrapAnalysis.truncatedFiles[0]?.causes).toEqual(["total-limit"]);
  });

  it("gives a budget-dropped file zero injected chars when a sibling shares its basename", () => {
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      {
        ...bootstrapFile("AGENTS.md", "a".repeat(1_000), "/tmp/workspace/AGENTS.md"),
        origin: { kind: "agent-workspace", rootPath: "/tmp/workspace" },
      },
      {
        ...bootstrapFile("AGENTS.md", "b".repeat(500), "/tmp/workspace/packages/core/AGENTS.md"),
        origin: { kind: "execution-project", rootPath: "/tmp/workspace/packages/core" },
      },
    ];

    const stats = buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(1_000) }],
    });
    const analysis = analyze(stats, 20_000, 1_000);

    expect(analysis.totals.injectedChars).toBe(1_000);
    expect(stats.map((file) => file.origin)).toEqual(bootstrapFiles.map((file) => file.origin));
    expect(analysis.truncatedFiles).toMatchObject([
      {
        path: "/tmp/workspace/packages/core/AGENTS.md",
        rawChars: 500,
        injectedChars: 0,
        truncated: true,
        causes: ["total-limit"],
      },
    ]);
  });

  it("derives names for path-only files supplied by bootstrap hooks", () => {
    const pathOnlyFile = {
      path: "/tmp/SELF_IMPROVEMENT_REMINDER.md",
      content: "remember",
      missing: false,
    } as unknown as WorkspaceBootstrapFile;
    const stats = buildBootstrapInjectionStats({
      bootstrapFiles: [pathOnlyFile],
      injectedFiles: [{ path: pathOnlyFile.path, content: "remember" }],
    });
    expect(stats).toMatchObject([
      {
        name: "SELF_IMPROVEMENT_REMINDER.md",
        path: "/tmp/SELF_IMPROVEMENT_REMINDER.md",
        injectedChars: 8,
        truncated: false,
      },
    ]);
  });

  it("reports causes while excluding missing-file markers from file totals", () => {
    const analysis = analyze(
      [
        stat("AGENTS.md", 150, 120),
        { ...stat("IDENTITY.md", 0, 40), missing: true },
        stat("SOUL.md", 50, 40),
      ],
      120,
      200,
    );
    expect(analysis).toMatchObject({
      hasTruncation: true,
      totalNearLimit: false,
      totals: { rawChars: 200, injectedChars: 160 },
      truncatedFiles: [
        { causes: ["per-file-limit"] },
        { causes: expect.arrayContaining(["total-limit"]) },
      ],
    });
  });

  it("distinguishes lower per-file and exhausted total limits for USER.md", () => {
    const lowerPerFile = analyze([stat("USER.md", 3_000, 2_000)], 2_000);
    expect(lowerPerFile.truncatedFiles[0]).toMatchObject({
      effectiveFileLimit: 2_000,
      causes: ["per-file-limit"],
    });

    const exhaustedTotal = analyze(
      [stat("AGENTS.md", 2_000, 2_000), stat("USER.md", 5_000, 0)],
      20_000,
      2_040,
    );
    expect(exhaustedTotal.truncatedFiles[0]?.causes).toContain("total-limit");

    const laterExhaustion = analyze(
      [stat("USER.md", 5_000, 4_000), stat("SOUL.md", 100, 0)],
      20_000,
      4_040,
    );
    const user = laterExhaustion.truncatedFiles.find((file) => file.name === "USER.md");
    const soul = laterExhaustion.truncatedFiles.find((file) => file.name === "SOUL.md");
    expect(user?.causes).toStrictEqual(["per-file-limit"]);
    expect(soul?.causes).toContain("total-limit");
  });

  it("builds a concise agent notice without raw truncation diagnostics", () => {
    const notice = buildBootstrapPromptWarningNotice([
      "AGENTS.md: 200 raw -> 0 injected",
      "If unintentional, raise agents.defaults.bootstrapMaxChars.",
    ]);

    expect(notice).toBe(NOTICE);
  });

  it.each<[TruncationReport, string[]]>([
    [
      { warningSignaturesSeen: ["a", " ", "b", "a"], promptWarningSignature: "ignored" },
      ["a", "b"],
    ],
    [{ promptWarningSignature: "legacy" }, ["legacy"]],
    [undefined, []],
    [{ warningMode: "off", promptWarningSignature: "off" }, []],
    [
      { warningMode: "off", warningSignaturesSeen: ["once"], promptWarningSignature: "off" },
      ["once"],
    ],
  ])("restores warning signatures from %j", (report, expected) => {
    expect(
      resolveBootstrapWarningSignaturesSeen(
        report === undefined ? undefined : { bootstrapTruncation: report },
      ),
    ).toEqual(expected);
  });

  it("warns on repeated truncation while bounding distinct signature history", () => {
    const files = [stat("AGENTS.md", 150, 100)];
    const seen = buildBootstrapBudgetState({ files }).bootstrapPromptWarning;
    const repeated = buildBootstrapBudgetState({
      files,
      seenSignatures: seen.warningSignaturesSeen,
      previousSignature: seen.signature,
    }).bootstrapPromptWarning;
    expect(repeated).toMatchObject({ warningShown: true, lines: [NOTICE] });
    expect(repeated.warningSignaturesSeen).toEqual([seen.signature]);

    const history = Array.from({ length: 32 }, (_, index) => `previous-${index}`);
    const bounded = buildBootstrapBudgetState({
      files,
      seenSignatures: [" ", ...history, "previous-0"],
      previousSignature: "latest",
    }).bootstrapPromptWarning;
    expect(bounded.warningSignaturesSeen).toEqual([...history.slice(2), "latest", seen.signature]);
  });

  it("builds truncation report metadata from analysis + warning decision", () => {
    const { bootstrapAnalysis: analysis, bootstrapPromptWarning: warning } =
      buildBootstrapBudgetState({
        config: { agents: { defaults: { bootstrapMaxChars: 120, bootstrapTotalMaxChars: 200 } } },
        files: [stat("AGENTS.md", 150, 100)],
      });
    const meta = buildBootstrapTruncationReportMeta({
      analysis,
      warning,
    });
    expect(meta).toMatchObject({
      warningMode: "always",
      warningShown: true,
      truncatedFiles: 1,
      nearLimitFiles: 1,
      promptWarningSignature: warning.signature,
      warningSignaturesSeen: [warning.signature],
    });
  });
});
