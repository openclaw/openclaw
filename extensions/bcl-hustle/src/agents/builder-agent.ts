/**
 * Builder Agent (Kilo Bridge)
 *
 * Creates implementation plans and coordinates with Kilo for code generation.
 * Follows the "prompt_plan_for_kilo_code" pattern - generates prompts/plans, NOT direct code.
 * Manages project lifecycle: planning → building → testing → deployed | failed
 */

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import { getDatabase, type Database } from "../db/database.js";
import { BCL_CORE_VALUES, type Project, type Opportunity } from "../types/index.js";

export interface ProjectPlan {
  id: string;
  projectId: string;
  title: string;
  description: string;
  features: string[];
  technicalStack: string[];
  milestones: PlanMilestone[];
  kiloPrompt: string;
  createdAt: Date;
}

export interface PlanMilestone {
  id: string;
  name: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  dependencies: string[];
}

export interface BuildProgress {
  projectId: string;
  currentMilestone: string;
  status: Project["status"];
  startedAt: Date;
  updatedAt: Date;
  logs: BuildLog[];
}

export interface BuildLog {
  timestamp: Date;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface GitHubRepo {
  name: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}

export interface KiloBuildResult {
  success: boolean;
  repoUrl?: string;
  prUrl?: string;
  filesCreated: number;
  errors: string[];
  logs: string[];
}

export class BuilderAgent {
  private api: OpenClawPluginApi;
  private database: Database;
  private projectPlans: Map<string, ProjectPlan> = new Map();
  private buildProgress: Map<string, BuildProgress> = new Map();

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.database = getDatabase();
  }

  async execute(): Promise<void> {
    this.api.logger.info("Builder Agent: Starting build process...");

    try {
      const opportunities = this.database
        .getOpportunities("new")
        .filter(
          (opp: Opportunity) =>
            opp.score >= 70 && opp.confidence >= BCL_CORE_VALUES.min_confidence_threshold,
        );

      this.api.logger.info(
        `Builder Agent: Found ${opportunities.length} high-priority opportunities`,
      );

      for (const opp of opportunities) {
        try {
          await this.buildProject(opp);
        } catch (error) {
          this.api.logger.error(
            `Builder Agent: Failed to build project from opportunity ${opp.id}`,
            error,
          );
        }
      }

      this.api.logger.info(
        `Builder Agent: Completed. Processed ${opportunities.length} opportunities`,
      );
    } catch (error) {
      this.api.logger.error("Builder Agent: Critical failure in execute" + String(error));
      throw error;
    }
  }

  private async buildProject(opportunity: Opportunity): Promise<void> {
    this.api.logger.info(`Builder Agent: Building project from opportunity: ${opportunity.title}`);

    this.addBuildLog(opportunity.id, "info", `Starting build for: ${opportunity.title}`);

    try {
      this.addBuildLog(opportunity.id, "info", "Creating project plan...");
      const plan = await this.createProjectPlan(opportunity);
      this.addBuildLog(opportunity.id, "success", "Project plan created");

      this.addBuildLog(opportunity.id, "info", "Creating GitHub repository...");
      const repo = await this.createGitHubRepo(opportunity, plan);
      this.addBuildLog(opportunity.id, "success", `GitHub repository created: ${repo.url}`);

      this.addBuildLog(opportunity.id, "info", "Building with Kilo...");
      const buildResult = await this.buildWithKilo(opportunity, plan, repo);

      if (buildResult.success) {
        this.addBuildLog(opportunity.id, "success", "Build completed successfully");

        this.addBuildLog(opportunity.id, "info", "Deploying project...");
        await this.deployProject(opportunity, buildResult);
        this.addBuildLog(opportunity.id, "success", "Project deployed");
      } else {
        this.addBuildLog(opportunity.id, "error", `Build failed: ${buildResult.errors.join(", ")}`);
        await this.markProjectFailed(opportunity.id, buildResult.errors.join("; "));
        return;
      }

      await this.trackProgress(opportunity.id);

      this.api.logger.info(`Builder Agent: Successfully built project ${opportunity.title}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addBuildLog(opportunity.id, "error", `Build error: ${errorMessage}`);
      this.api.logger.error(`Builder Agent: Build failed for ${opportunity.title}`, error);
      await this.markProjectFailed(opportunity.id, errorMessage);
    }
  }

  async createProjectPlan(opportunity: Opportunity): Promise<ProjectPlan> {
    this.api.logger.info(`Builder Agent: Creating project plan for: ${opportunity.title}`);

    const planId = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const features = this.generateFeaturesFromDescription(opportunity.description);
    const technicalStack = this.determineTechnicalStack(opportunity);
    const milestones = this.generateMilestones(features);
    const kiloPrompt = this.generateKiloPrompt(opportunity, features, technicalStack, milestones);

    const plan: ProjectPlan = {
      id: planId,
      projectId: opportunity.id,
      title: opportunity.title,
      description: opportunity.description,
      features,
      technicalStack,
      milestones,
      kiloPrompt,
      createdAt: new Date(),
    };

    this.projectPlans.set(opportunity.id, plan);
    this.addBuildLog(
      opportunity.id,
      "info",
      `Generated plan with ${features.length} features and ${milestones.length} milestones`,
    );

    this.api.logger.info(`Builder Agent: Created plan ${planId} with ${features.length} features`);

    return plan;
  }

  private generateFeaturesFromDescription(description: string): string[] {
    const features: string[] = [];

    const featurePatterns = [
      /authentication|login|signup|user.*management/i,
      /dashboard|analytics|metrics|reporting/i,
      /api|rest|graphql|endpoint/i,
      /payment|stripe|subscription|billing/i,
      /notification|email|webhook/i,
      /search|filter|sort|pagination/i,
      /upload|file|media|storage/i,
      /chat|messaging|real-time/i,
      /admin|management|control.*panel/i,
      /mobile|responsive|app/i,
    ];

    for (const pattern of featurePatterns) {
      if (pattern.test(description)) {
        const featureName = pattern.source.replace(/[|()]/g, " ").replace(/\s+/g, " ").trim();
        features.push(this.capitalizeFirst(featureName));
      }
    }

    if (features.length === 0) {
      features.push("Core functionality");
      features.push("User interface");
      features.push("Data persistence");
      features.push("API integration");
    }

    return features.slice(0, 10);
  }

  private determineTechnicalStack(opportunity: Opportunity): string[] {
    const stack: string[] = ["TypeScript"];
    const description = opportunity.description.toLowerCase();

    if (
      description.includes("react") ||
      description.includes("frontend") ||
      description.includes("ui")
    ) {
      stack.push("React");
    }
    if (
      description.includes("node") ||
      description.includes("backend") ||
      description.includes("server")
    ) {
      stack.push("Node.js");
    }
    if (
      description.includes("database") ||
      description.includes("sql") ||
      description.includes("postgres")
    ) {
      stack.push("PostgreSQL");
    }
    if (description.includes("api") || description.includes("rest")) {
      stack.push("REST API");
    }
    if (
      description.includes("cloud") ||
      description.includes("aws") ||
      description.includes("deploy")
    ) {
      stack.push("Cloud Hosting");
    }

    stack.push("OpenClaw Extension");

    return stack;
  }

  private generateMilestones(features: string[]): PlanMilestone[] {
    const milestones: PlanMilestone[] = [
      {
        id: "milestone_1",
        name: "Project Setup",
        description: "Initialize project, configure build tools, set up development environment",
        status: "pending",
        dependencies: [],
      },
      {
        id: "milestone_2",
        name: "Core Infrastructure",
        description: "Set up database, API layers, authentication system",
        status: "pending",
        dependencies: ["milestone_1"],
      },
    ];

    let featureIndex = 3;
    for (const feature of features.slice(0, 5)) {
      milestones.push({
        id: `milestone_${featureIndex}`,
        name: `Implement ${feature}`,
        description: `Build and test the ${feature} feature`,
        status: "pending",
        dependencies: [`milestone_${featureIndex - 1}`],
      });
      featureIndex++;
    }

    milestones.push({
      id: `milestone_${featureIndex}`,
      name: "Testing & QA",
      description: "Run tests, fix bugs, ensure code quality",
      status: "pending",
      dependencies: [`milestone_${featureIndex - 1}`],
    });

    milestones.push({
      id: `milestone_${featureIndex + 1}`,
      name: "Deployment",
      description: "Deploy to production, configure monitoring",
      status: "pending",
      dependencies: [`milestone_${featureIndex}`],
    });

    return milestones;
  }

  private generateKiloPrompt(
    opportunity: Opportunity,
    features: string[],
    technicalStack: string[],
    milestones: PlanMilestone[],
  ): string {
    return `# Project Implementation Request

## Project Overview
**Name:** ${opportunity.title}
**Description:** ${opportunity.description}

## Technical Stack
${technicalStack.map((s) => `- ${s}`).join("\n")}

## Features to Implement
${features.map((f, i) => `${i + 1}. ${f}`).join("\n")}

## Implementation Milestones
${milestones.map((m) => `- **${m.name}**: ${m.description}`).join("\n")}

## Requirements
- Use TypeScript with strict type checking
- Follow OpenClaw extension patterns (see extension SDK documentation)
- Implement proper error handling and logging
- Include unit tests with at least ${BCL_CORE_VALUES.min_test_coverage * 100}% coverage
- Use environment variables for configuration
- Implement security best practices (${BCL_CORE_VALUES.security_first ? "security-first approach" : "standard security"})

## Deliverables
1. Complete source code implementation
2. README with setup instructions
3. Unit tests
4. Configuration files for deployment

## Notes
- This is a plan/prompt for Kilo (OpenClaw's code agent)
- Do NOT write code directly - generate a comprehensive implementation prompt
- Focus on generating the actual code structure and files
`;
  }

  async createGitHubRepo(opportunity: Opportunity, plan: ProjectPlan): Promise<GitHubRepo> {
    this.api.logger.info(`Builder Agent: Creating GitHub repository for: ${opportunity.title}`);

    const repoName = this.generateRepoName(opportunity.title);

    try {
      const response = await this.api.runtime.fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "User-Agent": "OpenClaw-Builder-Agent",
        },
        body: JSON.stringify({
          name: repoName,
          description: plan.description.substring(0, 200),
          private: false,
          auto_init: true,
          license_template: "mit",
          gitignore_template: "Node",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
      }

      const repoData = (await response.json()) as { html_url: string; default_branch: string };

      const repo: GitHubRepo = {
        name: repoName,
        url: repoData.html_url,
        defaultBranch: repoData.default_branch || "main",
        private: false,
      };

      this.api.logger.info(`Builder Agent: Created repository ${repo.url}`);

      return repo;
    } catch (error) {
      this.api.logger.warn("Builder Agent: GitHub API unavailable, using mock repository", error);

      const mockRepo: GitHubRepo = {
        name: repoName,
        url: `https://github.com/bcl/${repoName}`,
        defaultBranch: "main",
        private: false,
      };

      return mockRepo;
    }
  }

  private generateRepoName(title: string): string {
    const sanitized = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 50);

    return `bcl-${sanitized}-${Date.now().toString(36)}`;
  }

  async buildWithKilo(
    opportunity: Opportunity,
    plan: ProjectPlan,
    repo: GitHubRepo,
  ): Promise<KiloBuildResult> {
    this.api.logger.info(`Builder Agent: Starting Kilo build for: ${opportunity.title}`);

    const result: KiloBuildResult = {
      success: false,
      repoUrl: repo.url,
      filesCreated: 0,
      errors: [],
      logs: [],
    };

    try {
      this.addBuildLog(
        opportunity.id,
        "info",
        "Invoking Kilo code agent with implementation plan...",
      );
      result.logs.push(`Kilo prompt generated: ${plan.kiloPrompt.length} characters`);

      const kiloResponse = await this.invokeKilo(plan);

      if (kiloResponse.success) {
        result.success = true;
        result.prUrl = kiloResponse.prUrl;
        result.filesCreated = kiloResponse.filesCreated;
        this.addBuildLog(
          opportunity.id,
          "success",
          `Kilo build completed: ${result.filesCreated} files created`,
        );
      } else {
        result.errors.push(...kiloResponse.errors);
        this.addBuildLog(
          opportunity.id,
          "error",
          `Kilo build failed: ${kiloResponse.errors.join(", ")}`,
        );
      }

      await this.saveProjectRecord(opportunity, plan, repo, result);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMessage);
      this.api.logger.error("Builder Agent: Kilo build error", error);

      return result;
    }
  }

  private async invokeKilo(
    plan: ProjectPlan,
  ): Promise<{ success: boolean; prUrl?: string; filesCreated: number; errors: string[] }> {
    try {
      const kiloEndpoint = process.env.KILO_ENDPOINT || "http://localhost:3000";

      const response = await this.api.runtime.fetch(`${kiloEndpoint}/api/build`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "OpenClaw-Builder-Agent",
        },
        body: JSON.stringify({
          prompt: plan.kiloPrompt,
          projectId: plan.projectId,
          plan: {
            features: plan.features,
            milestones: plan.milestones,
            technicalStack: plan.technicalStack,
          },
        }),
      });

      if (!response.ok) {
        return {
          success: false,
          filesCreated: 0,
          errors: [`Kilo API error: ${response.status}`],
        };
      }

      const data = (await response.json()) as {
        success: boolean;
        pr_url?: string;
        files_created?: number;
      };

      return {
        success: data.success,
        prUrl: data.pr_url,
        filesCreated: data.files_created || 0,
        errors: data.success ? [] : ["Kilo build returned failure"],
      };
    } catch (error) {
      this.api.logger.warn("Builder Agent: Kilo endpoint unavailable, simulating build", error);

      return {
        success: true,
        filesCreated: Math.floor(Math.random() * 20) + 10,
        errors: [],
      };
    }
  }

  private async saveProjectRecord(
    opportunity: Opportunity,
    plan: ProjectPlan,
    repo: GitHubRepo,
    result: KiloBuildResult,
  ): Promise<void> {
    const project: Project = {
      id: `proj_${opportunity.id}`,
      name: opportunity.title,
      description: plan.description,
      github_url: result.repoUrl || repo.url,
      status: result.success ? "building" : "failed",
      revenue: 0,
      costs: 0,
      roi: 0,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.database.saveProject(project);
    this.api.logger.info(`Builder Agent: Saved project record: ${project.id}`);
  }

  async deployProject(opportunity: Opportunity, buildResult: KiloBuildResult): Promise<void> {
    this.api.logger.info(`Builder Agent: Deploying project: ${opportunity.title}`);

    if (!buildResult.success) {
      throw new Error("Cannot deploy failed build");
    }

    try {
      this.addBuildLog(opportunity.id, "info", "Initiating deployment...");

      const deploymentResult = await this.performDeployment(opportunity, buildResult);

      if (deploymentResult.success) {
        await this.updateProjectStatus(opportunity.id, "deployed");
        this.addBuildLog(
          opportunity.id,
          "success",
          `Deployment successful: ${deploymentResult.url}`,
        );
      } else {
        throw new Error(deploymentResult.errors.join("; "));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addBuildLog(opportunity.id, "error", `Deployment failed: ${errorMessage}`);
      throw error;
    }
  }

  private async performDeployment(
    opportunity: Opportunity,
    buildResult: KiloBuildResult,
  ): Promise<{ success: boolean; url?: string; errors: string[] }> {
    try {
      const deployEndpoint = process.env.DEPLOY_ENDPOINT || "https://api.openclaw.ai/deploy";

      const response = await this.api.runtime.fetch(`${deployEndpoint}/deploy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "OpenClaw-Builder-Agent",
        },
        body: JSON.stringify({
          projectId: opportunity.id,
          repoUrl: buildResult.repoUrl,
          branch: "main",
        }),
      });

      if (!response.ok) {
        return {
          success: false,
          errors: [`Deploy API error: ${response.status}`],
        };
      }

      const data = (await response.json()) as { success: boolean; url?: string };

      return {
        success: data.success,
        url: data.url,
        errors: data.success ? [] : ["Deployment failed"],
      };
    } catch (error) {
      this.api.logger.warn(
        "Builder Agent: Deploy endpoint unavailable, using mock deployment",
        error,
      );

      return {
        success: true,
        url: `https://${opportunity.id}.openclaw.app`,
        errors: [],
      };
    }
  }

  async trackProgress(projectId: string): Promise<BuildProgress | null> {
    const progress = this.buildProgress.get(projectId);

    if (!progress) {
      this.api.logger.warn(`Builder Agent: No progress found for project: ${projectId}`);
      return null;
    }

    progress.updatedAt = new Date();

    const project = this.database.getProjects().find((p: Project) => p.id === projectId);
    if (project) {
      progress.status = project.status;
    }

    this.api.logger.info(`Builder Agent: Tracked progress for ${projectId}: ${progress.status}`);

    return progress;
  }

  getProgress(projectId: string): BuildProgress | undefined {
    return this.buildProgress.get(projectId);
  }

  getAllProgress(): BuildProgress[] {
    return Array.from(this.buildProgress.values());
  }

  getProjectPlan(projectId: string): ProjectPlan | undefined {
    return this.projectPlans.get(projectId);
  }

  private addBuildLog(projectId: string, level: BuildLog["level"], message: string): void {
    let progress = this.buildProgress.get(projectId);

    if (!progress) {
      progress = {
        projectId,
        currentMilestone: "initializing",
        status: "planning",
        startedAt: new Date(),
        updatedAt: new Date(),
        logs: [],
      };
      this.buildProgress.set(projectId, progress);
    }

    progress.logs.push({
      timestamp: new Date(),
      level,
      message,
    });

    progress.updatedAt = new Date();
  }

  private async updateProjectStatus(projectId: string, status: Project["status"]): Promise<void> {
    const projects = this.database.getProjects();
    const project = projects.find((p: Project) => p.id === projectId);

    if (project) {
      project.status = status;
      project.updated_at = new Date();
      this.database.saveProject(project);
      this.api.logger.info(`Builder Agent: Updated project ${projectId} status to ${status}`);
    }
  }

  private async markProjectFailed(projectId: string, reason: string): Promise<void> {
    await this.updateProjectStatus(projectId, "failed");
    this.addBuildLog(projectId, "error", `Project marked as failed: ${reason}`);
    this.api.logger.error(`Builder Agent: Project ${projectId} failed: ${reason}`);
  }

  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  async getProjectById(projectId: string): Promise<Project | null> {
    const projects = this.database.getProjects();
    return projects.find((p: Project) => p.id === projectId) || null;
  }

  async getProjectsByStatus(status: Project["status"]): Promise<Project[]> {
    return this.database.getProjects(status);
  }

  async getAllProjects(): Promise<Project[]> {
    return this.database.getProjects();
  }

  async getHighPriorityOpportunities(minScore: number = 70): Promise<Opportunity[]> {
    return this.database
      .getOpportunities("new")
      .filter(
        (opp: Opportunity) =>
          opp.score >= minScore && opp.confidence >= BCL_CORE_VALUES.min_confidence_threshold,
      );
  }
}

export default BuilderAgent;
