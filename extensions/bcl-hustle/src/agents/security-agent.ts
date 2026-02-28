/**
 * Security Agent
 *
 * Handles security scanning, Dependabot configuration, vulnerability monitoring,
 * and automated security patches for BCL projects.
 */

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import { getProjects } from "../db/database.js";
import { BCL_CORE_VALUES, type Project } from "../types/index.js";

export interface Vulnerability {
  id: string;
  package: string;
  severity: "critical" | "high" | "medium" | "low";
  vulnerableVersion: string;
  patchedVersion?: string;
  description: string;
  cve?: string;
  createdAt: Date;
}

export interface SecurityScanResult {
  projectId: string;
  repoUrl: string;
  scannedAt: Date;
  vulnerabilities: Vulnerability[];
  dependabotEnabled: boolean;
  lastCommitSha?: string;
  commitScan: boolean;
}

export interface DependabotConfig {
  enabled: boolean;
  packageEcosystems: string[];
  schedule: "daily" | "weekly" | "monthly";
  openPullRequestsLimit: number;
  versionUpdates: "incremental" | "all";
}

export interface PatchInfo {
  id: string;
  vulnerabilityId: string;
  prUrl?: string;
  status: "pending" | "applied" | "failed";
  appliedAt?: Date;
  error?: string;
}

export class SecurityAgent {
  private api: OpenClawPluginApi;
  private githubToken?: string;
  private vulnerabilityCache: Map<string, Vulnerability[]> = new Map();

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.githubToken = process.env.GITHUB_TOKEN;
  }

  async execute(): Promise<void> {
    if (!BCL_CORE_VALUES.security_scan_on_every_commit) {
      this.api.logger.info("Security Agent: Security scanning disabled");
      return;
    }

    this.api.logger.info("Security Agent: Starting security operations...");

    try {
      const projects = getProjects();

      for (const project of projects) {
        if (project.github_url) {
          try {
            await this.scanRepository(project.github_url);
          } catch (error) {
            this.api.logger.error(`Security Agent: Failed to scan ${project.github_url}`, error);
          }
        }
      }

      if (BCL_CORE_VALUES.dependabot_enabled) {
        await this.setupDependabot();
      }

      await this.monitorVulnerabilities();

      await this.applyAvailablePatches();

      this.api.logger.info("Security Agent: Completed security operations");
    } catch (error) {
      this.api.logger.error("Security Agent: Critical failure in execute", error);
      throw error;
    }
  }

  async setupDependabot(): Promise<{
    success: boolean;
    reposConfigured: number;
    errors: string[];
  }> {
    this.api.logger.info("Security Agent: Setting up Dependabot for repositories...");

    const result = {
      success: true,
      reposConfigured: 0,
      errors: [] as string[],
    };

    const projects = getProjects();

    for (const project of projects) {
      if (!project.github_url) continue;

      try {
        const configured = await this.configureDependabot(project);
        if (configured) {
          result.reposConfigured++;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to configure Dependabot for ${project.github_url}: ${errorMsg}`);
        result.success = false;
      }
    }

    this.api.logger.info(
      `Security Agent: Configured Dependabot for ${result.reposConfigured} repositories`,
    );
    return result;
  }

  private async configureDependabot(project: Project): Promise<boolean> {
    const repoPath = this.extractRepoPath(project.github_url);
    if (!repoPath) {
      this.api.logger.warn(`Security Agent: Invalid GitHub URL: ${project.github_url}`);
      return false;
    }

    const config: DependabotConfig = {
      enabled: true,
      packageEcosystems: ["npm", "pip", "go", "cargo", "rubygems"],
      schedule: "weekly",
      openPullRequestsLimit: 5,
      versionUpdates: "incremental",
    };

    const dependabotConfig = this.generateDependabotYml(config);

    try {
      const response = await this.api.runtime.fetch(
        `https://api.github.com/repos/${repoPath}/contents/.github/dependabot.yml`,
        {
          method: "PUT",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${this.githubToken}`,
            "Content-Type": "application/json",
            "User-Agent": "OpenClaw-Security-Agent",
          },
          body: JSON.stringify({
            message: "Enable Dependabot for automated dependency updates",
            content: Buffer.from(dependabotConfig).toString("base64"),
            branch: project.github_url.includes("/") ? project.github_url.split("/").pop() : "main",
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 422) {
          this.api.logger.info(`Security Agent: Dependabot already configured for ${repoPath}`);
          return true;
        }
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }

      this.api.logger.info(`Security Agent: Configured Dependabot for ${repoPath}`);
      return true;
    } catch (error) {
      if (!this.githubToken) {
        this.api.logger.warn(
          "Security Agent: GitHub token not available, skipping Dependabot configuration",
        );
        return false;
      }
      throw error;
    }
  }

  private generateDependabotYml(config: DependabotConfig): string {
    const ecosystems = config.packageEcosystems
      .map(
        (e) =>
          `  - package-ecosystem: "${e}"\n    directory: "/"\n    schedule:\n      interval: "${config.schedule}"`,
      )
      .join("\n");

    return `version: 2
updates:
${ecosystems}
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "${config.schedule}"

open-pull-requests-limit: ${config.openPullRequestsLimit}
`;
  }

  async scanRepository(repoUrl: string, commitSha?: string): Promise<SecurityScanResult> {
    this.api.logger.info(
      `Security Agent: Scanning repository ${repoUrl}${commitSha ? ` at commit ${commitSha}` : ""}`,
    );

    const repoPath = this.extractRepoPath(repoUrl);
    if (!repoPath) {
      throw new Error(`Invalid GitHub URL: ${repoUrl}`);
    }

    const result: SecurityScanResult = {
      projectId: repoPath,
      repoUrl,
      scannedAt: new Date(),
      vulnerabilities: [],
      dependabotEnabled: false,
      lastCommitSha: commitSha,
      commitScan: !!commitSha,
    };

    try {
      const vulnerabilities = await this.fetchVulnerabilities(repoPath);
      result.vulnerabilities = vulnerabilities;
      this.vulnerabilityCache.set(repoUrl, vulnerabilities);

      await this.checkDependabotStatus(repoPath).then((enabled) => {
        result.dependabotEnabled = enabled;
      });

      if (commitSha) {
        await this.scanCommit(repoPath, commitSha);
      }

      const criticalVulns = vulnerabilities.filter((v) => v.severity === "critical");
      if (criticalVulns.length > 0) {
        await this.alertCritical(criticalVulns, repoUrl);
      }

      this.api.logger.info(
        `Security Agent: Found ${vulnerabilities.length} vulnerabilities in ${repoPath}`,
      );
    } catch (error) {
      this.api.logger.error(`Security Agent: Scan failed for ${repoUrl}`, error);
      throw error;
    }

    return result;
  }

  private async fetchVulnerabilities(repoPath: string): Promise<Vulnerability[]> {
    const vulnerabilities: Vulnerability[] = [];

    try {
      const response = await this.api.runtime.fetch(
        `https://api.github.com/repos/${repoPath}/dependabot/vulnerabilities`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${this.githubToken}`,
            "User-Agent": "OpenClaw-Security-Agent",
          },
        },
      );

      if (!response.ok) {
        if (response.status === 404) {
          this.api.logger.info(
            `Security Agent: No Dependabot vulnerabilities found for ${repoPath}`,
          );
          return vulnerabilities;
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const data = (await response.json()) as Array<{
        vulnerable_package_name: string;
        severity: string;
        vulnerable_version_range?: string[];
        patched_version?: string;
        description?: string;
        advisory_identifier?: string;
        created_at: string;
      }>;

      for (const vuln of data) {
        vulnerabilities.push({
          id: `vuln_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          package: vuln.vulnerable_package_name,
          severity: this.normalizeSeverity(vuln.severity),
          vulnerableVersion: vuln.vulnerable_version_range?.join(", ") || "unknown",
          patchedVersion: vuln.patched_version,
          description: vuln.description || "No description available",
          cve: vuln.advisory_identifier,
          createdAt: new Date(vuln.created_at),
        });
      }
    } catch (error) {
      this.api.logger.warn(
        `Security Agent: Could not fetch vulnerabilities from GitHub for ${repoPath}`,
        error,
      );
    }

    return vulnerabilities;
  }

  private normalizeSeverity(severity: string): Vulnerability["severity"] {
    const normalized = severity.toLowerCase();
    if (normalized === "critical") return "critical";
    if (normalized === "high") return "high";
    if (normalized === "medium") return "medium";
    return "low";
  }

  private async checkDependabotStatus(repoPath: string): Promise<boolean> {
    try {
      const response = await this.api.runtime.fetch(
        `https://api.github.com/repos/${repoPath}/dependabot/secrets`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${this.githubToken}`,
            "User-Agent": "OpenClaw-Security-Agent",
          },
        },
      );

      return response.ok;
    } catch {
      return false;
    }
  }

  private async scanCommit(repoPath: string, commitSha: string): Promise<void> {
    this.api.logger.info(`Security Agent: Performing commit-level scan for ${commitSha}`);

    try {
      const response = await this.api.runtime.fetch(
        `https://api.github.com/repos/${repoPath}/commits/${commitSha}`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${this.githubToken}`,
            "User-Agent": "OpenClaw-Security-Agent",
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch commit: ${response.status}`);
      }

      const commit = (await response.json()) as {
        files?: Array<{ filename: string; status: string }>;
      };

      if (commit.files) {
        for (const file of commit.files) {
          if (
            file.filename.endsWith("package.json") ||
            file.filename.endsWith("requirements.txt") ||
            file.filename.endsWith("go.mod") ||
            file.filename.endsWith("Cargo.toml")
          ) {
            this.api.logger.info(`Security Agent: Detected dependency change in ${file.filename}`);
          }
        }
      }
    } catch (error) {
      this.api.logger.warn(
        `Security Agent: Commit scan failed for ${repoPath}/${commitSha}`,
        error,
      );
    }
  }

  async getVulnerabilities(repoUrl?: string): Promise<Vulnerability[]> {
    if (repoUrl) {
      const cached = this.vulnerabilityCache.get(repoUrl);
      if (cached) {
        return cached;
      }

      try {
        const result = await this.scanRepository(repoUrl);
        return result.vulnerabilities;
      } catch {
        return [];
      }
    }

    const allVulnerabilities: Vulnerability[] = [];
    for (const [, vulns] of this.vulnerabilityCache) {
      allVulnerabilities.push(...vulns);
    }

    const projects = getProjects();
    for (const project of projects) {
      if (project.github_url && !this.vulnerabilityCache.has(project.github_url)) {
        try {
          const result = await this.scanRepository(project.github_url);
          allVulnerabilities.push(...result.vulnerabilities);
        } catch {
          // Continue with other projects
        }
      }
    }

    return allVulnerabilities;
  }

  async applyPatch(vulnerabilityId: string): Promise<PatchInfo> {
    this.api.logger.info(
      `Security Agent: Attempting to apply patch for vulnerability ${vulnerabilityId}`,
    );

    const patch: PatchInfo = {
      id: `patch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      vulnerabilityId,
      status: "pending",
    };

    try {
      const allVulns = await this.getVulnerabilities();
      const vulnerability = allVulns.find(
        (v) => v.id === vulnerabilityId || v.cve === vulnerabilityId,
      );

      if (!vulnerability) {
        patch.status = "failed";
        patch.error = "Vulnerability not found";
        return patch;
      }

      if (!vulnerability.patchedVersion) {
        patch.status = "failed";
        patch.error = "No patched version available";
        return patch;
      }

      const projects = getProjects();
      for (const project of projects) {
        if (project.github_url) {
          const prCreated = await this.createPatchPullRequest(project, vulnerability);
          if (prCreated) {
            patch.status = "applied";
            patch.prUrl = prCreated;
            patch.appliedAt = new Date();
            this.api.logger.info(
              `Security Agent: Created PR for patching ${vulnerability.package}`,
            );
            break;
          }
        }
      }

      if (patch.status === "pending") {
        patch.status = "failed";
        patch.error = "Could not create pull request";
      }
    } catch (error) {
      patch.status = "failed";
      patch.error = error instanceof Error ? error.message : String(error);
      this.api.logger.error(`Security Agent: Failed to apply patch for ${vulnerabilityId}`, error);
    }

    return patch;
  }

  private async createPatchPullRequest(
    project: Project,
    vulnerability: Vulnerability,
  ): Promise<string | null> {
    if (!project.github_url || !this.githubToken) {
      return null;
    }

    const repoPath = this.extractRepoPath(project.github_url);
    if (!repoPath) return null;

    const branchName = `security-patch-${vulnerability.package}-${Date.now()}`;

    try {
      const response = await this.api.runtime.fetch(`https://api.github.com/repos/${repoPath}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${this.githubToken}`,
          "User-Agent": "OpenClaw-Security-Agent",
        },
      });

      if (!response.ok) return null;
      const repoData = (await response.json()) as { default_branch: string };
      const baseBranch = repoData.default_branch || "main";

      const prTitle = `Security: Update ${vulnerability.package} to ${vulnerability.patchedVersion}`;
      const prBody = `## Security Patch

This pull request addresses a security vulnerability in **${vulnerability.package}**.

### Vulnerability Details
- **Severity:** ${vulnerability.severity.toUpperCase()}
- **CVE:** ${vulnerability.cve || "N/A"}
- **Vulnerable Version:** ${vulnerability.vulnerableVersion}
- **Patched Version:** ${vulnerability.patchedVersion}

### Description
${vulnerability.description}

### Changes
- Updated ${vulnerability.package} to version ${vulnerability.patchedVersion}

---
*Automated security patch generated by BCL Security Agent*`;

      const prResponse = await this.api.runtime.fetch(
        `https://api.github.com/repos/${repoPath}/pulls`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${this.githubToken}`,
            "Content-Type": "application/json",
            "User-Agent": "OpenClaw-Security-Agent",
          },
          body: JSON.stringify({
            title: prTitle,
            body: prBody,
            head: branchName,
            base: baseBranch,
          }),
        },
      );

      if (!prResponse.ok) {
        const errorText = await prResponse.text();
        this.api.logger.warn(`Security Agent: Could not create PR: ${errorText}`);
        return null;
      }

      const prData = (await prResponse.json()) as { html_url: string };
      return prData.html_url;
    } catch (error) {
      this.api.logger.error(`Security Agent: Failed to create patch PR`, error);
      return null;
    }
  }

  private async applyAvailablePatches(): Promise<{
    attempted: number;
    successful: number;
    failed: number;
  }> {
    this.api.logger.info("Security Agent: Applying available security patches...");

    const result = {
      attempted: 0,
      successful: 0,
      failed: 0,
    };

    const vulnerabilities = await this.getVulnerabilities();
    const criticalAndHigh = vulnerabilities.filter(
      (v) => v.severity === "critical" || v.severity === "high",
    );

    for (const vuln of criticalAndHigh) {
      if (vuln.patchedVersion) {
        result.attempted++;
        const patchResult = await this.applyPatch(vuln.id);
        if (patchResult.status === "applied") {
          result.successful++;
        } else {
          result.failed++;
        }
      }
    }

    this.api.logger.info(
      `Security Agent: Applied ${result.successful}/${result.attempted} patches`,
    );
    return result;
  }

  async alertCritical(vulnerabilities: Vulnerability[], repoUrl: string): Promise<void> {
    this.api.logger.error(
      `Security Agent: CRITICAL ALERT - ${vulnerabilities.length} critical vulnerabilities found in ${repoUrl}`,
    );

    const alertMessage = this.generateCriticalAlert(vulnerabilities, repoUrl);

    try {
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        await this.sendTelegramAlert(alertMessage);
      }

      this.api.logger.error(`Security Agent: Critical alert: ${alertMessage}`);
    } catch (error) {
      this.api.logger.error("Security Agent: Failed to send critical alert", error);
    }
  }

  private generateCriticalAlert(vulnerabilities: Vulnerability[], repoUrl: string): string {
    const vulnList = vulnerabilities
      .map(
        (v) =>
          `- **${v.package}** (${v.severity.toUpperCase()}): ${v.description.substring(0, 100)}...`,
      )
      .join("\n");

    return `🚨 CRITICAL SECURITY ALERT

Repository: ${repoUrl}
Critical Vulnerabilities Found: ${vulnerabilities.length}

${vulnList}

Immediate action required!`;
  }

  private async sendTelegramAlert(message: string): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) return;

    await this.api.runtime.fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  }

  private async monitorVulnerabilities(): Promise<void> {
    this.api.logger.info("Security Agent: Monitoring vulnerabilities across all projects...");

    const projects = getProjects();
    const criticalVulns: Array<{ vuln: Vulnerability; repoUrl: string }> = [];

    for (const project of projects) {
      if (!project.github_url) continue;

      try {
        const vulnerabilities = await this.getVulnerabilities(project.github_url);
        const critical = vulnerabilities.filter((v) => v.severity === "critical");

        for (const vuln of critical) {
          criticalVulns.push({ vuln, repoUrl: project.github_url! });
        }
      } catch {
        // Continue monitoring other projects
      }
    }

    if (criticalVulns.length > 0) {
      const groupedByRepo = criticalVulns.reduce(
        (acc, { vuln, repoUrl }) => {
          if (!acc[repoUrl]) acc[repoUrl] = [];
          acc[repoUrl].push(vuln);
          return acc;
        },
        {} as Record<string, Vulnerability[]>,
      );

      for (const [repoUrl, vulns] of Object.entries(groupedByRepo)) {
        await this.alertCritical(vulns, repoUrl);
      }
    }

    this.api.logger.info(
      `Security Agent: Vulnerability monitoring complete. Found ${criticalVulns.length} critical issues`,
    );
  }

  private extractRepoPath(url: string): string | null {
    const match = url.match(/github\.com\/([^\/]+\/[^\/]+)/);
    return match ? match[1] : null;
  }

  async getSecurityReport(): Promise<{
    totalVulnerabilities: number;
    bySeverity: Record<string, number>;
    criticalProjects: string[];
    dependabotCoverage: number;
  }> {
    const vulnerabilities = await this.getVulnerabilities();
    const projects = getProjects();

    const bySeverity: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };

    for (const vuln of vulnerabilities) {
      bySeverity[vuln.severity]++;
    }

    const projectVulns = new Map<string, Vulnerability[]>();
    for (const project of projects) {
      if (project.github_url) {
        const vulns = await this.getVulnerabilities(project.github_url);
        projectVulns.set(project.github_url, vulns);
      }
    }

    const criticalProjects: string[] = [];
    for (const [repoUrl, vulns] of projectVulns) {
      if (vulns.some((v) => v.severity === "critical")) {
        criticalProjects.push(repoUrl);
      }
    }

    const projectsWithDependabot = projects.filter(
      (p) => p.github_url && projectVulns.get(p.github_url)?.some((v) => v),
    ).length;

    const dependabotCoverage =
      projects.length > 0 ? Math.round((projectsWithDependabot / projects.length) * 100) : 0;

    return {
      totalVulnerabilities: vulnerabilities.length,
      bySeverity,
      criticalProjects,
      dependabotCoverage,
    };
  }
}

export default SecurityAgent;
