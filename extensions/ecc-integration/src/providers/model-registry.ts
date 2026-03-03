/**
 * Model Registry & Capability Analysis System
 * 
 * Manages model capabilities, benchmarks, and optimal routing decisions.
 * Analyzes each model's strengths and weaknesses for intelligent task assignment.
 * 
 * Features:
 * - Model capability profiling
 * - Benchmark tracking
 * - Performance analytics
 * - Optimal model selection
 * - Multi-model orchestration
 */

import { z } from 'zod';

// ============================================================================
// Types & Schemas
// ============================================================================

export const ModelProviderSchema = z.enum([
  'nvidia-nim',
  'openai',
  'anthropic',
  'google',
  'local',
  'custom'
]);

export const TaskCategorySchema = z.enum([
  'code-generation',
  'code-review',
  'architecture-design',
  'debugging',
  'documentation',
  'analysis',
  'reasoning',
  'creative-writing',
  'chat',
  'math',
  'translation',
  'summarization',
  'question-answering',
  'planning',
  'security-audit',
  'testing'
]);

export interface ModelProfile {
  id: string;
  name: string;
  provider: z.infer<typeof ModelProviderSchema>;
  version: string;
  
  // Technical specs
  parameters: string;
  contextWindow: number;
  maxTokens: number;
  quantization?: string;
  
  // Capability scores (0-1)
  capabilities: {
    reasoning: number;
    coding: number;
    analysis: number;
    creativity: number;
    instructionFollowing: number;
    math: number;
    multilingual: number;
    speed: number;  // Response speed (higher = faster)
    reliability: number;  // Uptime/consistency
    costEfficiency: number;  // Value per token
  };
  
  // Feature support
  features: {
    streaming: boolean;
    thinking: boolean;
    vision: boolean;
    tools: boolean;
    jsonMode: boolean;
    functionCalling: boolean;
  };
  
  // Performance metrics
  metrics: {
    avgLatencyMs: number;
    avgTokensPerSecond: number;
    successRate: number;
    errorRate: number;
    lastBenchmarked: Date;
  };
  
  // Task specializations
  specializations: {
    excelsAt: z.infer<typeof TaskCategorySchema>[];
    goodAt: z.infer<typeof TaskCategorySchema>[];
    poorAt: z.infer<typeof TaskCategorySchema>[];
  };
  
  // Cost info
  cost: {
    inputPer1kTokens: number;
    outputPer1kTokens: number;
    currency: string;
    isFree: boolean;
  };
  
  // Status
  status: 'active' | 'deprecated' | 'experimental' | 'offline';
  priority: number;  // Routing priority (higher = preferred)
  
  // Metadata
  description: string;
  bestUseCases: string[];
  avoidUseCases: string[];
  notes: string[];
}

export interface BenchmarkResult {
  modelId: string;
  taskCategory: z.infer<typeof TaskCategorySchema>;
  timestamp: Date;
  
  // Quality scores
  accuracy: number;  // 0-1
  relevance: number;  // 0-1
  completeness: number;  // 0-1
  coherence: number;  // 0-1
  
  // Performance metrics
  timeToFirstTokenMs: number;
  totalTimeMs: number;
  tokensGenerated: number;
  tokensPerSecond: number;
  
  // Resource usage
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  
  // Human evaluation (if available)
  humanRating?: number;  // 1-5
  evaluatorNotes?: string;
}

export interface RoutingStrategy {
  name: string;
  description: string;
  selector: (task: TaskSpec, models: ModelProfile[]) => string;
}

export interface TaskSpec {
  id: string;
  category: z.infer<typeof TaskCategorySchema>;
  description: string;
  complexity: 'low' | 'medium' | 'high';
  contextLength: number;
  requiresStreaming: boolean;
  requiresThinking: boolean;
  requiresVision: boolean;
  requiresTools: boolean;
  preferredProviders?: string[];
  maxLatencyMs?: number;
  minQualityScore?: number;
}

export interface ModelPerformanceReport {
  modelId: string;
  period: { start: Date; end: Date };
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgQualityScore: number;
  costIncurred: number;
  topTasks: Array<{ category: string; count: number; avgScore: number }>;
  weaknesses: Array<{ category: string; avgScore: number; recommendation: string }>;
}

// ============================================================================
// Model Registry Class
// ============================================================================

export class ModelRegistry {
  private models: Map<string, ModelProfile>;
  private benchmarks: Map<string, BenchmarkResult[]>;
  private routingStrategies: Map<string, RoutingStrategy>;
  private defaultStrategy: string;

  constructor() {
    this.models = new Map();
    this.benchmarks = new Map();
    this.routingStrategies = new Map();
    this.defaultStrategy = 'balanced';
    
    this.initializeDefaultStrategies();
  }

  /**
   * Register a new model
   */
  registerModel(profile: ModelProfile): void {
    this.models.set(profile.id, profile);
    this.benchmarks.set(profile.id, []);
    console.log(`[ModelRegistry] Registered: ${profile.name} (${profile.provider})`);
  }

  /**
   * Get model by ID
   */
  getModel(id: string): ModelProfile | undefined {
    return this.models.get(id);
  }

  /**
   * Get all registered models
   */
  getAllModels(): ModelProfile[] {
    return Array.from(this.models.values());
  }

  /**
   * Get models by provider
   */
  getModelsByProvider(provider: z.infer<typeof ModelProviderSchema>): ModelProfile[] {
    return this.getAllModels().filter(m => m.provider === provider);
  }

  /**
   * Get active models only
   */
  getActiveModels(): ModelProfile[] {
    return this.getAllModels().filter(m => m.status === 'active');
  }

  /**
   * Get models by task category
   */
  getModelsForTask(category: z.infer<typeof TaskCategorySchema>): ModelProfile[] {
    return this.getActiveModels()
      .filter(m => 
        m.specializations.excelsAt.includes(category) ||
        m.specializations.goodAt.includes(category)
      )
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Record benchmark result
   */
  recordBenchmark(result: BenchmarkResult): void {
    const benchmarks = this.benchmarks.get(result.modelId) || [];
    benchmarks.push(result);
    this.benchmarks.set(result.modelId, benchmarks);
    
    // Update model metrics
    this.updateModelMetrics(result.modelId);
  }

  /**
   * Select best model for task
   */
  selectModelForTask(
    task: TaskSpec,
    strategy?: string
  ): { modelId: string; reasoning: string; confidence: number } {
    const strategyName = strategy || this.defaultStrategy;
    const routingStrategy = this.routingStrategies.get(strategyName);
    
    if (!routingStrategy) {
      throw new Error(`Unknown routing strategy: ${strategyName}`);
    }

    // Filter models by requirements
    const candidates = this.filterCandidates(task);
    
    if (candidates.length === 0) {
      throw new Error('No models meet task requirements');
    }

    // Apply routing strategy
    const selectedId = routingStrategy.selector(task, candidates);
    const selected = this.models.get(selectedId)!;
    
    // Generate reasoning
    const reasoning = this.generateSelectionReasoning(task, selected, candidates);
    const confidence = this.calculateConfidence(task, selected);

    return { modelId: selectedId, reasoning, confidence };
  }

  /**
   * Create ensemble of models for complex tasks
   */
  createEnsemble(
    task: TaskSpec,
    options: {
      size?: number;
      diversity?: boolean;
    } = {}
  ): { primary: string; secondary: string[]; reasoning: string } {
    const size = options.size || 3;
    const candidates = this.filterCandidates(task);
    
    // Sort by suitability
    const ranked = this.rankModelsForTask(task, candidates);
    
    const primary = ranked[0]?.id;
    let secondary: string[];
    
    if (options.diversity) {
      // Select diverse models (different providers/strengths)
      secondary = this.selectDiverseModels(ranked.slice(1), size - 1);
    } else {
      // Select top performers
      secondary = ranked.slice(1, size).map(m => m.id);
    }

    const reasoning = `Ensemble: Primary=${primary} (${this.models.get(primary)?.name}), ` +
      `Secondary=[${secondary.map(id => this.models.get(id)?.name).join(', ')}] ` +
      `for ${task.category} task`;

    return { primary, secondary, reasoning };
  }

  /**
   * Generate performance report for model
   */
  generatePerformanceReport(
    modelId: string,
    period: { start: Date; end: Date }
  ): ModelPerformanceReport {
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }

    const benchmarks = (this.benchmarks.get(modelId) || [])
      .filter(b => b.timestamp >= period.start && b.timestamp <= period.end);

    if (benchmarks.length === 0) {
      return {
        modelId,
        period,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        avgQualityScore: 0,
        costIncurred: 0,
        topTasks: [],
        weaknesses: []
      };
    }

    // Calculate metrics
    const latencies = benchmarks.map(b => b.totalTimeMs).sort((a, b) => a - b);
    const qualityScores = benchmarks.map(b => 
      (b.accuracy + b.relevance + b.completeness + b.coherence) / 4
    );

    // Task category breakdown
    const taskMap = new Map<string, { count: number; scores: number[] }>();
    for (const b of benchmarks) {
      const existing = taskMap.get(b.taskCategory) || { count: 0, scores: [] };
      existing.count++;
      existing.scores.push((b.accuracy + b.relevance + b.completeness + b.coherence) / 4);
      taskMap.set(b.taskCategory, existing);
    }

    const topTasks = Array.from(taskMap.entries())
      .map(([category, data]) => ({
        category,
        count: data.count,
        avgScore: data.scores.reduce((a, b) => a + b, 0) / data.scores.length
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Find weaknesses (tasks with avg score < 0.7)
    const weaknesses = Array.from(taskMap.entries())
      .filter(([_, data]) => {
        const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
        return avg < 0.7;
      })
      .map(([category, data]) => ({
        category,
        avgScore: data.scores.reduce((a, b) => a + b, 0) / data.scores.length,
        recommendation: `Consider using alternative models for ${category} tasks`
      }));

    // Cost calculation
    const totalTokens = benchmarks.reduce((sum, b) => sum + b.totalTokens, 0);
    const costIncurred = model.cost.isFree ? 0 : 
      (totalTokens / 1000) * (model.cost.inputPer1kTokens + model.cost.outputPer1kTokens);

    return {
      modelId,
      period,
      totalRequests: benchmarks.length,
      successfulRequests: benchmarks.length, // Assuming all recorded are successful
      failedRequests: 0,
      avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1],
      p99LatencyMs: latencies[Math.floor(latencies.length * 0.99)] || latencies[latencies.length - 1],
      avgQualityScore: qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length,
      costIncurred,
      topTasks,
      weaknesses
    };
  }

  /**
   * Add custom routing strategy
   */
  addRoutingStrategy(strategy: RoutingStrategy): void {
    this.routingStrategies.set(strategy.name, strategy);
  }

  /**
   * Set default routing strategy
   */
  setDefaultStrategy(name: string): void {
    if (!this.routingStrategies.has(name)) {
      throw new Error(`Unknown strategy: ${name}`);
    }
    this.defaultStrategy = name;
  }

  /**
   * Compare two models
   */
  compareModels(modelId1: string, modelId2: string): {
    model1: ModelProfile;
    model2: ModelProfile;
    differences: Record<string, { model1: number; model2: number; winner: string }>;
    recommendation: string;
  } {
    const model1 = this.models.get(modelId1);
    const model2 = this.models.get(modelId2);
    
    if (!model1 || !model2) {
      throw new Error('One or both models not found');
    }

    const diffs: Record<string, { model1: number; model2: number; winner: string }> = {};
    
    for (const [cap, score1] of Object.entries(model1.capabilities)) {
      const score2 = model2.capabilities[cap as keyof typeof model2.capabilities];
      diffs[cap] = {
        model1: score1,
        model2: score2,
        winner: score1 > score2 ? model1.name : model2.name
      };
    }

    // Overall winner
    const model1Avg = Object.values(model1.capabilities).reduce((a, b) => a + b, 0) / 8;
    const model2Avg = Object.values(model2.capabilities).reduce((a, b) => a + b, 0) / 8;
    
    const recommendation = model1Avg > model2Avg + 0.1 
      ? `${model1.name} is generally superior`
      : model2Avg > model1Avg + 0.1
        ? `${model2.name} is generally superior`
        : 'Both models are comparable; choose based on specific task requirements';

    return { model1, model2, differences: diffs, recommendation };
  }

  /**
   * Update model capability scores based on benchmarks
   */
  private updateModelMetrics(modelId: string): void {
    const benchmarks = this.benchmarks.get(modelId) || [];
    if (benchmarks.length === 0) return;

    const model = this.models.get(modelId);
    if (!model) return;

    // Calculate average metrics
    const recent = benchmarks.slice(-100); // Last 100 benchmarks
    
    model.metrics.avgLatencyMs = recent.reduce((sum, b) => sum + b.totalTimeMs, 0) / recent.length;
    model.metrics.avgTokensPerSecond = recent.reduce((sum, b) => sum + b.tokensPerSecond, 0) / recent.length;
    model.metrics.successRate = 1.0; // Assume success if recorded
    model.metrics.errorRate = 0.0;
    model.metrics.lastBenchmarked = new Date();
  }

  /**
   * Filter candidate models based on task requirements
   */
  private filterCandidates(task: TaskSpec): ModelProfile[] {
    return this.getActiveModels().filter(m => {
      // Check context window
      if (m.contextWindow < task.contextLength) return false;
      
      // Check feature requirements
      if (task.requiresStreaming && !m.features.streaming) return false;
      if (task.requiresThinking && !m.features.thinking) return false;
      if (task.requiresVision && !m.features.vision) return false;
      if (task.requiresTools && !m.features.tools) return false;
      
      // Check latency requirement
      if (task.maxLatencyMs && m.metrics.avgLatencyMs > task.maxLatencyMs) return false;
      
      // Check preferred providers
      if (task.preferredProviders && !task.preferredProviders.includes(m.provider)) return false;
      
      return true;
    });
  }

  /**
   * Rank models for specific task
   */
  private rankModelsForTask(task: TaskSpec, candidates: ModelProfile[]): ModelProfile[] {
    return candidates
      .map(m => {
        // Calculate task-specific score
        let score = 0;
        
        switch (task.category) {
          case 'code-generation':
          case 'code-review':
          case 'debugging':
            score = m.capabilities.coding * 0.5 + m.capabilities.reasoning * 0.3 + m.capabilities.instructionFollowing * 0.2;
            break;
          case 'architecture-design':
            score = m.capabilities.reasoning * 0.4 + m.capabilities.coding * 0.3 + m.capabilities.analysis * 0.3;
            break;
          case 'analysis':
          case 'summarization':
            score = m.capabilities.analysis * 0.5 + m.capabilities.reasoning * 0.3 + m.capabilities.instructionFollowing * 0.2;
            break;
          case 'reasoning':
          case 'planning':
            score = m.capabilities.reasoning * 0.6 + m.capabilities.analysis * 0.2 + m.capabilities.instructionFollowing * 0.2;
            break;
          case 'creative-writing':
            score = m.capabilities.creativity * 0.5 + m.capabilities.instructionFollowing * 0.3 + m.capabilities.reasoning * 0.2;
            break;
          case 'math':
            score = m.capabilities.math * 0.5 + m.capabilities.reasoning * 0.3 + m.capabilities.coding * 0.2;
            break;
          case 'translation':
            score = m.capabilities.multilingual * 0.5 + m.capabilities.creativity * 0.3 + m.capabilities.instructionFollowing * 0.2;
            break;
          default:
            score = m.capabilities.instructionFollowing * 0.3 + m.capabilities.reasoning * 0.3 + m.capabilities.analysis * 0.2 + m.capabilities.coding * 0.2;
        }
        
        // Adjust for complexity
        if (task.complexity === 'high' && m.capabilities.reasoning < 0.8) {
          score *= 0.7;
        }
        
        // Boost for specialized models
        if (m.specializations.excelsAt.includes(task.category)) {
          score *= 1.2;
        }
        if (m.specializations.poorAt.includes(task.category)) {
          score *= 0.6;
        }
        
        return { model: m, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(r => r.model);
  }

  /**
   * Select diverse models for ensemble
   */
  private selectDiverseModels(candidates: ModelProfile[], count: number): string[] {
    const selected: ModelProfile[] = [];
    const usedProviders = new Set<string>();
    
    for (const model of candidates) {
      if (selected.length >= count) break;
      
      // Prefer different providers
      if (!usedProviders.has(model.provider) || selected.length < count) {
        selected.push(model);
        usedProviders.add(model.provider);
      }
    }
    
    return selected.map(m => m.id);
  }

  /**
   * Generate reasoning for model selection
   */
  private generateSelectionReasoning(
    task: TaskSpec,
    selected: ModelProfile,
    candidates: ModelProfile[]
  ): string {
    const parts: string[] = [];
    
    parts.push(`Selected ${selected.name} for ${task.category} task`);
    
    if (selected.specializations.excelsAt.includes(task.category)) {
      parts.push('(model excels at this task type)');
    }
    
    if (task.complexity === 'high') {
      parts.push(`High reasoning score: ${(selected.capabilities.reasoning * 100).toFixed(0)}%`);
    }
    
    if (task.contextLength > 50000) {
      parts.push(`Large context support: ${selected.contextWindow.toLocaleString()} tokens`);
    }
    
    parts.push(`Expected latency: ${selected.metrics.avgLatencyMs.toFixed(0)}ms`);
    
    const alternatives = candidates
      .filter(m => m.id !== selected.id)
      .slice(0, 2)
      .map(m => m.name);
    
    if (alternatives.length > 0) {
      parts.push(`Alternatives: ${alternatives.join(', ')}`);
    }
    
    return parts.join('; ');
  }

  /**
   * Calculate confidence score for selection
   */
  private calculateConfidence(task: TaskSpec, model: ModelProfile): number {
    let confidence = 0.7; // Base confidence
    
    // Boost for specialization
    if (model.specializations.excelsAt.includes(task.category)) {
      confidence += 0.15;
    }
    
    // Boost for high capability scores
    const relevantCap = this.getRelevantCapability(task.category);
    if (model.capabilities[relevantCap] > 0.9) {
      confidence += 0.1;
    }
    
    // Reduce for poor performance
    if (model.specializations.poorAt.includes(task.category)) {
      confidence -= 0.2;
    }
    
    // Adjust for reliability
    confidence *= model.capabilities.reliability;
    
    return Math.min(0.98, Math.max(0.5, confidence));
  }

  /**
   * Get most relevant capability for task category
   */
  private getRelevantCapability(category: z.infer<typeof TaskCategorySchema>): keyof ModelProfile['capabilities'] {
    const mapping: Record<string, keyof ModelProfile['capabilities']> = {
      'code-generation': 'coding',
      'code-review': 'coding',
      'architecture-design': 'reasoning',
      'debugging': 'coding',
      'documentation': 'creativity',
      'analysis': 'analysis',
      'reasoning': 'reasoning',
      'creative-writing': 'creativity',
      'chat': 'instructionFollowing',
      'math': 'math',
      'translation': 'multilingual',
      'summarization': 'analysis',
      'question-answering': 'reasoning',
      'planning': 'reasoning',
      'security-audit': 'analysis',
      'testing': 'coding'
    };
    
    return mapping[category] || 'instructionFollowing';
  }

  /**
   * Initialize default routing strategies
   */
  private initializeDefaultStrategies(): void {
    // Balanced strategy - best overall performance
    this.routingStrategies.set('balanced', {
      name: 'balanced',
      description: 'Balance quality and speed',
      selector: (task, models) => {
        const ranked = this.rankModelsForTask(task, models);
        return ranked[0]?.id || models[0]?.id;
      }
    });

    // Speed priority
    this.routingStrategies.set('speed', {
      name: 'speed',
      description: 'Prioritize fast responses',
      selector: (task, models) => {
        return models
          .filter(m => m.capabilities.speed > 0.8)
          .sort((a, b) => b.capabilities.speed - a.capabilities.speed)[0]?.id || models[0]?.id;
      }
    });

    // Quality priority
    this.routingStrategies.set('quality', {
      name: 'quality',
      description: 'Prioritize highest quality',
      selector: (task, models) => {
        return this.rankModelsForTask(task, models)[0]?.id || models[0]?.id;
      }
    });

    // Cost priority
    this.routingStrategies.set('cost', {
      name: 'cost',
      description: 'Prioritize cost efficiency',
      selector: (task, models) => {
        return models
          .filter(m => m.cost.isFree || m.cost.inputPer1kTokens < 0.01)
          .sort((a, b) => b.priority - a.priority)[0]?.id || models[0]?.id;
      }
    });

    // Reliability priority
    this.routingStrategies.set('reliability', {
      name: 'reliability',
      description: 'Prioritize most reliable models',
      selector: (task, models) => {
        return models
          .sort((a, b) => b.capabilities.reliability - a.capabilities.reliability)[0]?.id || models[0]?.id;
      }
    });
  }
}

// ============================================================================
// Export
// ============================================================================

export { ModelRegistry as default };
