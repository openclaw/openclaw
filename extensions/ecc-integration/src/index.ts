/**
 * ECC Integration for OpenClaw - Main Entry Point
 * Hybrid AI agent system combining ECC expertise with OpenClaw operations
 */

export { GovernanceEngine, CORE_RULES } from "./governance/engine.js";
export type { Agent, Task, ECCProfile, GovernanceRule } from "./governance/engine.js";

export { AgentOrchestrator } from "./agents/orchestrator.js";
export type { OrchestrationConfig, TaskExecutor } from "./agents/orchestrator.js";

export { SelfImprovementEngine } from "./learning/engine.js";
export type { Instinct, Skill, LearningConfig, LearningData } from "./learning/engine.js";

export { SecurityScanner, SkillCreator, BestPracticeEnforcer } from "./ecc/index.js";
export type { SecurityFinding, PracticeCheckResult } from "./ecc/index.js";

// Skill Auditor - Mandatory security scanning for skills
export { SkillAuditor, SafeSkillImporter, SECURITY_PATTERNS } from "./security/skill-auditor.js";
export type {
  SkillAuditFinding,
  SkillAuditResult,
  SkillManifest,
  SafeImportOptions,
} from "./security/skill-auditor.js";

// Skill Collection Manager - Curated skill imports
export {
  SkillCollectionManager,
  CURATED_COLLECTIONS,
  RECOMMENDED_SKILLS,
} from "./skills/collection-manager.js";
export type {
  SkillCollection,
  CuratedSkill,
  SkillImportResult,
  CollectionImportResult,
} from "./skills/collection-manager.js";

// NVIDIA NIM Provider - Free model inference
export {
  NVIDIAProvider,
  NVIDIAModelRouter,
  NVIDIA_MODEL_CAPABILITIES,
} from "./providers/nvidia-nim.js";
export type {
  NVIDIAProviderConfig,
  ModelCapability,
  NVIDIAResponseChunk,
  RoutingDecision,
} from "./providers/nvidia-nim.js";

// Model Registry - Capability analysis and routing
export { ModelRegistry } from "./providers/model-registry.js";
export type {
  ModelProfile,
  BenchmarkResult,
  TaskSpec,
  RoutingStrategy,
  ModelPerformanceReport,
} from "./providers/model-registry.js";

// Blueprint Manager - Workflow blueprints
export { BlueprintManager, CURATED_BLUEPRINTS } from "./blueprints/manager.js";
export type {
  BlueprintDefinition,
  WorkflowDefinition,
  WorkflowStage,
  BlueprintExecution,
  StageResult,
} from "./blueprints/manager.js";

// ============================================================================
// System Integration Class
// ============================================================================

import type { z } from "zod";
import { AgentOrchestrator, type OrchestrationConfig } from "./agents/orchestrator.js";
import { BlueprintManager } from "./blueprints/manager.js";
import {
  SecurityScanner,
  SkillCreator,
  BestPracticeEnforcer,
  type SecurityFinding,
  type PracticeCheckResult,
} from "./ecc/index.js";
import { GovernanceEngine } from "./governance/engine.js";
import type { AgentTypeSchema } from "./governance/engine.js";
import { SelfImprovementEngine, type LearningConfig } from "./learning/engine.js";
import type { LearningData } from "./learning/engine.js";
import { ModelRegistry } from "./providers/model-registry.js";
import {
  NVIDIAProvider,
  NVIDIAModelRouter,
  NVIDIA_MODEL_CAPABILITIES,
} from "./providers/nvidia-nim.js";
import { SkillAuditor, SafeSkillImporter } from "./security/skill-auditor.js";
import { SkillCollectionManager } from "./skills/collection-manager.js";

export interface ECCIntegrationConfig {
  governance: {
    enabled: boolean;
    customRules?: unknown[];
  };
  orchestration: OrchestrationConfig;
  learning: LearningConfig;
  ecc: {
    securityScanning: boolean;
    skillCreation: boolean;
    bestPracticeEnforcement: boolean;
  };
  skillAuditor: {
    enabled: boolean;
    trustedDomains: string[];
    quarantinePath: string;
  };
}

export class ECCIntegration {
  governance: GovernanceEngine;
  orchestrator: AgentOrchestrator;
  learning: SelfImprovementEngine;
  security: SecurityScanner;
  skills: SkillCreator;
  practices: BestPracticeEnforcer;
  skillAuditor: SkillAuditor;
  skillImporter: SafeSkillImporter;
  skillCollections: SkillCollectionManager;
  nvidiaProvider: NVIDIAProvider;
  modelRouter: NVIDIAModelRouter;
  modelRegistry: ModelRegistry;
  blueprints: BlueprintManager;

  private config: ECCIntegrationConfig;

  constructor(config: Partial<ECCIntegrationConfig> = {}) {
    this.config = {
      governance: { enabled: true },
      orchestration: {
        maxAgentsPerType: 3,
        taskTimeoutMs: 300000,
        autoScaling: true,
        healthCheckIntervalMs: 30000,
      },
      learning: {
        minConfidenceThreshold: 0.7,
        maxInstinctsPerAgent: 100,
        skillEvolutionIntervalMs: 3600000,
        patternRecognitionEnabled: true,
      },
      ecc: {
        securityScanning: true,
        skillCreation: true,
        bestPracticeEnforcement: true,
      },
      skillAuditor: {
        enabled: true,
        trustedDomains: ["github.com", "gitlab.com", "raw.githubusercontent.com"],
        quarantinePath: "./quarantine",
      },
      ...config,
    };

    // Initialize core components
    this.governance = new GovernanceEngine();
    this.orchestrator = new AgentOrchestrator(this.governance, this.config.orchestration);
    this.learning = new SelfImprovementEngine(this.config.learning);
    this.security = new SecurityScanner();
    this.skills = new SkillCreator();
    this.practices = new BestPracticeEnforcer();

    // Initialize skill auditor (MANDATORY for security)
    this.skillAuditor = new SkillAuditor({
      trustedDomains: this.config.skillAuditor.trustedDomains,
    });
    this.skillImporter = new SafeSkillImporter(this.skillAuditor);
    this.skillCollections = new SkillCollectionManager({
      auditor: this.skillAuditor,
      importer: this.skillImporter,
      installPath: "./skills",
    });

    // Initialize NVIDIA NIM provider
    this.nvidiaProvider = new NVIDIAProvider({
      apiKey: process.env.NVIDIA_API_KEY || "",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      defaultModel: "qwen/qwen3.5-397b-a17b",
      enableThinking: true,
      clearThinking: false,
    });
    this.modelRouter = new NVIDIAModelRouter(this.nvidiaProvider);

    // Initialize model registry
    this.modelRegistry = new ModelRegistry();
    this.registerNVIDIAModels();

    // Initialize blueprint manager
    this.blueprints = new BlueprintManager();

    console.log("[ECC Integration] System initialized");
    console.log("[ECC Integration] Three Core Rules active:");
    console.log("  1. Rules > Freedom");
    console.log("  2. One Agent/One Task");
    console.log("  3. Claude Code Integration");
    console.log("[ECC Integration] Skill Auditor active (MANDATORY for all skill imports)");
    console.log("[ECC Integration] NVIDIA NIM provider ready");
    console.log("[ECC Integration] Model Registry initialized");
    console.log("[ECC Integration] Blueprint Manager loaded");
  }

  /**
   * Initialize the system with default agents
   */
  async initialize(): Promise<void> {
    // Create default agent pool
    const agentTypes: z.infer<typeof AgentTypeSchema>[] = [
      "architect",
      "developer",
      "reviewer",
      "security",
    ];

    for (const type of agentTypes) {
      await this.orchestrator.createAgent(type);
    }

    console.log("[ECC Integration] Default agents created");
  }

  /**
   * Submit a task to the system
   */
  async submitTask(
    title: string,
    description: string,
    options: {
      priority?: "low" | "medium" | "high" | "critical";
      agentType?: z.infer<typeof AgentTypeSchema>;
    } = {},
  ): Promise<string> {
    return this.orchestrator.submitTask(
      title,
      description,
      options.priority || "medium",
      options.agentType,
    );
  }

  /**
   * Get system status
   */
  getStatus(): SystemStatus {
    return {
      governance: {
        rulesActive: this.governance.getAuditLog().length,
        agents: this.governance.getAgents().length,
        tasks: this.governance.getTasks().length,
      },
      orchestration: this.orchestrator.getStatus(),
      learning: this.learning.exportLearningData().summary,
    };
  }

  /**
   * Run security scan on files
   */
  async scanSecurity(files: Array<{ path: string; content: string }>): Promise<{
    findings: import("./ecc/index.js").SecurityFinding[];
    passed: boolean;
    report: string;
  }> {
    const result = await this.security.scanFiles(files);
    return {
      findings: result.findings,
      passed: result.passed,
      report: this.security.generateReport(result),
    };
  }

  /**
   * Check best practices
   */
  checkPractices(filePath: string, content: string): PracticeCheckResult {
    return this.practices.checkFile(filePath, content);
  }

  /**
   * Generate skill from patterns
   */
  generateSkill(name: string, patterns: string[], examples: string[]) {
    const skill = this.skills.generateSkill(name, patterns, examples);
    return {
      skill,
      markdown: this.skills.exportToMarkdown(skill),
    };
  }

  /**
   * Export all learning data
   */
  exportLearning(): LearningData {
    return this.learning.exportLearningData();
  }

  /**
   * Register task executor for agent type
   */
  registerExecutor(
    agentType: z.infer<typeof AgentTypeSchema>,
    executor: import("./agents/orchestrator.js").TaskExecutor,
  ) {
    this.orchestrator.registerExecutor(agentType, executor);
  }

  /**
   * Audit skill for security vulnerabilities
   */
  async auditSkill(
    skillPath: string,
  ): Promise<import("./security/skill-auditor.js").SkillAuditResult> {
    return this.skillAuditor.auditSkill(skillPath);
  }

  /**
   * Import skill with mandatory security audit
   */
  async importSkill(
    skillPath: string,
    options?: import("./security/skill-auditor.js").SafeImportOptions,
  ) {
    return this.skillImporter.importSkill(skillPath, options);
  }

  /**
   * Import skill from GitHub with audit
   */
  async importSkillFromGitHub(repositoryUrl: string, options?: { allowMedium?: boolean }) {
    return this.skillCollections.importFromGitHub(repositoryUrl, options);
  }

  /**
   * Import recommended skills collection
   */
  async importRecommendedSkills(options?: { allowMedium?: boolean }) {
    return this.skillCollections.importRecommended(options);
  }

  /**
   * Browse available skill collections
   */
  async browseSkillCollections() {
    return this.skillCollections.browseCollections();
  }

  /**
   * List installed skills with audit status
   */
  async listInstalledSkills() {
    return this.skillCollections.listInstalled();
  }

  /**
   * Generate skill audit report
   */
  async generateSkillAuditReport(): Promise<string> {
    return this.skillCollections.generateAuditReport();
  }

  /**
   * Register NVIDIA models in the registry
   */
  private registerNVIDIAModels(): void {
    for (const cap of NVIDIA_MODEL_CAPABILITIES) {
      this.modelRegistry.registerModel({
        id: `nvidia-${cap.model.replace(/\//g, "-")}`,
        name: cap.displayName,
        provider: "nvidia-nim",
        version: "1.0.0",
        parameters: cap.parameters,
        contextWindow: cap.contextWindow,
        maxTokens: cap.maxTokens,
        capabilities: {
          reasoning: cap.reasoning,
          coding: cap.coding,
          analysis: cap.analysis,
          creativity: cap.creativity,
          instructionFollowing: cap.instruction,
          math: cap.math,
          multilingual: cap.multilingual,
          speed: cap.speed,
          reliability: 0.95,
          costEfficiency: 1.0,
        },
        features: {
          streaming: cap.supportsStreaming,
          thinking: cap.supportsThinking,
          vision: cap.supportsVision,
          tools: cap.supportsTools,
          jsonMode: true,
          functionCalling: cap.supportsTools,
        },
        metrics: {
          avgLatencyMs: 2000,
          avgTokensPerSecond: 50,
          successRate: 0.98,
          errorRate: 0.02,
          lastBenchmarked: new Date(),
        },
        specializations: {
          excelsAt: cap.bestFor.map((item: string) => item.replace(/ /g, "-")) as any,
          goodAt: [],
          poorAt: cap.avoidFor.map((item: string) => item.replace(/ /g, "-")) as any,
        },
        cost: {
          inputPer1kTokens: 0,
          outputPer1kTokens: 0,
          currency: "USD",
          isFree: true,
        },
        status: "active",
        priority: cap.speed > 0.8 ? 7 : cap.reasoning > 0.9 ? 10 : 8,
        description: `${cap.displayName} - ${cap.parameters} parameters`,
        bestUseCases: cap.bestFor,
        avoidUseCases: cap.avoidFor,
        notes: ["Free NVIDIA NIM model"],
      });
    }

    console.log(`[ECC Integration] Registered ${NVIDIA_MODEL_CAPABILITIES.length} NVIDIA models`);
  }

  /**
   * Generate text using NVIDIA NIM with intelligent routing
   */
  async generate(
    messages: Array<{ role: string; content: string }>,
    options?: {
      model?: string;
      temperature?: number;
      stream?: boolean;
      requireThinking?: boolean;
      preferSpeed?: boolean;
    },
  ) {
    // Use model router for intelligent selection if no model specified
    let model = options?.model;
    let routingReason: string | undefined;

    if (!model) {
      const routing = await this.modelRouter.routeRequest(messages, {
        requireThinking: options?.requireThinking,
        preferSpeed: options?.preferSpeed,
      });
      model = routing.model;
      routingReason = routing.reasoning;
    }

    const result = await this.nvidiaProvider.generate(messages, {
      model,
      temperature: options?.temperature,
      stream: options?.stream,
    });

    return {
      ...result,
      routingReason: routingReason ?? `Used specified model: ${model}`,
    };
  }

  /**
   * Stream generation from NVIDIA NIM
   */
  async *streamGenerate(
    messages: Array<{ role: string; content: string }>,
    options?: {
      model?: string;
      temperature?: number;
      requireThinking?: boolean;
    },
  ): AsyncGenerator<{
    content?: string;
    reasoning?: string;
    done: boolean;
  }> {
    // Use model router for selection
    let model = options?.model;
    if (!model) {
      const routing = await this.modelRouter.routeRequest(messages, {
        requireThinking: options?.requireThinking,
      });
      model = routing.model;
    }

    const stream = this.nvidiaProvider.streamGenerate(messages, {
      model,
      temperature: options?.temperature,
    });

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  /**
   * Get available models with capabilities
   */
  getAvailableModels() {
    return this.nvidiaProvider.getAvailableModels();
  }

  /**
   * Select best model for task
   */
  selectModelForTask(task: {
    type:
      | "reasoning"
      | "coding"
      | "analysis"
      | "creativity"
      | "instruction"
      | "math"
      | "multilingual"
      | "speed";
    complexity: "low" | "medium" | "high";
    contextLength?: number;
    requiresThinking?: boolean;
  }): string {
    return this.nvidiaProvider.selectBestModel(task);
  }

  /**
   * Get blueprint by ID
   */
  getBlueprint(id: string) {
    return this.blueprints.getBlueprint(id);
  }

  /**
   * List all available blueprints
   */
  listBlueprints() {
    return this.blueprints.getAllBlueprints();
  }

  /**
   * Execute a blueprint workflow
   */
  async executeBlueprint(
    blueprintId: string,
    inputs: Record<string, unknown>,
    config?: Record<string, unknown>,
  ) {
    return this.blueprints.executeBlueprint(blueprintId, inputs, config);
  }

  /**
   * Get blueprint documentation
   */
  getBlueprintDocumentation(blueprintId: string): string {
    return this.blueprints.generateDocumentation(blueprintId);
  }
}

interface SystemStatus {
  governance: {
    rulesActive: number;
    agents: number;
    tasks: number;
  };
  orchestration: {
    agents: Record<
      string,
      {
        total: number;
        idle: number;
        working: number;
        assigned: number;
      }
    >;
    queue: {
      total: number;
      byStatus: Record<string, number>;
    };
  };
  learning: {
    totalInstincts: number;
    totalSkills: number;
    avgConfidence: number;
  };
}

export default ECCIntegration;
