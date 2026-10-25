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

function injected(bootstrapFiles: WorkspaceBootstrapFile[], lengths: number[]) {
  return buildBootstrapInjectionStats({
    bootstrapFiles,
    injectedFiles: bootstrapFiles.flatMap(({ path, content }, index) =>
      lengths[index] === undefined ? [] : [{ path, content: content!.slice(0, lengths[index]) }],
    ),
  });
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
      bootstrapFile("AGENTS.md", "a".repeat(9)),
      {
        ...bootstrapFile("SOUL.md", "b".repeat(8)),
        origin: { kind: "execution-project", rootPath: "/tmp" },
      },
    ];

    const state = buildBootstrapBudgetState({
      config: {
        agents: { defaults: { bootstrapMaxChars: 10, bootstrapTotalMaxChars: 12 } },
      },
      files: injected(bootstrapFiles, [9, 3]),
    });

    expect(state).toMatchObject({
      bootstrapMaxChars: 10,
      bootstrapTotalMaxChars: 12,
      bootstrapAnalysis: {
        totalNearLimit: true,
        truncatedFiles: [
          { causes: ["total-limit"], origin: { kind: "execution-project", rootPath: "/tmp" } },
        ],
      },
      bootstrapPromptWarning: { warningShown: true },
    });
    expect(
      buildBootstrapTruncationReportMeta({
        analysis: state.bootstrapAnalysis,
        warning: state.bootstrapPromptWarning,
      }),
    ).toMatchObject({
      warningMode: "always",
      warningShown: true,
      truncatedFiles: 1,
      nearLimitFiles: 1,
      promptWarningSignature: state.bootstrapPromptWarning.signature,
      warningSignaturesSeen: [state.bootstrapPromptWarning.signature],
    });
  });

  it("derives names for path-only files supplied by bootstrap hooks", () => {
    const pathOnlyFile = {
      path: "/tmp/SELF_IMPROVEMENT_REMINDER.md",
      content: "remember",
      missing: false,
    } as unknown as WorkspaceBootstrapFile;
    const stats = injected([pathOnlyFile], [8]);
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

  it("does not attribute later total exhaustion to the USER.md fixed cap", () => {
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
    expect(buildBootstrapPromptWarningNotice(["AGENTS.md: 200 raw -> 0 injected"])).toBe(NOTICE);
    expect(repeated.warningSignaturesSeen).toEqual([seen.signature]);

    const history = Array.from({ length: 32 }, (_, index) => `previous-${index}`);
    const bounded = buildBootstrapBudgetState({
      files,
      seenSignatures: [" ", ...history, "previous-0"],
      previousSignature: "latest",
    }).bootstrapPromptWarning;
    expect(bounded.warningSignaturesSeen).toEqual([...history.slice(2), "latest", seen.signature]);
  });
});
