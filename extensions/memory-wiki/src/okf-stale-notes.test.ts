import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { HUMAN_END_MARKER, HUMAN_START_MARKER, renderWikiMarkdown } from "./markdown.js";
import { importMemoryWikiOkfBundle } from "./okf.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

it.each(["local-notes", "producer-example", "broken-marker", "invalid-utf8"] as const)(
  "protects local content when an OKF concept disappears: %s",
  async (scenario) => {
    const rootDir = await createTempDir("memory-wiki-okf-stale-notes-");
    const bundlePath = path.join(rootDir, "bundle");
    await fs.mkdir(bundlePath);
    const note = "Handwritten café 🦞 and trailing spaces.  ";
    await fs.writeFile(
      path.join(bundlePath, "removed.md"),
      renderWikiMarkdown({
        frontmatter: { type: "documentation", title: "Removed" },
        body: `Producer content.\n~~~markdown\n${HUMAN_START_MARKER}\nExample only.\n${HUMAN_END_MARKER}\n~~~`,
      }),
    );
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
    const run = () => importMemoryWikiOkfBundle({ config, bundlePath });
    const first = await run();
    expect(first.importedCount).toBe(1);
    const [pagePath] = first.pagePaths;
    if (!pagePath) {
      throw new Error("Expected the imported concept that will disappear from the bundle");
    }
    const vaultPage = path.join(config.vault.path, pagePath);
    const original = await fs.readFile(vaultPage, "utf8");
    const emptyBlock = `${HUMAN_START_MARKER}\n${HUMAN_END_MARKER}`;
    expect(original).toContain(emptyBlock);
    let edited = Buffer.from(original);
    if (scenario === "local-notes") {
      edited = Buffer.from(
        original.replace(emptyBlock, `${HUMAN_START_MARKER}\n${note}\n${HUMAN_END_MARKER}`),
      );
    } else if (scenario === "broken-marker") {
      edited = Buffer.from(original.replace(emptyBlock, `${HUMAN_START_MARKER}\n${note}`));
    } else if (scenario === "invalid-utf8") {
      edited = Buffer.concat([Buffer.from(original), Buffer.from([0xff])]);
    }
    await fs.writeFile(vaultPage, edited);
    await fs.rm(path.join(bundlePath, "removed.md"));

    if (scenario === "broken-marker" || scenario === "invalid-utf8") {
      await expect(run()).rejects.toThrow(
        scenario === "broken-marker" ? "human Notes are missing" : "UTF-8",
      );
      await expect(fs.readFile(vaultPage)).resolves.toEqual(edited);
    } else {
      const second = await run();
      expect(second.importedCount).toBe(0);
      if (scenario === "local-notes") {
        await expect(fs.readFile(vaultPage, "utf8")).resolves.toContain(note);
        expect(second.removedPagePaths).toEqual([]);
      } else {
        expect(second.removedPagePaths).toEqual([pagePath]);
        await expect(fs.stat(vaultPage)).rejects.toThrow();
      }
    }
  },
);
