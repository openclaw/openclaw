// [NEW FILE] src/agents/prompt-engine/skills-loader.ts

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { SkillCategory, SkillDefinition, SkillLibrary } from "./types.js";

// Path to the skills database (dist: dist/agents/prompt-engine/data/skills.json)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_PATH = path.join(__dirname, "data", "skills.json");

/** When running from repo, source path if dist was wiped (e.g. git clean, failed build). */
function getSourceSkillsPath(): string {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  return path.join(repoRoot, "src", "agents", "prompt-engine", "data", "skills.json");
}

export class SkillsLoader {
  private static cache: SkillLibrary | null = null;

  /**
   * Loads the skills.json file and caches it in memory.
   * Tries dist path first; on ENOENT falls back to source path (repo layout).
   */
  static async loadLibrary(): Promise<SkillLibrary> {
    if (this.cache) {
      return this.cache;
    }

    const paths = [SKILLS_PATH, getSourceSkillsPath()];
    for (const p of paths) {
      try {
        const rawData = await fs.readFile(p, "utf-8");
        this.cache = JSON.parse(rawData) as SkillLibrary;
        if (p !== SKILLS_PATH) {
          console.warn("[PromptEngine] Loaded skills from source path (dist copy missing):", p);
        }
        return this.cache;
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? (err as NodeJS.ErrnoException).code
            : undefined;
        if (code === "ENOENT") {
          continue;
        }
        console.error("[PromptEngine] Failed to load skills library:", err);
        return {};
      }
    }
    console.error("[PromptEngine] skills.json not found in dist or source path");
    return {};
  }

  /**
   * Deep search for a skill by its name across all categories and sub-categories.
   */
  static findSkill(library: SkillLibrary, skillName: string): SkillDefinition | null {
    for (const key in library) {
      const section = library[key];

      // Check top-level skills in section
      if (section.skills) {
        const found = section.skills.find((s) => s.skill_name === skillName);
        if (found) {
          return found;
        }
      }

      // Check nested categories
      if (section.categories) {
        const foundInNested = this.findInCategories(section.categories, skillName);
        if (foundInNested) {
          return foundInNested;
        }
      }
    }
    return null;
  }

  private static findInCategories(
    categories: SkillCategory[],
    skillName: string,
  ): SkillDefinition | null {
    for (const category of categories) {
      const found = category.skills.find((s) => s.skill_name === skillName);
      if (found) {
        return found;
      }
    }
    return null;
  }
}
