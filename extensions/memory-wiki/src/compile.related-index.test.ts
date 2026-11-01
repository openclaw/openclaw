import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import * as markdown from "./markdown.js";
import { WIKI_RELATED_END_MARKER, WIKI_RELATED_START_MARKER } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

type PageSpec = [file: string, id: string, title: string, sourceIds?: string[], links?: string[]];

async function writePages(vault: Awaited<ReturnType<typeof createVault>>, pages: PageSpec[]) {
  for (const [file, id, title, sourceIds, links = []] of pages) {
    await vault.page(
      file,
      { pageType: id.slice(0, id.indexOf(".")), id, title, ...(sourceIds ? { sourceIds } : {}) },
      `# ${title}\n\n${links.map((link) => `See [[${link}]].`).join("\n")}\n`,
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
    const vault = await createVault({
      initialize: true,
      config: { vault: { renderMode: "obsidian" } },
    });
    const { rootDir, config } = vault;
    const hubPages: PageSpec[] = Array.from({ length: 26 }, (_, index): PageSpec => [
      `concepts/hub-user-${String(index).padStart(2, "0")}.md`,
      `concept.hub-user-${index}`,
      `Hub User ${String(index).padStart(2, "0")}`,
      ["source.hub", ...(index === 0 ? ["source.beta"] : [])],
    ]);
    // Exactly 24 other pages share this source: the last count that still relates them.
    const edgePages: PageSpec[] = Array.from({ length: 25 }, (_, index): PageSpec => [
      `concepts/edge-${String(index).padStart(2, "0")}.md`,
      `concept.edge-${index}`,
      `Edge ${String(index).padStart(2, "0")}`,
      ["source.edge"],
    ]);
    await writePages(vault, [
      ["sources/alpha.md", "source.alpha", "Alpha"],
      ["sources/beta.md", "source.beta", "Beta"],
      ["sources/hub.md", "source.hub", "Hub"],
      [
        "concepts/one.md",
        "concept.one",
        "Concept One",
        ["source.alpha"],
        ["concepts/two#Heading|Display", "two#^block"],
      ],
      [
        "concepts/two.md",
        "concept.two",
        "Concept Two",
        ["source.alpha", "source.alpha", "source.beta"],
      ],
      ["entities/ent.md", "entity.ent", "Entity", ["source.beta"], ["Concept One"]],
      ["syntheses/synth.md", "synthesis.synth", "Synth", ["source.alpha", "concept.one"]],
      ["concepts/dup-a.md", "concept.dup", "Dup A", [], ["concepts/lonely"]],
      ["concepts/dup-b.md", "concept.dup", "Dup B", [], ["concepts/dup-a", "concepts/lonely"]],
      ["concepts/lonely.md", "concept.lonely", "Lonely"],
      ...hubPages,
      ...edgePages,
    ]);

    // Bound relation-list reads independently of wall-clock timing.
    let relationReads = 0;
    const scan = markdown.scanWikiPageSummary;
    vi.spyOn(markdown, "scanWikiPageSummary").mockImplementation((params) => {
      const result = scan(params);
      if (result.status === "valid") {
        result.page = new Proxy(result.page, {
          get(target, key, receiver) {
            if (key === "sourceIds" || key === "linkTargets") {
              relationReads++;
            }
            return Reflect.get(target, key, receiver);
          },
        });
      }
      return result;
    });

    await compileMemoryWikiVault(config);
    expect(relationReads).toBeLessThan((10 + hubPages.length + edgePages.length) * 20);
    const blocks = Object.fromEntries(
      await Promise.all(
        Object.keys(EXPECTED_BLOCKS).map(
          async (page) => [page, await readRelatedBlock(rootDir, page)] as const,
        ),
      ),
    );
    expect(blocks).toEqual(EXPECTED_BLOCKS);
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
