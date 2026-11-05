import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { describe, expect, it, vi } from "vitest";
import * as compiler from "./compile.js";
import { lintMemoryWikiVault } from "./lint.js";
import {
  renderWikiMarkdown,
  WIKI_RAW_SOURCE_MARKER,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { writeMemoryWikiSourceSyncState } from "./source-sync-state.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    replaceFileAtomic: vi.fn(actual.replaceFileAtomic),
  };
});

const { createVault: createLintVault } = createMemoryWikiTestHarness();

function issueCodesForPath(
  result: Awaited<ReturnType<typeof lintMemoryWikiVault>>,
  pagePath: string,
): string[] {
  return result.issues
    .filter((issue) => issue.path === pagePath)
    .map((issue) => issue.code)
    .toSorted();
}

describe("lintMemoryWikiVault", () => {
  it("accepts unmanaged raw markdown source pages without page frontmatter", async () => {
    const { config, write } = await createLintVault();
    const raw = (title: string) =>
      `# ${title}\n\n${WIKI_RAW_SOURCE_MARKER}\n\nRaw source notes stay usable as source evidence.\n`;
    await write("sources/raw-alpha.md", raw("Raw Alpha Source"));
    await write(
      "sources/raw-native-frontmatter.md",
      `---\nid: note\n---\n\n${raw("Raw Native Frontmatter")}`,
    );
    await write(
      "sources/raw-native-frontmatter-copy.md",
      `---\nid: note\n---\n\n${raw("Raw Native Frontmatter Copy")}`,
    );

    const result = await lintMemoryWikiVault(config);

    const rawIssueCodes = issueCodesForPath(result, "sources/raw-alpha.md");
    expect(
      result.issuesByCategory.structure.filter((issue) => issue.path === "sources/raw-alpha.md"),
    ).toHaveLength(0);
    const nativeFrontmatterIssueCodes = issueCodesForPath(
      result,
      "sources/raw-native-frontmatter.md",
    );
    for (const codes of [rawIssueCodes, nativeFrontmatterIssueCodes]) {
      for (const code of ["missing-id", "missing-page-type", "stale-page"]) {
        expect(codes).not.toContain(code);
      }
    }
    expect(nativeFrontmatterIssueCodes).toContain("duplicate-id");
    expect(issueCodesForPath(result, "sources/raw-native-frontmatter-copy.md")).toContain(
      "duplicate-id",
    );
  });

  it.each([false, true])(
    "keeps malformed imported sources visible to structure lint (tracked truncation: %s)",
    async (tracked) => {
      const { config, write } = await createLintVault();
      const paths = ["sources/bridge.md", "sources/unsafe.md"] as const;
      if (tracked) {
        const body = `## Related\n${WIKI_RELATED_START_MARKER}\n- No related pages yet.\n${WIKI_RELATED_END_MARKER}\n`;
        for (const pagePath of paths) {
          await write(pagePath, body);
        }
        const entry = {
          sourcePath: "/tmp/input",
          sourceUpdatedAtMs: 1,
          sourceSize: 2,
          renderFingerprint: "tracked",
        };
        await writeMemoryWikiSourceSyncState(config.vault.path, {
          version: 1,
          entries: {
            bridge: { ...entry, group: "bridge", pagePath: paths[0] },
            unsafe: { ...entry, group: "unsafe-local", pagePath: paths[1] },
          },
        });
      } else {
        const notes = "## Notes\n<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->";
        for (const [file, title, metadata] of [
          [
            paths[0],
            "Memory Bridge: Alpha",
            "Bridge Source\n- Workspace: `/tmp/workspace`\n- Relative path: `MEMORY.md`",
          ],
          [
            paths[1],
            "Unsafe Local Import: alpha.md",
            "Unsafe Local Source\n- Configured path: `/tmp/private`\n- Relative path: `alpha.md`",
          ],
        ] as const) {
          await write(file, `# ${title}\n\n## ${metadata}\n\n## Content\nalpha body\n\n${notes}`);
        }
      }
      const result = await lintMemoryWikiVault(config);
      for (const pagePath of paths) {
        expect(issueCodesForPath(result, pagePath)).toEqual(
          expect.arrayContaining(["missing-id", "missing-page-type"]),
        );
      }
    },
  );

  it.each([
    {
      name: "keeps path target matching case-sensitive",
      stem: "alpha-db",
      title: "Alpha Database",
      links: ["Alpha Database", "alpha-database", "syntheses/Alpha-DB", "Alpha-DB"],
      broken: ["syntheses/Alpha-DB", "Alpha-DB"],
    },
    {
      name: "preserves question marks in Obsidian title and slug wikilinks",
      stem: "roadmap",
      title: "Roadmap",
      links: [
        "Roadmap? v2",
        "roadmap? v2",
        "syntheses/roadmap?view=compact",
        "syntheses/roadmap.md?view=compact",
      ],
      broken: ["Roadmap? v2", "roadmap? v2"],
    },
  ])("$name", async ({ stem, title, links, broken }) => {
    const { config, page } = await createLintVault({
      config: { vault: { renderMode: "obsidian" } },
    });
    await page(
      "sources/links.md",
      { pageType: "source", id: "source.links", title: "Links" },
      "# Links\n\n" + links.map((target) => `[[${target}]]`).join("\n"),
    );
    await page(`syntheses/${stem}.md`, {
      pageType: "synthesis",
      id: `synthesis.${stem}`,
      title,
      sourceIds: ["source.links"],
    });
    const result = await lintMemoryWikiVault(config);
    expect(
      result.issues
        .filter((issue) => issue.code === "broken-wikilink")
        .map((issue) => issue.message),
    ).toEqual(broken.map((target) => `Broken wikilink target \`${target}\`.`));
  });

  it("resolves CommonMark and percent-encoded destinations for lint and backlinks", async () => {
    const { config, page, rootDir } = await createLintVault();
    const targets = ["plan.md", "plan(v2).md", "plan notes.md", "encoded notes.md"];
    for (const [index, target] of targets.entries()) {
      await page(`entities/${target}`, {
        pageType: "entity",
        id: `entity.plan-${index}`,
        title: `Plan ${index}`,
      });
    }
    await page(
      "sources/links.md",
      { pageType: "source", id: "source.links", title: "Links" },
      '# Links\n\n[Plan](../entities/plan.md "Project plan")\n' +
        "[Revision](../entities/plan(v2).md)\n" +
        "[Notes](<../entities/plan notes.md>)\n" +
        "[Encoded](../entities/encoded%20notes.md)\n",
    );

    const result = await lintMemoryWikiVault(config);

    expect(result.issues.filter((issue) => issue.code === "broken-wikilink")).toEqual([]);
    for (const target of targets) {
      const raw = await fs.readFile(path.join(rootDir, "entities", target), "utf8");
      const related = raw.split(WIKI_RELATED_START_MARKER)[1]?.split(WIKI_RELATED_END_MARKER)[0];
      expect(related).toContain("Referenced By");
      expect(related).toContain("Links");
    }
  });

  it("detects duplicate ids, provenance gaps, contradictions, and open questions", async () => {
    const { config, page, write } = await createLintVault({
      config: { vault: { renderMode: "obsidian" } },
    });

    const duplicate = renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        id: "entity.alpha",
        title: "Alpha",
        contradictions: ["Conflicts with source.beta"],
        questions: ["Is Alpha still active?"],
        confidence: 0.2,
        claims: [
          {
            id: "claim.alpha.db",
            text: "Alpha uses PostgreSQL for production writes.",
            confidence: 0.2,
            evidence: [],
          },
        ],
      },
      body: "# Alpha\n\n[[missing-page]]\n",
    });
    await write("entities/alpha.md", duplicate);
    await write("concepts/alpha.md", duplicate);
    await page("sources/bridge-alpha.md", {
      pageType: "source",
      id: "source.bridge.alpha",
      title: "Bridge Alpha",
      sourceType: "memory-bridge",
    });
    await page("syntheses/alpha-db.md", {
      pageType: "synthesis",
      id: "synthesis.alpha.db",
      title: "Alpha Database",
      sourceIds: ["source.bridge.alpha"],
      updatedAt: "2025-10-01T00:00:00.000Z",
      claims: [
        {
          id: "claim.alpha.db",
          text: "Alpha uses MySQL for production writes.",
          status: "contested",
          confidence: 0.7,
          evidence: [
            {
              sourceId: "source.bridge.alpha",
              lines: "1-3",
              updatedAt: "2025-10-01T00:00:00.000Z",
            },
          ],
        },
      ],
    });

    const result = await lintMemoryWikiVault(config);

    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "duplicate-id",
        "missing-source-ids",
        "missing-import-provenance",
        "broken-wikilink",
        "contradiction-present",
        "claim-conflict",
        "open-question",
        "low-confidence",
        "claim-missing-evidence",
        "claim-low-confidence",
        "stale-page",
        "stale-claim",
      ]),
    );
    expect(result.issuesByCategory.contradictions.map((issue) => issue.code)).toContain(
      "claim-conflict",
    );
    expect(result.issuesByCategory["open-questions"].length).toBeGreaterThanOrEqual(2);
    expect(result.issuesByCategory.provenance.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["missing-import-provenance", "claim-missing-evidence"]),
    );
    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("<!-- openclaw:wiki:lint:start -->\n- Errors: 3\n- Warnings: 25");
    for (const [heading, detail] of [
      ["Errors", "Expected pageType `concept`, found `entity`."],
      ["Warnings", "Broken wikilink target `missing-page`."],
      ["Contradictions", "Claim cluster `claim.alpha.db` has competing variants across 3 pages."],
      ["Open Questions", "Page lists 1 open question."],
      ["Quality Follow-Up", "Claim `claim.alpha.db` is missing structured evidence."],
    ]) {
      const section = report.split(`### ${heading}\n`)[1]?.split("\n### ")[0];
      expect(section).toContain(detail);
      expect(section).toContain("`concepts/alpha.md`");
    }
    expect(report).toContain("<!-- openclaw:wiki:lint:end -->");
  });

  it("reports unparsable frontmatter as a lint issue instead of failing the whole vault (#96125)", async () => {
    const { config, write, page } = await createLintVault();
    await write(
      "syntheses/broken.md",
      [
        "---\npageType: synthesis\nid: synthesis.broken\nsourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
        "---\n\n# Broken\n\nBody text.",
      ].join("\n"),
    );
    await page("syntheses/healthy.md", {
      pageType: "synthesis",
      id: "synthesis.healthy",
      title: "Healthy",
      sourceIds: ["source.alpha"],
    });

    const result = await lintMemoryWikiVault(config);

    expect(issueCodesForPath(result, "syntheses/broken.md")).toEqual(["invalid-frontmatter"]);
    expect(issueCodesForPath(result, "syntheses/healthy.md")).not.toContain("invalid-frontmatter");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain(
      "Frontmatter failed to parse: Unexpected scalar",
    );
  });

  it("preserves report notes when the lint writer cannot read the existing report", async () => {
    const { config, page } = await createLintVault();
    const reportPath = await page(
      "reports/lint.md",
      { pageType: "report", id: "report.lint", title: "Lint Report" },
      "# Lint Report\n\n## Notes\nHuman notes must survive a failed read.\n",
    );
    const originalBytes = await fs.readFile(reportPath);
    const readError = Object.assign(new Error("injected report read failure"), { code: "EACCES" });
    const readFile = fs.readFile;
    const compile = compiler.compileMemoryWikiVault;
    let compiled = false;
    let injected = false;
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(
        async (...args: Parameters<typeof fs.readFile>): ReturnType<typeof fs.readFile> => {
          if (compiled && args[0] === reportPath) {
            injected = true;
            throw readError;
          }
          return readFile(...args);
        },
      );
    const compileSpy = vi
      .spyOn(compiler, "compileMemoryWikiVault")
      .mockImplementationOnce(async (...args) => {
        const result = await compile(...args);
        compiled = true;
        return result;
      });
    try {
      await expect(lintMemoryWikiVault(config)).rejects.toBe(readError);
    } finally {
      readSpy.mockRestore();
      compileSpy.mockRestore();
    }

    expect(injected).toBe(true);
    expect(await fs.readFile(reportPath)).toEqual(originalBytes);
  });

  it("keeps the previous lint report when atomic publication fails", async () => {
    const { config, page } = await createLintVault();
    const reportPath = await page(
      "reports/lint.md",
      { pageType: "report", id: "report.lint", title: "Lint Report", status: "active" },
      "# Lint Report\n\nPrevious valid lint report.\n",
    );
    const reportsDir = path.dirname(reportPath);
    await fs.chmod(reportPath, 0o640);
    const previousBytes = await fs.readFile(reportPath);
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/security-runtime")>(
      "openclaw/plugin-sdk/security-runtime",
    );
    const publicationError = Object.assign(new Error("injected lint report publication failure"), {
      code: "EIO",
    });
    vi.mocked(replaceFileAtomic).mockImplementationOnce((options) =>
      actual.replaceFileAtomic({
        ...options,
        beforeRename: async ({ tempPath }) => {
          await fs.writeFile(tempPath, "partial lint report", "utf8");
          throw publicationError;
        },
      }),
    );

    await expect(lintMemoryWikiVault(config)).rejects.toBe(publicationError);
    await expect(fs.readFile(reportPath)).resolves.toEqual(previousBytes);
    if (process.platform !== "win32") {
      expect((await fs.stat(reportPath)).mode & 0o777).toBe(0o640);
    }
    const lintPublicationFiles = (await fs.readdir(reportsDir)).filter(
      (entry) => entry === "lint.md" || entry.startsWith("lint.md.lint-report."),
    );
    expect(lintPublicationFiles).toEqual(["lint.md"]);
  });

  it.each([
    [
      "syntax-error",
      '---\npageType: report\nid: report.lint\nsourceIds:\n  - **MEMORY.md line 235**:"some quoted, value"\n---\n# Existing report',
      { message: expect.stringContaining("Unexpected scalar") },
    ],
    [
      "sequence-root",
      "---\n- pageType: report\n  id: report.lint\n---\n# Existing report",
      { message: expect.stringContaining("Wiki frontmatter must be a YAML mapping") },
    ],
    ["invalid UTF-8", Buffer.from([0xff]), { name: "WikiPageNotUtf8Error" }],
  ] as const)(
    "rejects a malformed lint report without changing its bytes (%s)",
    async (_name, content, error) => {
      const { config, write } = await createLintVault();
      const malformedReport = Buffer.from(content);
      const reportPath = await write("reports/lint.md", malformedReport);
      await expect(lintMemoryWikiVault(config)).rejects.toMatchObject(error);
      await expect(fs.readFile(reportPath)).resolves.toEqual(malformedReport);
    },
  );
});
