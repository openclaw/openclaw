/**
 * Skill Collection Manager
 *
 * Safely imports and manages skill collections from curated repositories.
 * All skills are audited before installation to prevent malicious code injection.
 *
 * Supported Collections:
 * - awesome-openclaw-skills (curated list)
 * - Individual GitHub repositories
 * - Git submodules
 *
 * Security: Mandatory audit gate for all imports
 */

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { SkillAuditor, SafeSkillImporter, SkillAuditResult } from "../security/skill-auditor.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Curated Skill Collections
// ============================================================================

export interface SkillCollection {
  name: string;
  description: string;
  url: string;
  owner: string;
  repo: string;
  path?: string;
  category: "official" | "community" | "verified" | "experimental";
  trustLevel: "high" | "medium" | "low";
  skills: CuratedSkill[];
}

export interface CuratedSkill {
  name: string;
  description: string;
  repository: string;
  author: string;
  category: string;
  verified: boolean;
  installCount: number;
  lastAudit?: Date;
  auditStatus?: "passed" | "failed" | "pending";
}

// Pre-vetted collections from user request
export const CURATED_COLLECTIONS: SkillCollection[] = [
  {
    name: "awesome-openclaw-skills",
    description: "Curated list of excellent OpenClaw skills",
    url: "https://github.com/VoltAgent/awesome-openclaw-skills",
    owner: "VoltAgent",
    repo: "awesome-openclaw-skills",
    category: "community",
    trustLevel: "medium",
    skills: [], // Populated dynamically
  },
];

// Individual repositories to import
export const RECOMMENDED_SKILLS: CuratedSkill[] = [
  {
    name: "get-shit-done",
    description: "Action-oriented productivity and execution skills",
    repository: "https://github.com/gsd-build/get-shit-done.git",
    author: "gsd-build",
    category: "productivity",
    verified: false,
    installCount: 0,
  },
  {
    name: "antigravity-awesome-skills",
    description: "Community curated awesome skills collection",
    repository: "https://github.com/sickn33/antigravity-awesome-skills.git",
    author: "sickn33",
    category: "community",
    verified: false,
    installCount: 0,
  },
  {
    name: "awesome-openclaw-skills",
    description: "Curated OpenClaw skills index",
    repository: "https://github.com/VoltAgent/awesome-openclaw-skills.git",
    author: "VoltAgent",
    category: "community",
    verified: false,
    installCount: 0,
  },
  {
    name: "claude-context-mode",
    description: "Context mode management for Claude Code",
    repository: "https://github.com/mksglu/claude-context-mode",
    author: "mksglu",
    category: "context-management",
    verified: false,
    installCount: 0,
  },
  {
    name: "qmd",
    description: "Query markdown processor",
    repository: "https://github.com/tobi/qmd",
    author: "tobi",
    category: "markdown",
    verified: false,
    installCount: 0,
  },
  {
    name: "agent-skill-creator",
    description: "Create skills from code patterns",
    repository: "https://github.com/FrancyJGLisboa/agent-skill-creator",
    author: "FrancyJGLisboa",
    category: "development",
    verified: false,
    installCount: 0,
  },
  {
    name: "SkillForge",
    description: "Advanced skill development framework",
    repository: "https://github.com/tripleyak/SkillForge",
    author: "tripleyak",
    category: "framework",
    verified: false,
    installCount: 0,
  },
];

// ============================================================================
// Skill Collection Manager
// ============================================================================

export class SkillCollectionManager {
  private auditor: SkillAuditor;
  private importer: SafeSkillImporter;
  private installedSkills: Map<string, CuratedSkill>;
  private auditCache: Map<string, SkillAuditResult>;
  private installPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly runGitImpl: (args: string[], cwd?: string) => Promise<void>;

  constructor(options?: {
    auditor?: SkillAuditor;
    importer?: SafeSkillImporter;
    installPath?: string;
    fetchImpl?: typeof fetch;
    runGitImpl?: (args: string[], cwd?: string) => Promise<void>;
  }) {
    this.auditor = options?.auditor || new SkillAuditor();
    this.importer = options?.importer || new SafeSkillImporter(this.auditor);
    this.installedSkills = new Map();
    this.auditCache = new Map();
    this.installPath = options?.installPath || "./skills";
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.runGitImpl = options?.runGitImpl ?? this.runGit.bind(this);
  }

  /**
   * Browse available skill collections
   */
  async browseCollections(): Promise<SkillCollection[]> {
    console.log(`📚 Available Skill Collections`);
    console.log(`===============================\n`);

    for (const collection of CURATED_COLLECTIONS) {
      console.log(`📦 ${collection.name}`);
      console.log(`   ${collection.description}`);
      console.log(`   URL: ${collection.url}`);
      console.log(`   Trust: ${collection.trustLevel}`);
      console.log(`   Skills: ${collection.skills.length}\n`);
    }

    return CURATED_COLLECTIONS;
  }

  /**
   * Browse recommended individual skills
   */
  async browseRecommended(): Promise<CuratedSkill[]> {
    console.log(`⭐ Recommended Skills`);
    console.log(`=====================\n`);

    for (const skill of RECOMMENDED_SKILLS) {
      const status = skill.verified ? "✅ Verified" : "⏳ Pending Audit";
      console.log(`🔧 ${skill.name}`);
      console.log(`   ${skill.description}`);
      console.log(`   By: ${skill.author} | Category: ${skill.category}`);
      console.log(`   Status: ${status}`);
      console.log(`   Repo: ${skill.repository}\n`);
    }

    return RECOMMENDED_SKILLS;
  }

  /**
   * Import a skill from GitHub with full audit
   */
  async importFromGitHub(
    repositoryUrl: string,
    options: {
      branch?: string;
      subPath?: string;
      skipCache?: boolean;
      allowMedium?: boolean;
    } = {},
  ): Promise<SkillImportResult> {
    console.log(`\n🔽 Importing from GitHub: ${repositoryUrl}`);

    // Parse GitHub URL
    const parsed = this.parseGitHubUrl(repositoryUrl);
    if (!parsed) {
      return {
        success: false,
        skillName: "unknown",
        error: "Invalid GitHub URL format",
        auditResult: null,
      };
    }

    const { owner, repo, path } = parsed;

    // Check cache first
    const cacheKey = `${owner}/${repo}/${path || ""}`;
    if (!options.skipCache && this.auditCache.has(cacheKey)) {
      const cached = this.auditCache.get(cacheKey)!;
      console.log(`📋 Using cached audit result`);
      return {
        success: cached.passed,
        skillName: cached.skillName,
        auditResult: cached,
      };
    }

    // Download and audit
    try {
      // Step 1: Download to temp location
      const tempPath = await this.downloadFromGitHub(owner, repo, path, options.branch);
      console.log(`📥 Downloaded to: ${tempPath}`);

      // Step 2: MANDATORY audit (never skip)
      console.log(`🔍 Running security audit...`);
      const audit = await this.auditor.auditSkill(tempPath);
      this.auditCache.set(cacheKey, audit);

      // Step 3: Check audit results
      if (!audit.passed) {
        console.error(`\n❌ Security audit FAILED - Installation blocked`);
        console.error(`   Critical: ${audit.criticalCount}`);
        console.error(`   High: ${audit.highCount}`);

        // Report specific issues
        const criticalFindings = audit.findings.filter(
          (f: { severity: string }) => f.severity === "critical",
        );
        for (const finding of criticalFindings) {
          console.error(`\n   🚨 ${finding.id}: ${finding.title}`);
          console.error(`      ${finding.description}`);
        }

        return {
          success: false,
          skillName: audit.skillName,
          error: `Security audit failed: ${audit.criticalCount} critical, ${audit.highCount} high severity issues`,
          auditResult: audit,
        };
      }

      // Step 4: Check medium severity
      if (audit.mediumCount > 0 && !options.allowMedium) {
        console.warn(`\n⚠️  ${audit.mediumCount} medium severity findings detected`);
        console.warn(`   Use --allow-medium to proceed anyway`);
        console.warn(`\n   Medium findings:`);

        const mediumFindings = audit.findings.filter(
          (f: { severity: string }) => f.severity === "medium",
        );
        for (const finding of mediumFindings.slice(0, 5)) {
          console.warn(`   - ${finding.title} (${finding.category})`);
        }

        return {
          success: false,
          skillName: audit.skillName,
          error: `${audit.mediumCount} medium severity findings. Use --allow-medium to proceed.`,
          auditResult: audit,
        };
      }

      // Step 5: Install if passed
      console.log(`\n✅ Security audit PASSED`);
      console.log(`   Installing to: ${this.installPath}/${audit.skillName}`);

      const installResult = await this.installSkill(tempPath, audit.skillName);

      // Update tracking
      const curatedSkill: CuratedSkill = {
        name: audit.skillName,
        description: `Imported from ${owner}/${repo}`,
        repository: repositoryUrl,
        author: owner,
        category: "imported",
        verified: true,
        installCount: 1,
        lastAudit: new Date(),
        auditStatus: "passed",
      };

      this.installedSkills.set(audit.skillName, curatedSkill);

      return {
        success: true,
        skillName: audit.skillName,
        installed: true,
        installPath: installResult.path,
        auditResult: audit,
      };
    } catch (error) {
      console.error(
        `\n❌ Import failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      return {
        success: false,
        skillName: "unknown",
        error: error instanceof Error ? error.message : "Unknown error",
        auditResult: null,
      };
    }
  }

  /**
   * Import entire collection with individual skill audits
   */
  async importCollection(
    collectionName: string,
    options: {
      allowMedium?: boolean;
      parallel?: boolean;
    } = {},
  ): Promise<CollectionImportResult> {
    console.log(`\n📚 Importing Collection: ${collectionName}`);
    console.log(`=====================================\n`);

    const collection = CURATED_COLLECTIONS.find((c) => c.name === collectionName);
    if (!collection) {
      return {
        success: false,
        collectionName,
        totalSkills: 0,
        imported: 0,
        failed: 0,
        results: [],
        error: `Collection '${collectionName}' not found`,
      };
    }

    // Fetch collection skills if not loaded
    if (collection.skills.length === 0) {
      await this.fetchCollectionSkills(collection);
    }

    const results: SkillImportResult[] = [];

    if (options.parallel) {
      // Parallel import with individual audits
      const importPromises = collection.skills.map((skill) =>
        this.importFromGitHub(skill.repository, { allowMedium: options.allowMedium }),
      );

      const settled = await Promise.allSettled(importPromises);

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            skillName: collection.skills[i].name,
            error: result.reason,
            auditResult: null,
          });
        }
      }
    } else {
      // Sequential import (safer, more feedback)
      for (const skill of collection.skills) {
        console.log(`\n--- Importing ${skill.name} ---`);
        const result = await this.importFromGitHub(skill.repository, {
          allowMedium: options.allowMedium,
        });
        results.push(result);
      }
    }

    // Calculate summary
    const imported = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(`\n📊 Collection Import Summary`);
    console.log(`============================`);
    console.log(`Total Skills: ${results.length}`);
    console.log(`✅ Imported: ${imported}`);
    console.log(`❌ Failed: ${failed}`);

    if (failed > 0) {
      console.log(`\nFailed imports:`);
      for (const result of results.filter((r) => !r.success)) {
        console.log(`   - ${result.skillName}: ${result.error}`);
      }
    }

    return {
      success: failed === 0,
      collectionName,
      totalSkills: results.length,
      imported,
      failed,
      results,
    };
  }

  /**
   * Import all recommended skills
   */
  async importRecommended(options?: {
    allowMedium?: boolean;
    parallel?: boolean;
  }): Promise<CollectionImportResult> {
    console.log(`\n⭐ Importing Recommended Skills`);
    console.log(`===============================\n`);

    const results: SkillImportResult[] = [];

    if (options?.parallel) {
      const importPromises = RECOMMENDED_SKILLS.map((skill) =>
        this.importFromGitHub(skill.repository, { allowMedium: options.allowMedium }),
      );

      const settled = await Promise.allSettled(importPromises);

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            skillName: RECOMMENDED_SKILLS[i].name,
            error: result.reason,
            auditResult: null,
          });
        }
      }
    } else {
      for (const skill of RECOMMENDED_SKILLS) {
        const result = await this.importFromGitHub(skill.repository, {
          allowMedium: options?.allowMedium,
        });
        results.push(result);
      }
    }

    const imported = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(`\n📊 Recommended Skills Import Summary`);
    console.log(`====================================`);
    console.log(`Total: ${results.length}`);
    console.log(`✅ Imported: ${imported}`);
    console.log(`❌ Failed: ${failed}`);

    return {
      success: failed === 0,
      collectionName: "recommended-skills",
      totalSkills: results.length,
      imported,
      failed,
      results,
    };
  }

  /**
   * Validate skill before use (re-audit)
   */
  async validateSkill(skillName: string): Promise<SkillAuditResult> {
    const skill = this.installedSkills.get(skillName);
    if (!skill) {
      throw new Error(`Skill '${skillName}' not found`);
    }

    console.log(`🔄 Re-validating: ${skillName}`);

    // Re-audit the skill
    const skillPath = `${this.installPath}/${skillName}`;
    const audit = await this.auditor.auditSkill(skillPath);

    // Update tracking
    skill.lastAudit = new Date();
    skill.auditStatus = audit.passed ? "passed" : "failed";

    return audit;
  }

  /**
   * Get list of installed skills with audit status
   */
  async listInstalled(): Promise<CuratedSkill[]> {
    console.log(`\n📦 Installed Skills`);
    console.log(`===================\n`);

    const skills = Array.from(this.installedSkills.values());

    for (const skill of skills) {
      const statusIcon =
        skill.auditStatus === "passed" ? "✅" : skill.auditStatus === "failed" ? "❌" : "⏳";
      console.log(`${statusIcon} ${skill.name}`);
      console.log(`   ${skill.description}`);
      console.log(`   By: ${skill.author} | Category: ${skill.category}`);
      if (skill.lastAudit) {
        console.log(`   Last Audit: ${skill.lastAudit.toISOString()}`);
      }
      console.log();
    }

    return skills;
  }

  /**
   * Remove installed skill
   */
  async removeSkill(skillName: string): Promise<boolean> {
    console.log(`🗑️  Removing skill: ${skillName}`);

    if (!this.installedSkills.has(skillName)) {
      console.error(`   Skill not found`);
      return false;
    }

    const installRoot = resolve(this.installPath);
    const skillPath = this.resolveWithinRoot(installRoot, skillName);
    await rm(skillPath, { recursive: true, force: true });
    this.installedSkills.delete(skillName);

    console.log(`   ✅ Removed`);
    return true;
  }

  /**
   * Generate audit report for all installed skills
   */
  async generateAuditReport(): Promise<string> {
    const lines: string[] = [
      "# Skill Collection Security Audit Report",
      "",
      `Generated: ${new Date().toISOString()}`,
      `Total Skills: ${this.installedSkills.size}`,
      "",
      "## Installed Skills",
      "",
    ];

    for (const [name, skill] of this.installedSkills) {
      const cacheKey = skill.repository.replace("https://github.com/", "");
      const audit = this.auditCache.get(cacheKey);

      lines.push(`### ${name}`);
      lines.push(`- **Description**: ${skill.description}`);
      lines.push(`- **Source**: ${skill.repository}`);
      lines.push(`- **Author**: ${skill.author}`);
      lines.push(`- **Verified**: ${skill.verified ? "✅ Yes" : "❌ No"}`);

      if (audit) {
        lines.push(`- **Audit Status**: ${audit.passed ? "✅ PASSED" : "❌ FAILED"}`);
        lines.push(
          `- **Findings**: ${audit.criticalCount}C / ${audit.highCount}H / ${audit.mediumCount}M / ${audit.lowCount}L`,
        );
        lines.push("");

        if (audit.findings.length > 0) {
          lines.push("#### Security Findings");
          lines.push("");
          for (const finding of audit.findings) {
            lines.push(`**[${finding.severity.toUpperCase()}]** ${finding.id}: ${finding.title}`);
            lines.push(`- Category: ${finding.category}`);
            lines.push(`- Location: ${finding.file}:${finding.line}`);
            lines.push(`- ${finding.description}`);
            lines.push(`- Remediation: ${finding.remediation}`);
            lines.push("");
          }
        }
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private parseGitHubUrl(url: string): { owner: string; repo: string; path?: string } | null {
    const normalized = url.replace(/\.git$/, "").replace(/\/$/, "");
    // Handle various GitHub URL formats
    const patterns = [
      /github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/[^\/]+\/(.+))?/,
      /github\.com\/([^\/]+)\/([^\/]+)(?:\/blob\/[^\/]+\/(.+))?/,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        return {
          owner: match[1],
          repo: match[2],
          path: match[3],
        };
      }
    }

    return null;
  }

  private async downloadFromGitHub(
    owner: string,
    repo: string,
    path?: string,
    branch: string = "main",
  ): Promise<string> {
    const tempRoot = await mkdtemp(join(tmpdir(), `skill-import-${owner}-${repo}-`));
    const tempPath = join(tempRoot, repo);
    console.log(`   Cloning ${owner}/${repo}...`);
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;

    try {
      await this.runGitImpl(["clone", "--depth", "1", "--branch", branch, cloneUrl, tempPath]);
    } catch (error) {
      if (branch !== "master") {
        await this.runGitImpl(["clone", "--depth", "1", "--branch", "master", cloneUrl, tempPath]);
      } else {
        throw error;
      }
    }

    if (!path) {
      return tempPath;
    }

    const scopedPath = this.resolveWithinRoot(tempPath, path);
    const scopedStats = await stat(scopedPath);
    if (!scopedStats.isDirectory()) {
      throw new Error(`Repository path '${path}' is not a directory`);
    }
    return scopedPath;
  }

  private async fetchCollectionSkills(collection: SkillCollection): Promise<void> {
    console.log(`   Fetching skills from ${collection.name}...`);
    const readmeCandidates = [
      `https://raw.githubusercontent.com/${collection.owner}/${collection.repo}/main/README.md`,
      `https://raw.githubusercontent.com/${collection.owner}/${collection.repo}/master/README.md`,
    ];

    let readme = "";
    for (const readmeUrl of readmeCandidates) {
      try {
        const response = await this.fetchImpl(readmeUrl);
        if (!response.ok) continue;
        readme = await response.text();
        if (readme.trim().length > 0) break;
      } catch {
        // Try next candidate branch.
      }
    }

    if (!readme) {
      collection.skills = RECOMMENDED_SKILLS.filter((skill) =>
        skill.repository.includes(`${collection.owner}/${collection.repo}`),
      );
      return;
    }

    const repoLinks = this.extractGitHubRepositoryLinks(readme);
    const uniqueLinks = [...new Set(repoLinks)];

    collection.skills = uniqueLinks.map((repositoryUrl) => {
      const parsed = this.parseGitHubUrl(repositoryUrl);
      const repoName = parsed?.repo ?? basename(repositoryUrl);
      const author = parsed?.owner ?? "unknown";
      return {
        name: repoName,
        description: `Imported from ${repositoryUrl}`,
        repository: repositoryUrl,
        author,
        category: "community",
        verified: false,
        installCount: 0,
      };
    });
  }

  private async installSkill(tempPath: string, skillName: string): Promise<{ path: string }> {
    const installRoot = resolve(this.installPath);
    await mkdir(installRoot, { recursive: true });
    const safeSkillName = this.normalizeSkillName(skillName);
    const finalPath = this.resolveWithinRoot(installRoot, safeSkillName);
    await rm(finalPath, { recursive: true, force: true });
    await cp(tempPath, finalPath, { recursive: true, force: true });
    return { path: finalPath };
  }

  private async runGit(args: string[], cwd?: string): Promise<void> {
    await execFileAsync("git", args, cwd ? { cwd } : undefined);
  }

  private resolveWithinRoot(root: string, relativeOrAbsolutePath: string): string {
    const rootPath = resolve(root);
    const candidatePath = isAbsolute(relativeOrAbsolutePath)
      ? resolve(relativeOrAbsolutePath)
      : resolve(rootPath, relativeOrAbsolutePath);
    if (candidatePath !== rootPath && !candidatePath.startsWith(`${rootPath}${sep}`)) {
      throw new Error(`Path escapes root: ${relativeOrAbsolutePath}`);
    }
    return candidatePath;
  }

  private normalizeSkillName(skillName: string): string {
    const normalized = skillName
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized || "imported-skill";
  }

  private extractGitHubRepositoryLinks(markdown: string): string[] {
    const links = markdown.match(/\[[^\]]+\]\((https:\/\/github\.com\/[^)\s]+)\)/g) || [];
    const repositories: string[] = [];
    for (const link of links) {
      const match = link.match(/\((https:\/\/github\.com\/[^)\s]+)\)/);
      if (!match) continue;
      const parsed = this.parseGitHubUrl(match[1]);
      if (!parsed) continue;
      repositories.push(`https://github.com/${parsed.owner}/${parsed.repo}`);
    }
    return repositories;
  }
}

// ============================================================================
// Result Types
// ============================================================================

export interface SkillImportResult {
  success: boolean;
  skillName: string;
  installed?: boolean;
  installPath?: string;
  error?: string;
  auditResult: SkillAuditResult | null;
}

export interface CollectionImportResult {
  success: boolean;
  collectionName: string;
  totalSkills: number;
  imported: number;
  failed: number;
  results: SkillImportResult[];
  error?: string;
}

// ============================================================================
// CLI Integration
// ============================================================================

export function createCollectionCommands(manager: SkillCollectionManager) {
  return {
    "skill-collections": {
      description: "Browse available skill collections",
      handler: async () => {
        await manager.browseCollections();
        await manager.browseRecommended();
        return { success: true };
      },
    },

    "skill-import-github": {
      description: "Import skill from GitHub with mandatory audit",
      handler: async (args: { url: string; allowMedium?: boolean; branch?: string }) => {
        const result = await manager.importFromGitHub(args.url, {
          branch: args.branch,
          allowMedium: args.allowMedium,
        });

        return {
          success: result.success,
          skillName: result.skillName,
          installed: result.installed,
          auditPassed: result.auditResult?.passed,
          criticalFindings: result.auditResult?.criticalCount,
          highFindings: result.auditResult?.highCount,
        };
      },
    },

    "skill-import-collection": {
      description: "Import entire skill collection with audits",
      handler: async (args: { name: string; allowMedium?: boolean; parallel?: boolean }) => {
        const result = await manager.importCollection(args.name, {
          allowMedium: args.allowMedium,
          parallel: args.parallel,
        });

        return {
          success: result.success,
          total: result.totalSkills,
          imported: result.imported,
          failed: result.failed,
        };
      },
    },

    "skill-import-recommended": {
      description: "Import all recommended skills with audits",
      handler: async (args: { allowMedium?: boolean; parallel?: boolean }) => {
        const result = await manager.importRecommended({
          allowMedium: args.allowMedium,
          parallel: args.parallel,
        });

        return {
          success: result.success,
          total: result.totalSkills,
          imported: result.imported,
          failed: result.failed,
        };
      },
    },

    "skill-list": {
      description: "List installed skills with audit status",
      handler: async () => {
        const skills = await manager.listInstalled();
        return {
          success: true,
          count: skills.length,
          skills: skills.map((s) => ({
            name: s.name,
            verified: s.verified,
            auditStatus: s.auditStatus,
          })),
        };
      },
    },

    "skill-validate": {
      description: "Re-validate installed skill",
      handler: async (args: { name: string }) => {
        const audit = await manager.validateSkill(args.name);
        return {
          success: audit.passed,
          skillName: args.name,
          passed: audit.passed,
          findings: audit.findings.length,
          critical: audit.criticalCount,
          high: audit.highCount,
        };
      },
    },

    "skill-audit-report": {
      description: "Generate comprehensive audit report",
      handler: async () => {
        const report = await manager.generateAuditReport();
        return {
          success: true,
          report,
        };
      },
    },

    "skill-remove": {
      description: "Remove installed skill",
      handler: async (args: { name: string }) => {
        const removed = await manager.removeSkill(args.name);
        return {
          success: removed,
          skillName: args.name,
        };
      },
    },
  };
}

// ============================================================================
// Export
// ============================================================================

export { SkillAuditor, SafeSkillImporter };
export default SkillCollectionManager;
