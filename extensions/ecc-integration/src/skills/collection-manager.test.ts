import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CURATED_COLLECTIONS,
  type SkillCollection,
  SkillCollectionManager,
} from "./collection-manager.js";

describe("SkillCollectionManager", () => {
  it("parses github URLs including .git suffix", () => {
    const manager = new SkillCollectionManager();
    const parsed = (manager as any).parseGitHubUrl("https://github.com/acme/repo.git");
    expect(parsed).toEqual({ owner: "acme", repo: "repo", path: undefined });
  });

  it("rejects paths escaping install root", () => {
    const manager = new SkillCollectionManager();
    expect(() => (manager as any).resolveWithinRoot("/tmp/root", "../escape")).toThrow(
      "Path escapes root",
    );
  });

  it("parses repository links from curated README", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `
- [One](https://github.com/org-one/repo-one)
- [Two](https://github.com/org-two/repo-two.git)
- [Issue](https://github.com/org-three/repo-three/issues/1)
`,
    });
    const manager = new SkillCollectionManager({ fetchImpl: fetchMock as unknown as typeof fetch });
    const collection: SkillCollection = { ...CURATED_COLLECTIONS[0], skills: [] };
    await (manager as any).fetchCollectionSkills(collection);

    expect(collection.skills.map((s) => s.repository)).toEqual([
      "https://github.com/org-one/repo-one",
      "https://github.com/org-two/repo-two",
      "https://github.com/org-three/repo-three",
    ]);
  });

  it("falls back to recommended source when README fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const manager = new SkillCollectionManager({ fetchImpl: fetchMock as unknown as typeof fetch });
    const collection: SkillCollection = { ...CURATED_COLLECTIONS[0], skills: [] };
    await (manager as any).fetchCollectionSkills(collection);
    expect(collection.skills.length).toBeGreaterThan(0);
    expect(
      collection.skills.some((skill) =>
        skill.repository.includes("VoltAgent/awesome-openclaw-skills"),
      ),
    ).toBe(true);
  });

  it("installs a skill directory into configured installPath", async () => {
    const installRoot = await mkdtemp(join(tmpdir(), "ecc-install-root-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "ecc-install-src-"));
    await mkdir(join(sourceRoot, "subdir"), { recursive: true });
    await writeFile(join(sourceRoot, "subdir", "skill.txt"), "ok", "utf8");

    const manager = new SkillCollectionManager({ installPath: installRoot });
    const result = await (manager as any).installSkill(sourceRoot, "my custom skill");
    const copied = await readFile(join(result.path, "subdir", "skill.txt"), "utf8");

    expect(copied).toBe("ok");
    expect(result.path.includes("my-custom-skill")).toBe(true);
  });
});
