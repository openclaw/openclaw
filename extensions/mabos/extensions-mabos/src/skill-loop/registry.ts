import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillEntry, SkillManifest } from "./types.js";

export class SkillRegistry {
  private skills = new Map<string, SkillEntry>();
  private paths: string[];

  constructor(skillPaths: string[]) {
    this.paths = skillPaths;
  }

  async scan(): Promise<void> {
    this.skills.clear();
    for (const basePath of this.paths) {
      try {
        const entries = await readdir(basePath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillDir = join(basePath, entry.name);
          try {
            const skillMdPath = join(skillDir, "SKILL.md");
            const manifestPath = join(skillDir, "manifest.json");

            const content = await readFile(skillMdPath, "utf-8").catch(() => "");
            if (!content) continue;

            let manifest: SkillManifest;
            try {
              manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
            } catch {
              manifest = {
                name: entry.name,
                version: "0.0.0",
                description: content.slice(0, 200),
                author: "unknown",
                tags: [],
                createdAt: new Date().toISOString(),
              };
            }

            this.skills.set(entry.name, { name: entry.name, path: skillDir, manifest, content });
          } catch {
            // Skip unreadable skills
          }
        }
      } catch {
        // Skip unreadable paths
      }
    }
  }

  list(): SkillEntry[] {
    return Array.from(this.skills.values());
  }

  get(name: string): SkillEntry | undefined {
    return this.skills.get(name);
  }

  search(query: string): SkillEntry[] {
    const lower = query.toLowerCase();
    return this.list().filter(
      (skill) =>
        skill.name.toLowerCase().includes(lower) ||
        skill.manifest.description.toLowerCase().includes(lower) ||
        skill.manifest.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  searchByContext(params: {
    taskDescription?: string;
    agentRole?: string;
    recentTools?: string[];
    limit?: number;
  }): SkillEntry[] {
    let results = this.list();

    if (params.agentRole) {
      const roleMatches = results.filter(
        (s) =>
          !s.manifest.applicableRoles?.length ||
          s.manifest.applicableRoles.includes(params.agentRole!),
      );
      if (roleMatches.length > 0) results = roleMatches;
    }

    if (params.taskDescription) {
      const desc = params.taskDescription.toLowerCase();
      results = results.filter(
        (s) =>
          s.manifest.tags.some((t) => desc.includes(t.toLowerCase())) ||
          s.manifest.description
            .toLowerCase()
            .split(/\s+/)
            .some((w) => desc.includes(w) && w.length > 4),
      );
    }

    return results.slice(0, params.limit ?? 5);
  }

  addSkill(entry: SkillEntry): void {
    this.skills.set(entry.name, entry);
  }
}
