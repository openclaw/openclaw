// Memory Wiki tests cover the related-pages block index used by compile.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import * as markdown from "./markdown.js";
import {
  renderWikiMarkdown,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

type PageSpec = {
  path: string;
  id?: string;
  title: string;
  pageType: string;
  sourceIds?: string[];
  links?: string[];
};

async function writePages(rootDir: string, pages: PageSpec[]) {
  for (const page of pages) {
    const target = path.join(rootDir, page.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      renderWikiMarkdown({
        frontmatter: {
          pageType: page.pageType,
          ...(page.id ? { id: page.id } : {}),
          title: page.title,
          ...(page.sourceIds ? { sourceIds: page.sourceIds } : {}),
        },
        body: `# ${page.title}\n\n${(page.links ?? []).map((link) => `See [[${link}]].`).join("\n")}\n`,
      }),
    );
  }
}

async function readRelatedBlock(rootDir: string, relativePath: string): Promise<string> {
  const raw = await fs.readFile(path.join(rootDir, relativePath), "utf8");
  const start = raw.indexOf(WIKI_RELATED_START_MARKER);
  const end = raw.indexOf(WIKI_RELATED_END_MARKER);
  return raw.slice(start + WIKI_RELATED_START_MARKER.length, end).trim();
}

describe("compile related blocks", () => {
  it("resolves sources, references and related pages from the vault-wide index", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      config: { vault: { renderMode: "obsidian" } },
    });
    const hubPages: PageSpec[] = Array.from({ length: 26 }, (_, index) => ({
      path: `concepts/hub-user-${String(index).padStart(2, "0")}.md`,
      id: `concept.hub-user-${index}`,
      title: `Hub User ${String(index).padStart(2, "0")}`,
      pageType: "concept",
      sourceIds: ["source.hub", ...(index === 0 ? ["source.beta"] : [])],
    }));
    // Exactly 24 other pages share this source: the last count that still relates them.
    const edgePages: PageSpec[] = Array.from({ length: 25 }, (_, index) => ({
      path: `concepts/edge-${String(index).padStart(2, "0")}.md`,
      id: `concept.edge-${index}`,
      title: `Edge ${String(index).padStart(2, "0")}`,
      pageType: "concept",
      sourceIds: ["source.edge"],
    }));
    await writePages(rootDir, [
      { path: "sources/alpha.md", id: "source.alpha", title: "Alpha", pageType: "source" },
      { path: "sources/beta.md", id: "source.beta", title: "Beta", pageType: "source" },
      { path: "sources/hub.md", id: "source.hub", title: "Hub", pageType: "source" },
      {
        path: "concepts/one.md",
        id: "concept.one",
        title: "Concept One",
        pageType: "concept",
        sourceIds: ["source.alpha"],
        links: ["concepts/two"],
      },
      {
        path: "concepts/two.md",
        id: "concept.two",
        title: "Concept Two",
        pageType: "concept",
        sourceIds: ["source.alpha", "source.alpha", "source.beta"],
      },
      {
        path: "entities/ent.md",
        id: "entity.ent",
        title: "Entity",
        pageType: "entity",
        sourceIds: ["source.beta"],
        links: ["Concept One"],
      },
      {
        path: "syntheses/synth.md",
        id: "synthesis.synth",
        title: "Synth",
        pageType: "synthesis",
        sourceIds: ["source.alpha", "concept.one"],
      },
      {
        path: "concepts/dup-a.md",
        id: "concept.dup",
        title: "Dup A",
        pageType: "concept",
        links: ["concepts/lonely"],
      },
      {
        path: "concepts/dup-b.md",
        id: "concept.dup",
        title: "Dup B",
        pageType: "concept",
        links: ["concepts/dup-a", "concepts/lonely"],
      },
      { path: "concepts/lonely.md", id: "concept.lonely", title: "Lonely", pageType: "concept" },
      ...hubPages,
      ...edgePages,
    ]);

    await compileMemoryWikiVault(config);

    const blocks = Object.fromEntries(
      await Promise.all(
        [
          "sources/alpha.md",
          "concepts/one.md",
          "concepts/two.md",
          "entities/ent.md",
          "syntheses/synth.md",
          "concepts/dup-a.md",
          "concepts/lonely.md",
          "sources/hub.md",
          "concepts/hub-user-00.md",
          "concepts/hub-user-01.md",
          "concepts/edge-00.md",
        ].map(async (page) => [page, await readRelatedBlock(rootDir, page)] as const),
      ),
    );
    expect(blocks).toEqual(EXPECTED_BLOCKS);
  });

  it("builds related blocks from indexes instead of rescanning every page per page", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      config: { vault: { renderMode: "obsidian" } },
    });
    const pageCount = 120;
    const sourceCount = 36;
    const specs: PageSpec[] = [];
    for (let index = 0; index < sourceCount; index++) {
      specs.push({
        path: `sources/s${index}.md`,
        id: `source.s${index}`,
        title: `Source ${index}`,
        pageType: "source",
      });
    }
    for (let index = 0; index < pageCount - sourceCount; index++) {
      // Skewed picks make the first few sources hubs past the fanout cap.
      const pick = (salt: number) =>
        Math.floor(((index * 31 + salt * 17) % 97) ** 2 / 97) % sourceCount;
      specs.push({
        path: `concepts/p${index}.md`,
        id: `concept.p${index}`,
        title: `Page ${index}`,
        pageType: "concept",
        sourceIds: [...new Set([`source.s${pick(1)}`, `source.s${pick(2)}`])],
        links: [`concepts/p${(index * 7 + 3) % (pageCount - sourceCount)}`],
      });
    }
    await writePages(rootDir, specs);

    // Count how often compile touches each page's relation lists; a per-page rescan of
    // the whole vault shows up as quadratic growth here, independent of timing.
    let relationReads = 0;
    const scan = markdown.scanWikiPageSummary;
    vi.spyOn(markdown, "scanWikiPageSummary").mockImplementation((params) => {
      const result = scan(params);
      if (result.status === "valid") {
        for (const key of ["sourceIds", "linkTargets"] as const) {
          const value = result.page[key];
          Object.defineProperty(result.page, key, {
            configurable: true,
            enumerable: true,
            get() {
              relationReads++;
              return value;
            },
          });
        }
      }
      return result;
    });

    await compileMemoryWikiVault(config);

    expect(relationReads).toBeLessThan(pageCount * 20);

    const digest = createHash("sha256");
    for (const spec of specs) {
      digest
        .update(spec.path)
        .update("\0")
        .update(await readRelatedBlock(rootDir, spec.path));
    }
    expect(digest.digest("hex")).toBe(EXPECTED_RELATED_DIGEST);
  });
});

const EXPECTED_BLOCKS: Record<string, string> = {
  "sources/alpha.md":
    "### Referenced By\n\n- [[concepts/one|Concept One]]\n- [[concepts/two|Concept Two]]\n- [[syntheses/synth|Synth]]",
  "concepts/one.md":
    "### Sources\n\n- [[sources/alpha|Alpha]]\n\n### Referenced By\n\n- [[entities/ent|Entity]]\n- [[syntheses/synth|Synth]]\n\n### Related Pages\n\n- [[concepts/two|Concept Two]]",
  "concepts/two.md":
    "### Sources\n\n- [[sources/alpha|Alpha]]\n- [[sources/beta|Beta]]\n\n### Referenced By\n\n- [[concepts/one|Concept One]]\n\n### Related Pages\n\n- [[entities/ent|Entity]]\n- [[concepts/hub-user-00|Hub User 00]]\n- [[syntheses/synth|Synth]]",
  "entities/ent.md":
    "### Sources\n\n- [[sources/beta|Beta]]\n\n### Related Pages\n\n- [[concepts/two|Concept Two]]\n- [[concepts/hub-user-00|Hub User 00]]",
  "syntheses/synth.md":
    "### Sources\n\n- [[sources/alpha|Alpha]]\n- [[concepts/one|Concept One]]\n\n### Related Pages\n\n- [[concepts/two|Concept Two]]",
  "concepts/dup-a.md": "### Referenced By\n\n- [[concepts/dup-b|Dup B]]",
  "concepts/lonely.md": "### Referenced By\n\n- [[concepts/dup-a|Dup A]]",
  "sources/hub.md": "- No related pages yet.",
  "concepts/hub-user-00.md":
    "### Sources\n\n- [[sources/hub|Hub]]\n- [[sources/beta|Beta]]\n\n### Related Pages\n\n- [[concepts/two|Concept Two]]\n- [[entities/ent|Entity]]",
  "concepts/hub-user-01.md": "### Sources\n\n- [[sources/hub|Hub]]",
  "concepts/edge-00.md":
    "### Related Pages\n\n- [[concepts/edge-01|Edge 01]]\n- [[concepts/edge-02|Edge 02]]\n- [[concepts/edge-03|Edge 03]]\n- [[concepts/edge-04|Edge 04]]\n- [[concepts/edge-05|Edge 05]]\n- [[concepts/edge-06|Edge 06]]\n- [[concepts/edge-07|Edge 07]]\n- [[concepts/edge-08|Edge 08]]\n- [[concepts/edge-09|Edge 09]]\n- [[concepts/edge-10|Edge 10]]\n- [[concepts/edge-11|Edge 11]]\n- [[concepts/edge-12|Edge 12]]",
};
// Digest of every related block, captured from the pre-index implementation so the
// index must reproduce the same bytes.
const EXPECTED_RELATED_DIGEST = "a7a043ff49c0b48d9ebfbcf6d590eacf790ba419ea40278b8eeda52a08ef6732";
