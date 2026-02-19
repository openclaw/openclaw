/**
 * Dynamic Reasoning - 动态推理引擎
 *
 * 根据任务难度动态调整推理级别
 * 返回可执行指令影响系统行为
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import type { AnyAgentTool } from "./tools/common.js";
import { jsonResult, readStringParam } from "./tools/common.js";

const log = createSubsystemLogger("reasoning");

export type ReasoningLevel = "fast" | "balanced" | "deep";

export type TaskDifficulty = {
  level: ReasoningLevel;
  score: number;
  factors: DifficultyFactor[];
  estimatedTokens: number;
};

export type DifficultyFactor = {
  name: string;
  score: number;
  weight: number;
};

type ReasoningInstruction = {
  suggestedThinkingLevel: "off" | "low" | "medium" | "high";
  useTaskDecompose: boolean;
  useReflection: boolean;
  useMemorySearch: boolean;
  useWebSearch: boolean;
  maxIterations: number;
  verifyResults: boolean;
};

type ReasoningGuidance = {
  approach: string;
  actions: string[];
  tips: string[];
  instruction: ReasoningInstruction;
};

export class DynamicReasoningEngine {
  private readonly config: {
    fastThreshold: number;
    balancedThreshold: number;
  };

  constructor(config?: { fastThreshold?: number; balancedThreshold?: number }) {
    this.config = {
      fastThreshold: config?.fastThreshold ?? 0.3,
      balancedThreshold: config?.balancedThreshold ?? 0.6,
    };
  }

  async assessTaskDifficulty(task: string): Promise<TaskDifficulty> {
    const factors: DifficultyFactor[] = [];

    const complexity = this.analyzeComplexity(task);
    factors.push(complexity);

    const ambiguity = this.detectAmbiguity(task);
    factors.push(ambiguity);

    const domainKnowledge = this.estimateDomainKnowledge(task);
    factors.push(domainKnowledge);

    const steps = this.estimateSteps(task);
    factors.push(steps);

    const totalScore = factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0);

    const normalizedScore = Math.max(0, Math.min(1, totalScore));

    let level: ReasoningLevel;
    if (normalizedScore < this.config.fastThreshold) {
      level = "fast";
    } else if (normalizedScore < this.config.balancedThreshold) {
      level = "balanced";
    } else {
      level = "deep";
    }

    const estimatedTokens = this.estimateTokens(normalizedScore, task.length);

    return {
      level,
      score: Math.round(normalizedScore * 1000) / 1000,
      factors,
      estimatedTokens,
    };
  }

  private analyzeComplexity(task: string): DifficultyFactor {
    const length = task.length;
    const sentences = task.split(/[.!?]+/).filter((s) => s.trim()).length;
    const hasStructure = /```|^\s*[-*]|^\s*\d+\./.test(task);
    const hasMultipleRequirements = /and |also | additionally | furthermore/i.test(task);

    let score = 0;

    if (length > 500) {
      score += 0.3;
    } else if (length > 200) {
      score += 0.2;
    } else if (length > 50) {
      score += 0.1;
    }

    if (sentences > 5) {
      score += 0.2;
    } else if (sentences > 2) {
      score += 0.1;
    }

    if (hasStructure) {
      score += 0.2;
    }

    if (hasMultipleRequirements) {
      score += 0.2;
    }

    return {
      name: "complexity",
      score: Math.min(1, score),
      weight: 0.35,
    };
  }

  private detectAmbiguity(task: string): DifficultyFactor {
    const ambiguousWords = [
      "maybe",
      "perhaps",
      "possibly",
      "might",
      "could",
      "unsure",
      "uncertain",
      "ambiguous",
      "vague",
      "best",
      "optimal",
      "better",
    ];

    const hasQuestionWords = /what|how|why|when|where|which/i.test(task);
    const hasAmbiguousTerms = ambiguousWords.some((word) =>
      new RegExp(`\\b${word}\\b`, "i").test(task),
    );
    const lacksSpecifics = !/\d+|name|specific|exact|concrete/i.test(task);

    let score = 0;
    if (hasAmbiguousTerms) {
      score += 0.4;
    }
    if (hasQuestionWords && lacksSpecifics) {
      score += 0.3;
    }
    if (lacksSpecifics) {
      score += 0.2;
    }

    return {
      name: "ambiguity",
      score: Math.min(1, score),
      weight: 0.25,
    };
  }

  private estimateDomainKnowledge(task: string): DifficultyFactor {
    const technicalTerms = [
      "api",
      "database",
      "algorithm",
      "deployment",
      "kubernetes",
      "docker",
      "quantum",
      "molecular",
      "neural",
      "optimization",
      "legal",
      "medical",
      "financial",
      "regulatory",
      "compliance",
    ];

    const hasTechnicalTerms = technicalTerms.some((term) =>
      new RegExp(`\\b${term}\\b`, "i").test(task),
    );

    const hasDomainContext = /in the context of |for |specific to |domain/i.test(task);
    const requiresExpertise = /expert |professional |advanced |specialized/i.test(task);

    let score = 0;
    if (hasTechnicalTerms) {
      score += 0.4;
    }
    if (hasDomainContext) {
      score += 0.3;
    }
    if (requiresExpertise) {
      score += 0.3;
    }

    return {
      name: "domain_knowledge",
      score: Math.min(1, score),
      weight: 0.25,
    };
  }

  private estimateSteps(task: string): DifficultyFactor {
    const stepIndicators = [
      "first",
      "then",
      "next",
      "finally",
      "step",
      "phase",
      "stage",
      "before",
      "after",
      "while",
    ];

    const count = stepIndicators.filter((indicator) =>
      new RegExp(`\\b${indicator}\\b`, "i").test(task),
    ).length;

    const hasSequence = /create.*then|build.*and|design.*implement/i.test(task);

    let score = 0;
    if (count >= 5) {
      score = 1.0;
    } else if (count >= 3) {
      score = 0.7;
    } else if (count >= 1 || hasSequence) {
      score = 0.4;
    } else {
      score = 0.1;
    }

    return {
      name: "steps",
      score,
      weight: 0.15,
    };
  }

  private estimateTokens(difficultyScore: number, taskLength: number): number {
    const inputTokens = Math.ceil(taskLength / 4);

    let outputMultiplier: number;
    if (difficultyScore < this.config.fastThreshold) {
      outputMultiplier = 1;
    } else if (difficultyScore < this.config.balancedThreshold) {
      outputMultiplier = 2;
    } else {
      outputMultiplier = 4;
    }

    return inputTokens + inputTokens * outputMultiplier;
  }
}

function getReasoningInstruction(level: ReasoningLevel): ReasoningInstruction {
  switch (level) {
    case "fast":
      return {
        suggestedThinkingLevel: "off",
        useTaskDecompose: false,
        useReflection: false,
        useMemorySearch: false,
        useWebSearch: false,
        maxIterations: 1,
        verifyResults: false,
      };
    case "balanced":
      return {
        suggestedThinkingLevel: "low",
        useTaskDecompose: true,
        useReflection: false,
        useMemorySearch: true,
        useWebSearch: false,
        maxIterations: 2,
        verifyResults: true,
      };
    case "deep":
      return {
        suggestedThinkingLevel: "medium",
        useTaskDecompose: true,
        useReflection: true,
        useMemorySearch: true,
        useWebSearch: true,
        maxIterations: 3,
        verifyResults: true,
      };
  }
}

function getReasoningGuidance(level: ReasoningLevel): ReasoningGuidance {
  const instruction = getReasoningInstruction(level);

  switch (level) {
    case "fast":
      return {
        approach: "Quick, direct response. Handle efficiently without extensive planning.",
        actions: [
          "Proceed directly with the answer",
          "Use available context without additional searches",
          "Keep response concise",
        ],
        tips: [
          "Focus on the core request",
          "Skip verbose explanations",
          "No need for verification steps",
        ],
        instruction,
      };
    case "balanced":
      return {
        approach: "Moderate planning. Use memory search and verify key points.",
        actions: [
          instruction.useMemorySearch ? "Run memory_search for relevant context" : null,
          instruction.useTaskDecompose ? "Consider task_decompose if multi-step" : null,
          instruction.verifyResults ? "Verify critical information" : null,
        ].filter(Boolean) as string[],
        tips: [
          "Balance thoroughness with efficiency",
          "Check for edge cases",
          "Document important decisions",
        ],
        instruction,
      };
    case "deep":
      return {
        approach:
          "Comprehensive analysis. Plan carefully, search thoroughly, iterate as needed.",
        actions: [
          instruction.useTaskDecompose ? "Use task_decompose to break down requirements" : null,
          instruction.useMemorySearch ? "Run self_rag with confidence assessment" : null,
          instruction.useWebSearch ? "Use web_search for external context if needed" : null,
          instruction.useReflection ? "Consider agentic_workflow for iteration plan" : null,
          instruction.verifyResults ? "Verify each step before proceeding" : null,
        ].filter(Boolean) as string[],
        tips: [
          "Take time to understand full context",
          "Consider multiple approaches",
          "Document reasoning for complex decisions",
          "Be prepared to iterate",
        ],
        instruction,
      };
  }
}

export function createDynamicReasoningTool(options?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options?.config;
  if (!cfg) {
    return null;
  }

  resolveSessionAgentId({
    sessionKey: options?.agentSessionKey,
    config: cfg,
  });

  return {
    name: "dynamic_reasoning",
    label: "Dynamic Reasoning",
    description:
      "Analyze task difficulty and get actionable strategy. Returns complexity assessment with specific instructions for thinking level, tool usage, and iteration strategy.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task description to analyze",
        },
      },
      required: ["task"],
    },
    execute: async (_toolCallId, params) => {
      const task = readStringParam(params, "task", { required: true });

      log.debug(`dynamic_reasoning: analyzing task "${task.substring(0, 50)}..."`);

      const engine = new DynamicReasoningEngine();
      const assessment = await engine.assessTaskDifficulty(task);
      const guidance = getReasoningGuidance(assessment.level);

      log.debug(
        `dynamic_reasoning: level=${assessment.level}, score=${assessment.score.toFixed(2)}, thinking=${guidance.instruction.suggestedThinkingLevel}`,
      );

      return jsonResult({
        assessment: {
          level: assessment.level,
          score: assessment.score,
          factors: assessment.factors.map((f) => ({
            name: f.name,
            score: Math.round(f.score * 1000) / 1000,
            weight: f.weight,
          })),
          estimatedTokens: assessment.estimatedTokens,
        },
        guidance: {
          approach: guidance.approach,
          actions: guidance.actions,
          tips: guidance.tips,
        },
        instruction: {
          thinkingLevel: guidance.instruction.suggestedThinkingLevel,
          tools: {
            taskDecompose: guidance.instruction.useTaskDecompose,
            reflection: guidance.instruction.useReflection,
            memorySearch: guidance.instruction.useMemorySearch,
            webSearch: guidance.instruction.useWebSearch,
          },
          maxIterations: guidance.instruction.maxIterations,
          verifyResults: guidance.instruction.verifyResults,
        },
        task,
      });
    },
  };
}
