/**
 * Skill marketplace — browse, search, and install skills from external sources
 * (GitHub repositories, ClawHub registry, local directories).
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillLoopConfig, SkillManifest } from "./types.js";

export interface MarketplaceSource {
  name: string;
  type: "github" | "clawhub" | "local";
  url?: string;
}

export interface MarketplaceSkill {
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  source: string;
  installUrl: string;
}

export class SkillMarketplace {
  private sources: MarketplaceSource[];

  constructor(config?: SkillLoopConfig["marketplace"]) {
    this.sources = config?.sources ?? [];
  }

  /**
   * Search across all configured marketplace sources.
   */
  async search(query: string): Promise<MarketplaceSkill[]> {
    const results: MarketplaceSkill[] = [];

    for (const source of this.sources) {
      try {
        const sourceResults = await this.searchSource(source, query);
        results.push(...sourceResults);
      } catch {
        // Graceful degradation: skip unavailable sources
      }
    }

    return results;
  }

  /**
   * Install a skill from a marketplace source into the local skill directory.
   */
  async install(
    skill: MarketplaceSkill,
    targetDir: string,
  ): Promise<{ path: string; manifest: SkillManifest }> {
    const skillDir = join(targetDir, skill.name);
    await mkdir(skillDir, { recursive: true });

    if (skill.source === "github") {
      return this.installFromGithub(skill, skillDir);
    }

    if (skill.source === "clawhub") {
      return this.installFromClawhub(skill, skillDir);
    }

    throw new Error(`Unsupported marketplace source: ${skill.source}`);
  }

  private async searchSource(
    source: MarketplaceSource,
    query: string,
  ): Promise<MarketplaceSkill[]> {
    switch (source.type) {
      case "github":
        return this.searchGithub(source, query);
      case "clawhub":
        return this.searchClawhub(source, query);
      case "local":
        return []; // Local sources are already indexed by SkillRegistry
      default:
        return [];
    }
  }

  /**
   * Search GitHub for skill repositories matching the query.
   * Uses `gh` CLI for API access (avoids needing a token in env).
   */
  private async searchGithub(
    source: MarketplaceSource,
    query: string,
  ): Promise<MarketplaceSkill[]> {
    const searchQuery = `${query} topic:mabos-skill topic:openclaw-skill`;
    return new Promise((resolve) => {
      execFile(
        "gh",
        [
          "search",
          "repos",
          "--match",
          "name,description",
          "--json",
          "name,description,fullName,url",
          "--limit",
          "10",
          "--",
          searchQuery,
        ],
        { timeout: 15_000 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve([]);
            return;
          }
          try {
            const repos = JSON.parse(stdout) as Array<{
              name: string;
              description: string;
              fullName: string;
              url: string;
            }>;
            resolve(
              repos.map((r) => ({
                name: r.name,
                version: "latest",
                description: r.description || "",
                author: r.fullName.split("/")[0] ?? "",
                tags: [],
                source: "github",
                installUrl: r.url,
              })),
            );
          } catch {
            resolve([]);
          }
        },
      );
    });
  }

  /**
   * Search ClawHub registry for skills.
   * ClawHub API: GET /api/skills/search?q=<query>
   */
  private async searchClawhub(
    source: MarketplaceSource,
    query: string,
  ): Promise<MarketplaceSkill[]> {
    const baseUrl = source.url ?? "https://clawhub.openclaw.ai";
    try {
      const resp = await fetch(
        `${baseUrl}/api/skills/search?q=${encodeURIComponent(query)}&limit=10`,
      );
      if (!resp.ok) return [];
      const data = (await resp.json()) as { skills?: MarketplaceSkill[] };
      return (data.skills ?? []).map((s) => ({ ...s, source: "clawhub" }));
    } catch {
      return [];
    }
  }

  /**
   * Install a skill from GitHub by cloning the repository.
   */
  private async installFromGithub(
    skill: MarketplaceSkill,
    skillDir: string,
  ): Promise<{ path: string; manifest: SkillManifest }> {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        ["clone", "--depth", "1", skill.installUrl, skillDir],
        { timeout: 60_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    const manifest = JSON.parse(
      await readFile(join(skillDir, "manifest.json"), "utf-8"),
    ) as SkillManifest;

    return { path: skillDir, manifest };
  }

  /**
   * Install a skill from ClawHub by downloading the skill package.
   */
  private async installFromClawhub(
    skill: MarketplaceSkill,
    skillDir: string,
  ): Promise<{ path: string; manifest: SkillManifest }> {
    const resp = await fetch(skill.installUrl);
    if (!resp.ok) throw new Error(`Failed to download skill: ${resp.statusText}`);

    const data = (await resp.json()) as {
      manifest: SkillManifest;
      skillMd: string;
    };

    await writeFile(join(skillDir, "manifest.json"), JSON.stringify(data.manifest, null, 2));
    await writeFile(join(skillDir, "SKILL.md"), data.skillMd);

    return { path: skillDir, manifest: data.manifest };
  }
}
