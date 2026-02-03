# Automation Type Layer Design

**Component:** Automation Type System
**Status:** Design Phase
**Author:** AI Design Session
**Date:** 2025-01-26

## Overview

The Automation Type Layer defines the interface and implementation patterns for specific automation types. Each automation type (e.g., Smart-Sync Fork) implements a common interface and is responsible for its specific domain logic. This layer handles validation, workspace preparation, execution orchestration, and cleanup.

## Architecture

### Directory Structure

```
src/automations/
├── types/
│   ├── base.ts                  # Base automation interface and abstract class
│   ├── registry.ts              # Automation type registration
│   ├── smart-sync-fork/
│   │   ├── index.ts             # Main implementation
│   │   ├── git-operations.ts    # Git command wrappers
│   │   ├── conflict-resolver.ts # AI conflict resolution orchestrator
│   │   ├── progress-tracker.ts  # Real-time progress updates
│   │   ├── ssh-manager.ts       # SSH key detection and management
│   │   └── types.ts             # Smart-Sync Fork specific types
│   └── [future automation types]/
├── workspace.ts                 # Workspace management utilities
└── session-manager.ts           # Agent session lifecycle management
```

## Base Automation Interface

### Core Interface Definition

```typescript
// src/automations/types/base.ts

/**
 * Base interface that all automation types must implement.
 * Defines the lifecycle and contract for automation execution.
 */
interface AutomationType<TConfig = any, TState = any> {
  // Type identifier (e.g., "smart-sync-fork")
  readonly type: string;

  // Display information
  readonly displayName: string;
  readonly description: string;
  readonly category: string; // e.g., "git", "maintenance", "monitoring"

  // Configuration schema (for UI validation)
  readonly configSchema: z.ZodType<TConfig>;

  // Lifecycle methods
  validate(config: TConfig): Promise<ValidationResult>;
  prepare(config: TConfig): Promise<PreparedContext>;
  execute(context: PreparedContext): Promise<ExecutionResult>;
  cleanup(context: PreparedContext): Promise<CleanupResult>;

  // Optional methods
  onCancel?(context: PreparedContext): Promise<void>;
  onProgress?(progress: ProgressUpdate): void;

  // UI helpers
  getDefaultConfig(): TConfig;
  getConfigDescriptor(): ConfigDescriptor;
}

// Supporting types

interface ValidationResult {
  valid: boolean;
  errors: Array<{
    field: string;
    message: string;
    severity: "error" | "warning";
  }>;
}

interface PreparedContext<TConfig = any, TState = any> {
  automationId: string;
  config: TConfig;
  sessionId: string;
  workspaceDir: string;
  state: TState;
  startTime: Date;
  logger: AutomationLogger;
}

interface ExecutionResult {
  status: "success" | "partial" | "failed";
  exitCode: number;
  duration: number; // milliseconds
  summary: string;
  artifacts: Artifact[];
  nextSteps?: NextStep[];
}

interface CleanupResult {
  workspaceRemoved: boolean;
  workspaceSize: number; // bytes
  tempFilesRemoved: number;
  errors: string[];
}

interface ProgressUpdate {
  automationId: string;
  sessionId: string;
  timestamp: Date;
  milestone: string;
  percentage: number; // 0-100
  details: Record<string, any>;
}

interface Artifact {
  type: "branch" | "pr" | "issue" | "file" | "url";
  name: string;
  value: string;
  url?: string;
}

interface NextStep {
  action: string;
  description: string;
  command?: string;
  url?: string;
}

interface ConfigDescriptor {
  fields: ConfigField[];
  advancedFields?: ConfigField[];
}

interface ConfigField {
  name: string;
  type: "text" | "url" | "select" | "multiselect" | "number" | "boolean" | "textarea" | "cron";
  label: string;
  description?: string;
  required: boolean;
  defaultValue?: any;
  options?: Array<{ value: any; label: string }>;
  validation?: RegExp | ((value: any) => boolean | string);
  placeholder?: string;
  secret?: boolean; // For passwords/tokens
}
```

### Abstract Base Class

```typescript
/**
 * Abstract base class providing common functionality for all automation types.
 * Implementations can extend this for convenience.
 */
abstract class BaseAutomation<TConfig = any, TState = any> implements AutomationType<
  TConfig,
  TState
> {
  abstract readonly type: string;
  abstract readonly displayName: string;
  abstract readonly description: string;
  abstract readonly category: string;
  abstract readonly configSchema: z.ZodType<TConfig>;

  constructor(
    protected logger: AutomationLogger,
    protected sessionManager: SessionManager,
  ) {}

  // Template method pattern - subclasses override specific steps
  async execute(context: PreparedContext<TConfig, TState>): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Pre-execution hook
      await this.beforeExecution(context);

      // Main execution (subclass implements)
      const result = await this.doExecute(context);

      // Post-execution hook
      await this.afterExecution(context, result);

      return {
        ...result,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return this.handleError(error, context, startTime);
    }
  }

  // Subclasses implement the actual work
  protected abstract doExecute(context: PreparedContext<TConfig, TState>): Promise<ExecutionResult>;

  // Hooks for subclasses to override
  protected async beforeExecution(context: PreparedContext): Promise<void> {
    this.logger.info(`Starting execution of ${this.type}`, {
      automationId: context.automationId,
      sessionId: context.sessionId,
    });
  }

  protected async afterExecution(context: PreparedContext, result: ExecutionResult): Promise<void> {
    this.logger.info(`Completed execution of ${this.type}`, {
      status: result.status,
      duration: result.duration,
    });
  }

  protected handleError(
    error: unknown,
    context: PreparedContext,
    startTime: number,
  ): ExecutionResult {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    this.logger.error(`Execution failed: ${message}`, { error });

    return {
      status: "failed",
      exitCode: 1,
      duration,
      summary: `Failed: ${message}`,
      artifacts: [],
      nextSteps: [
        {
          action: "Review logs",
          description: "Check the automation logs for detailed error information",
        },
      ],
    };
  }

  // Default implementations (can be overridden)
  async validate(config: TConfig): Promise<ValidationResult> {
    try {
      this.configSchema.parse(config);
      return { valid: true, errors: [] };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          valid: false,
          errors: error.errors.map((e) => ({
            field: e.path.join("."),
            message: e.message,
            severity: "error" as const,
          })),
        };
      }
      throw error;
    }
  }

  getDefaultConfig(): TConfig {
    return this.configSchema.parse({});
  }

  onCancel?(context: PreparedContext): Promise<void> {
    this.logger.warn("Automation cancelled by user", {
      automationId: context.automationId,
      sessionId: context.sessionId,
    });
  }
}
```

## Smart-Sync Fork Implementation

### Configuration Schema

```typescript
// src/automations/types/smart-sync-fork/types.ts

import { z } from "zod";

/**
 * Configuration schema for Smart-Sync Fork automation.
 * All fields are validated using Zod for type safety and UI generation.
 */
export const SmartSyncForkConfigSchema = z.object({
  // Repository configuration
  forkRepoUrl: z.string().url("Must be a valid git URL"),
  upstreamRepoUrl: z.string().url("Must be a valid git URL"),
  forkBranch: z.string().default("main"),
  upstreamBranch: z.string().default("main"),

  // Optional subdirectories
  forkSubdirectory: z.string().optional(),
  upstreamSubdirectory: z.string().optional(),

  // SSH key selection
  sshKeyPath: z.string().optional(), // Auto-detect if not specified

  // Branch configuration
  featureBranchPrefix: z.string().default("smart-sync/"),
  featureBranchName: z.string().optional(), // Custom branch name template

  // AI configuration
  aiModel: z.string().optional(), // Inherits from global default if not specified
  confidenceThreshold: z.number().min(0).max(100).default(90),

  // Uncertainty handling
  uncertaintyAction: z
    .enum(["report-at-end", "pause-and-ask", "skip-file"])
    .default("report-at-end"),

  // Auto-merge configuration
  autoMerge: z.boolean().default(false),
  autoMergeMethod: z.enum(["merge", "squash", "rebase"]).default("merge"),

  // Retry limits
  maxWrongPathCorrections: z.number().min(1).default(3),
  maxMinutesPerConflict: z.number().min(1).default(5),

  // Scheduling
  schedule: z
    .object({
      type: z.enum(["cron", "interval", "at"]),
      value: z.string(),
    })
    .required(),

  // Notifications
  notifyOnSuccess: z.boolean().default(true),
  notifyOnFailure: z.boolean().default(true),
  notifyOnAttention: z.boolean().default(true),
  notificationChannels: z.array(z.string()).default(["#cb-activity"]),

  // Advanced options
  shallowClone: z.boolean().default(true), // Use --depth=1 for initial clone
  gitTimeoutSeconds: z.number().min(10).default(300),
  preserveWorkspace: z.boolean().default(false), // Keep workspace after run (for debugging)
});

export type SmartSyncForkConfig = z.infer<typeof SmartSyncForkConfigSchema>;

/**
 * Runtime state for Smart-Sync Fork automation.
 * Tracked during execution for progress reporting and recovery.
 */
export interface SmartSyncForkState {
  // Git state
  workspaceInitialized: boolean;
  forkCloned: boolean;
  upstreamAdded: boolean;
  currentCommit: string;
  upstreamCommit: string;

  // Merge state
  mergeStarted: boolean;
  conflictsDetected: number;
  conflictsResolved: number;
  conflictsSkipped: number;
  currentFile?: string;

  // Resolution tracking
  uncertainResolutions: UncertainResolution[];
  wrongPathCorrections: number;
  totalConflicts: number;

  // Timing
  mergeStartTime?: Date;
  conflictStartTime?: Date;

  // Results
  branchCreated?: string;
  prCreated?: boolean;
  prNumber?: number;
  prUrl?: string;
  merged?: boolean;
}

export interface UncertainResolution {
  filePath: string;
  conflict: string;
  confidence: number;
  explanation: string;
  options: ResolutionOption[];
  selectedOption?: number;
  timestamp: Date;
}

export interface ResolutionOption {
  description: string;
  approach: string;
  risks: string[];
  codeSnippet?: string;
}
```

### Main Implementation

```typescript
// src/automations/types/smart-sync-fork/index.ts

import { BaseAutomation } from "../base";
import { SmartSyncForkConfig, SmartSyncForkState } from "./types";
import { GitOperations } from "./git-operations";
import { ConflictResolver } from "./conflict-resolver";
import { ProgressTracker } from "./progress-tracker";
import { SSHManager } from "./ssh-manager";

export class SmartSyncForkAutomation extends BaseAutomation<
  SmartSyncForkConfig,
  SmartSyncForkState
> {
  readonly type = "smart-sync-fork";
  readonly displayName = "Smart-Sync Fork";
  readonly description =
    "Automatically sync fork with upstream using AI-powered conflict resolution";
  readonly category = "git";
  readonly configSchema = SmartSyncForkConfigSchema;

  private git: GitOperations;
  private resolver: ConflictResolver;
  private progress: ProgressTracker;
  private ssh: SSHManager;

  constructor(
    logger: AutomationLogger,
    sessionManager: SessionManager,
    config: SmartSyncForkConfig,
  ) {
    super(logger, sessionManager);

    this.ssh = new SSHManager(logger, config);
    this.git = new GitOperations(logger, config, this.ssh);
    this.resolver = new ConflictResolver(logger, config, sessionManager);
    this.progress = new ProgressTracker(logger, config.automationId);
  }

  /**
   * Validate that the configuration is valid and prerequisites are met.
   */
  async validate(config: SmartSyncForkConfig): Promise<ValidationResult> {
    const baseResult = await super.validate(config);
    if (!baseResult.valid) {
      return baseResult;
    }

    const errors: ValidationResult["errors"] = [];

    // Validate SSH key availability
    const sshKey = await this.ssh.detectSSHKey(config.sshKeyPath);
    if (!sshKey) {
      errors.push({
        field: "sshKeyPath",
        message: "No SSH key found. Please ensure SSH keys are available in ~/.ssh/",
        severity: "error",
      });
    }

    // Validate repository URLs are accessible
    try {
      await this.git.validateRepoAccess(config.forkRepoUrl);
    } catch (error) {
      errors.push({
        field: "forkRepoUrl",
        message: `Cannot access fork repository: ${error.message}`,
        severity: "error",
      });
    }

    try {
      await this.git.validateRepoAccess(config.upstreamRepoUrl);
    } catch (error) {
      errors.push({
        field: "upstreamRepoUrl",
        message: `Cannot access upstream repository: ${error.message}`,
        severity: "error",
      });
    }

    // Validate cron expression
    if (config.schedule.type === "cron") {
      try {
        this.validateCronExpression(config.schedule.value);
      } catch (error) {
        errors.push({
          field: "schedule.value",
          message: `Invalid cron expression: ${error.message}`,
          severity: "error",
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Prepare workspace and initial state.
   */
  async prepare(
    config: SmartSyncForkConfig,
  ): Promise<PreparedContext<SmartSyncForkConfig, SmartSyncForkState>> {
    this.logger.info("Preparing Smart-Sync Fork workspace", { config });

    const automationId = this.generateAutomationId(config);
    const workspaceDir = await this.createWorkspace(automationId);
    const sessionId = await this.sessionManager.createSession(automationId);

    const initialState: SmartSyncForkState = {
      workspaceInitialized: false,
      forkCloned: false,
      upstreamAdded: false,
      currentCommit: "",
      upstreamCommit: "",
      mergeStarted: false,
      conflictsDetected: 0,
      conflictsResolved: 0,
      conflictsSkipped: 0,
      uncertainResolutions: [],
      wrongPathCorrections: 0,
      totalConflicts: 0,
    };

    await this.progress.initialize(sessionId, config);

    return {
      automationId,
      config,
      sessionId,
      workspaceDir,
      state: initialState,
      startTime: new Date(),
      logger: this.logger,
    };
  }

  /**
   * Execute the main automation logic.
   */
  protected async doExecute(
    context: PreparedContext<SmartSyncForkConfig, SmartSyncForkState>,
  ): Promise<ExecutionResult> {
    const { config, workspaceDir, state, sessionId } = context;

    try {
      // Phase 1: Initialize workspace
      await this.progress.update(sessionId, {
        milestone: "Initializing workspace",
        percentage: 5,
        details: { workspaceDir },
      });
      await this.initializeWorkspace(context);

      // Phase 2: Fetch upstream
      await this.progress.update(sessionId, {
        milestone: "Fetching upstream changes",
        percentage: 15,
      });
      await this.fetchUpstream(context);

      // Phase 3: Detect conflicts
      await this.progress.update(sessionId, {
        milestone: "Detecting merge conflicts",
        percentage: 25,
      });
      const conflicts = await this.detectConflicts(context);

      if (conflicts.length === 0) {
        return await this.handleNoConflicts(context);
      }

      state.totalConflicts = conflicts.length;
      state.mergeStartTime = new Date();

      // Phase 4: Resolve conflicts
      await this.progress.update(sessionId, {
        milestone: `Resolving ${conflicts.length} conflict(s)`,
        percentage: 35,
        details: { totalConflicts: conflicts.length },
      });

      const resolutionResult = await this.resolveConflicts(context, conflicts);

      if (!resolutionResult.success) {
        return await this.handlePartialResolution(context, resolutionResult);
      }

      // Phase 5: Push changes
      await this.progress.update(sessionId, {
        milestone: "Pushing feature branch",
        percentage: 85,
      });
      await this.pushChanges(context);

      // Phase 6: Create PR
      await this.progress.update(sessionId, {
        milestone: "Creating pull request",
        percentage: 90,
      });
      const pr = await this.createPullRequest(context);

      // Phase 7: Auto-merge if enabled
      if (config.autoMerge && resolutionResult.allResolved) {
        await this.progress.update(sessionId, {
          milestone: "Auto-merging pull request",
          percentage: 95,
        });
        await this.autoMerge(context, pr.number);
      }

      await this.progress.update(sessionId, {
        milestone: "Complete",
        percentage: 100,
      });

      return this.buildSuccessResult(context, pr, resolutionResult);
    } catch (error) {
      return this.buildFailureResult(context, error);
    }
  }

  /**
   * Clean up workspace and resources.
   */
  async cleanup(
    context: PreparedContext<SmartSyncForkConfig, SmartSyncForkState>,
  ): Promise<CleanupResult> {
    const { workspaceDir, config } = context;

    if (config.preserveWorkspace) {
      this.logger.info("Preserving workspace for debugging", { workspaceDir });
      return {
        workspaceRemoved: false,
        workspaceSize: 0,
        tempFilesRemoved: 0,
        errors: [],
      };
    }

    try {
      const size = await this.getDirectorySize(workspaceDir);
      await fs.rm(workspaceDir, { recursive: true, force: true });

      return {
        workspaceRemoved: true,
        workspaceSize: size,
        tempFilesRemoved: 0, // TODO: Track temp files
        errors: [],
      };
    } catch (error) {
      this.logger.error("Failed to cleanup workspace", { error, workspaceDir });
      return {
        workspaceRemoved: false,
        workspaceSize: 0,
        tempFilesRemoved: 0,
        errors: [error.message],
      };
    }
  }

  /**
   * Handle cancellation request.
   */
  async onCancel(context: PreparedContext<SmartSyncForkConfig, SmartSyncForkState>): Promise<void> {
    await super.onCancel?.(context);

    // Kill any running git processes
    await this.git.killProcesses();

    // Clean up workspace immediately
    await this.cleanup(context);
  }

  // Private helper methods (omitted for brevity, would include:)
  // - initializeWorkspace()
  // - fetchUpstream()
  // - detectConflicts()
  // - resolveConflicts()
  // - pushChanges()
  // - createPullRequest()
  // - autoMerge()
  // - buildSuccessResult()
  // - buildFailureResult()
  // etc.
}
```

## AI Conflict Resolution Orchestrator

```typescript
// src/automations/types/smart-sync-fork/conflict-resolver.ts

/**
 * Orchestrates AI-powered merge conflict resolution.
 * Handles confidence checking, uncertainty handling, and retry logic.
 */
export class ConflictResolver {
  constructor(
    private logger: AutomationLogger,
    private config: SmartSyncForkConfig,
    private sessionManager: SessionManager,
  ) {}

  /**
   * Resolve all merge conflicts using AI.
   */
  async resolveConflicts(
    context: PreparedContext,
    conflicts: ConflictInfo[],
  ): Promise<ResolutionResult> {
    const { state, config } = context;
    const results: FileResolution[] = [];
    let allResolved = true;

    for (const conflict of conflicts) {
      state.currentFile = conflict.filePath;
      state.conflictStartTime = new Date();

      // Check retry limits
      if (this.exceededRetryLimits(state)) {
        this.logger.warn("Exceeded retry limits, pausing", {
          wrongPathCorrections: state.wrongPathCorrections,
          totalTime: this.getConflictDuration(state),
        });
        allResolved = false;
        break;
      }

      // Attempt resolution
      const resolution = await this.resolveConflict(context, conflict);

      if (resolution.success) {
        results.push(resolution);
        state.conflictsResolved++;
      } else if (resolution.uncertain) {
        // Handle based on uncertainty action
        if (config.uncertaintyAction === "pause-and-ask") {
          allResolved = false;
          break;
        } else {
          // Record for end report
          state.uncertainResolutions.push({
            filePath: conflict.filePath,
            conflict: conflict.content,
            confidence: resolution.confidence,
            explanation: resolution.explanation,
            options: resolution.options,
            timestamp: new Date(),
          });
        }
      } else {
        // Failed to resolve
        allResolved = false;
        break;
      }
    }

    return {
      success: allResolved,
      allResolved,
      resolutions: results,
      uncertainCount: state.uncertainResolutions.length,
      failedCount: conflicts.length - results.length,
    };
  }

  /**
   * Resolve a single conflict using AI.
   */
  private async resolveConflict(
    context: PreparedContext,
    conflict: ConflictInfo,
  ): Promise<FileResolution> {
    const { config, sessionId } = context;

    // Prepare prompt for AI
    const prompt = this.buildConflictResolutionPrompt(conflict);

    // Send to AI agent
    const response = await this.sessionManager.sendMessage(sessionId, prompt);

    // Parse response and assess confidence
    const assessment = this.assessResolution(response, conflict);

    // Check confidence threshold
    if (assessment.confidence < config.confidenceThreshold) {
      return {
        success: false,
        uncertain: true,
        confidence: assessment.confidence,
        explanation: assessment.explanation,
        options: this.generateAlternativeOptions(conflict, assessment),
      };
    }

    // Apply resolution
    try {
      await this.applyResolution(conflict, assessment.resolution);
      return {
        success: true,
        uncertain: false,
        confidence: assessment.confidence,
        explanation: assessment.explanation,
      };
    } catch (error) {
      // Track as "wrong path" correction if AI realizes mistake
      if (await this.isWrongPathCorrection(response, error)) {
        context.state.wrongPathCorrections++;
      }
      throw error;
    }
  }

  /**
   * Build prompt for AI conflict resolution.
   */
  private buildConflictResolutionPrompt(conflict: ConflictInfo): string {
    return `
You are resolving a git merge conflict in the file: ${conflict.filePath}

Context:
- This is a fork syncing with upstream
- Preserve local changes that are intentional
- Integrate upstream changes appropriately
- Ask for clarification if uncertain

Conflict markers (leading space to avoid literal markers in this doc):
 <<<<<<< HEAD
 ${conflict.ourContent}
 =======
 ${conflict.theirContent}
 >>>>>>> upstream

Please:
1. Analyze the conflict
2. Determine the appropriate resolution
3. Provide your confidence (0-100%)
4. Explain your reasoning
5. If uncertain, describe why and provide 2-3 alternative approaches

Respond in JSON format:
{
  "resolution": "resolved content here",
  "confidence": 95,
  "explanation": "detailed reasoning",
  "uncertain": false,
  "options": [
    {
      "description": "alternative approach 1",
      "approach": "how to implement",
      "risks": ["potential risk 1", "risk 2"]
    }
  ]
}
    `.trim();
  }

  /**
   * Assess AI's resolution for confidence and correctness.
   */
  private assessResolution(response: AIResponse, conflict: ConflictInfo): ResolutionAssessment {
    // Parse AI response
    const result = JSON.parse(response.content);

    // Assess confidence
    let confidence = result.confidence || 0;

    // Adjust confidence based on heuristics
    if (conflict.filePath.includes("package.json") || conflict.filePath.includes("lockfile")) {
      // Package files require extra caution
      confidence = Math.min(confidence, 85);
    }

    if (conflict.complexity > 10) {
      // Complex conflicts (many hunks) are harder
      confidence *= 0.9;
    }

    return {
      confidence: Math.round(confidence),
      explanation: result.explanation,
      resolution: result.resolution,
      uncertain: result.uncertain || confidence < this.config.confidenceThreshold,
      options: result.options || [],
    };
  }

  /**
   * Check if retry limits have been exceeded.
   */
  private exceededRetryLimits(state: SmartSyncForkState): boolean {
    // Check wrong path corrections
    if (state.wrongPathCorrections >= this.config.maxWrongPathCorrections) {
      return true;
    }

    // Check time per conflict
    if (state.conflictStartTime) {
      const elapsed = Date.now() - state.conflictStartTime.getTime();
      if (elapsed > this.config.maxMinutesPerConflict * 60 * 1000) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate alternative resolution options for uncertain conflicts.
   */
  private generateAlternativeOptions(
    conflict: ConflictInfo,
    assessment: ResolutionAssessment,
  ): ResolutionOption[] {
    const options: ResolutionOption[] = [];

    // Option 1: Accept all upstream changes
    options.push({
      description: "Accept all upstream changes",
      approach: "Use the upstream version entirely",
      risks: ["May lose local customizations"],
      codeSnippet: conflict.theirContent,
    });

    // Option 2: Accept all local changes
    options.push({
      description: "Keep all local changes",
      approach: "Use the local version entirely",
      risks: ["May miss important upstream updates"],
      codeSnippet: conflict.ourContent,
    });

    // Option 3: Manual merge guidance
    options.push({
      description: "Manual merge with guidance",
      approach: assessment.explanation,
      risks: ["Requires human judgment"],
    });

    return options;
  }

  // Additional helper methods...
}

interface ConflictInfo {
  filePath: string;
  ourContent: string;
  theirContent: string;
  content: string; // Full conflict with markers
  complexity: number; // Number of conflict hunks
}

interface FileResolution {
  success: boolean;
  uncertain: boolean;
  confidence: number;
  explanation: string;
  options?: ResolutionOption[];
}

interface ResolutionResult {
  success: boolean;
  allResolved: boolean;
  resolutions: FileResolution[];
  uncertainCount: number;
  failedCount: number;
}

interface ResolutionAssessment {
  confidence: number;
  explanation: string;
  resolution: string;
  uncertain: boolean;
  options: ResolutionOption[];
}

interface AIResponse {
  content: string;
  model: string;
  timestamp: Date;
}
```

## Automation Type Registry

```typescript
// src/automations/types/registry.ts

/**
 * Registry for all automation types.
 * Allows dynamic discovery and instantiation of automations.
 */
class AutomationTypeRegistry {
  private types = new Map<string, AutomationType>();

  register(type: AutomationType): void {
    if (this.types.has(type.type)) {
      throw new Error(`Automation type "${type.type}" already registered`);
    }
    this.types.set(type.type, type);
  }

  get(typeId: string): AutomationType | undefined {
    return this.types.get(typeId);
  }

  list(): AutomationType[] {
    return Array.from(this.types.values());
  }

  getByCategory(category: string): AutomationType[] {
    return this.list().filter((t) => t.category === category);
  }
}

// Global registry instance
export const registry = new AutomationTypeRegistry();

// Register built-in types
import { SmartSyncForkAutomation } from "./smart-sync-fork";

// Note: Actual instances created with config at runtime
export const builtInTypes = [
  { class: SmartSyncForkAutomation, category: "git" },
  // Future types will be added here
];
```

## Testing Strategy

### Unit Tests

- Configuration validation with various inputs
- SSH key detection logic
- Git operation wrappers (mocked)
- Confidence assessment heuristics
- Retry limit calculations

### Integration Tests

- Full automation lifecycle with test repositories
- Conflict resolution with simulated AI responses
- Progress tracking and state updates
- Error recovery and cleanup

### End-to-End Tests

- Real repositories with real conflicts
- Actual AI model integration
- PR creation and merging
- Notification delivery

## Security Considerations

### SSH Key Handling

- Keys never leave the filesystem
- Only key paths are stored in config
- Passphrase-protected keys require agent prompt
- Key permissions validated before use

### Git Operations

- All git commands run in isolated workspace
- No access to files outside workspace
- Git credentials handled via system SSH agent
- No tokens or passwords in logs

### AI Interactions

- No sensitive code sent to AI (conflict content only)
- Confidence threshold prevents low-confidence changes
- All AI responses logged for audit
- Human-in-the-loop for uncertain resolutions

## Future Enhancements

### Additional Automation Types

- **Dependency Updater:** Auto-update dependencies and run tests
- **Release Notes Generator:** Generate changelog from commits
- **Code Quality Runner:** Run linters, formatters, tests
- **Backup/Snapshot:** Automated repository backups

### Enhanced Conflict Resolution

- **Learning from history:** Remember past resolutions
- **Semantic merge:** Language-aware conflict resolution
- **Test validation:** Run tests after resolution to verify
- **Manual intervention queue:** Queue uncertain conflicts for human review
