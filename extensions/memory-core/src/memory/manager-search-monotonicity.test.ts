// Memory Core tests cover stable ranked prefixes and caller result limits.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory search result limits", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const neutral =
    "amber birch cedar delta elm fern grove hazel iris jade kelp linen maple north oak";

  async function writeNote(name: string, text: string) {
    await fs.writeFile(path.join(fixture.paths.memory, `${name}.md`), text);
  }

  async function removeDefaultNote() {
    await fs.rm(path.join(fixture.paths.memory, "2026-01-12.md"));
  }

  it.each([
    { name: "ordinary", activeProjectKeys: undefined },
    { name: "project-aware", activeProjectKeys: ["pool-project"] },
  ])(
    "returns stable prefixes and exact partial counts for $name searches",
    async ({ activeProjectKeys }) => {
      await removeDefaultNote();
      // The shared fake embeds alpha/beta substrings. Alphabet supplies semantic
      // similarity without the whole-word alpha match used by FTS.
      for (let index = 0; index < 16; index++) {
        await writeNote(
          `vector-${index}`,
          `${"alphabet ".repeat(9)}${"betamax ".repeat(4)}${neutral}`,
        );
        await writeNote(`keyword-${index}`, `${"alpha ".repeat(30)}${"beta ".repeat(40)}`);
      }
      await writeNote("fused-winner", `alpha alpha alpha beta beta ${neutral}`);
      for (let index = 0; index < 220; index++) {
        await writeNote(`fill-${index}`, `alpha beta ${neutral} filler${index}`);
      }
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ vectorEnabled: true, minScore: 0.35 }),
      );
      await manager.sync({ reason: "test" });
      const wide = await manager.search("alpha", { maxResults: 200, activeProjectKeys });
      expect(wide).toHaveLength(200);
      expect(wide[0]?.path).toBe("memory/fused-winner.md");

      for (const maxResults of [1, 2, 6, 10, 20, 200]) {
        const partials: Array<Awaited<ReturnType<typeof manager.search>> | null> = [];
        const results = await manager.search("alpha", {
          maxResults,
          activeProjectKeys,
          onPartialResults: (rows) => partials.push(rows),
        });
        expect(results).toEqual(wide.slice(0, maxResults));
        expect(partials).toHaveLength(1);
        expect(partials[0]).toHaveLength(maxResults);
      }
    },
  );

  it("preserves ordinary results above 200, lexical eligibility, and the project selection cap", async () => {
    await removeDefaultNote();
    for (let index = 0; index < 200; index++) {
      await writeNote(
        `vector-${index}`,
        `${"alphabet ".repeat(9)}${"betamax ".repeat(4)}${neutral}`,
      );
      await writeNote(`keyword-${index}`, `alpha ${"beta ".repeat(100)}`);
    }
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ vectorEnabled: true, minScore: 0.35 }),
    );
    await manager.sync({ reason: "test" });
    const ordinary = await manager.search("alpha", { maxResults: 250 });
    expect(ordinary).toHaveLength(250);
    expect(ordinary.filter((row) => row.path.startsWith("memory/vector-"))).toHaveLength(200);
    const lexical = ordinary.filter((row) => row.path.startsWith("memory/keyword-"));
    expect(lexical).toHaveLength(50);
    expect(lexical.every((row) => row.score < 0.35)).toBe(true);

    const project = await manager.search("alpha", {
      maxResults: 250,
      activeProjectKeys: ["pool-project"],
    });
    expect(project).toHaveLength(200);
    expect(project).toEqual(ordinary.slice(0, 200));
  });
});
