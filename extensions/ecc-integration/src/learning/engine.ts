/**
 * Self-Improvement Engine
 * Implements continuous learning, pattern recognition, and skill evolution
 * Based on ECC's Continuous Learning v2 system
 */

import { Agent, Task } from '../governance/engine.js';

export interface Instinct {
  id: string;
  pattern: string;
  confidence: number;
  context: Record<string, unknown>;
  source: 'task-completion' | 'pattern-extraction' | 'skill-evolution';
  createdAt: Date;
  lastUsed: Date;
  usageCount: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  relatedInstincts: string[];
  successRate: number;
  createdAt: Date;
}

export interface LearningConfig {
  minConfidenceThreshold: number;
  maxInstinctsPerAgent: number;
  skillEvolutionIntervalMs: number;
  patternRecognitionEnabled: boolean;
}

export class SelfImprovementEngine {
  private instincts: Map<string, Instinct[]> = new Map();
  private skills: Map<string, Skill[]> = new Map();
  private config: LearningConfig;

  constructor(config: Partial<LearningConfig> = {}) {
    this.config = {
      minConfidenceThreshold: 0.7,
      maxInstinctsPerAgent: 100,
      skillEvolutionIntervalMs: 3600000, // 1 hour
      patternRecognitionEnabled: true,
      ...config
    };

    if (this.config.patternRecognitionEnabled) {
      this.startSkillEvolution();
    }
  }

  /**
   * Learn from task completion
   */
  learnFromTask(agentId: string, task: Task, result: unknown): void {
    if (!this.instincts.has(agentId)) {
      this.instincts.set(agentId, []);
    }

    const agentInstincts = this.instincts.get(agentId)!;
    
    // Extract pattern from task
    const pattern = this.extractPattern(task, result);
    const confidence = this.calculateConfidence(task, result);

    if (confidence >= this.config.minConfidenceThreshold) {
      const instinct: Instinct = {
        id: `instinct-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        pattern,
        confidence,
        context: {
          taskType: task.title,
          success: task.status === 'complete',
          duration: task.completedAt && task.startedAt 
            ? task.completedAt.getTime() - task.startedAt.getTime()
            : null
        },
        source: 'task-completion',
        createdAt: new Date(),
        lastUsed: new Date(),
        usageCount: 1
      };

      agentInstincts.push(instinct);
      
      // Prune old instincts if limit exceeded
      if (agentInstincts.length > this.config.maxInstinctsPerAgent) {
        this.pruneInstincts(agentId);
      }

      console.log(`[Learning] New instinct for ${agentId}: ${pattern} (confidence: ${confidence})`);
    }
  }

  /**
   * Extract pattern from task and result
   */
  private extractPattern(task: Task, result: unknown): string {
    // Pattern extraction logic
    const taskType = task.title.toLowerCase();
    
    if (taskType.includes('code') || taskType.includes('implement')) {
      return `Code task "${task.title}" completed ${task.status === 'complete' ? 'successfully' : 'with issues'}`;
    }
    
    if (taskType.includes('review') || taskType.includes('analyze')) {
      return `Review task "${task.title}" identified ${this.extractFindings(result)} issues`;
    }
    
    if (taskType.includes('security') || taskType.includes('scan')) {
      return `Security scan "${task.title}" ${task.status === 'complete' ? 'passed' : 'failed'}`;
    }

    return `Task "${task.title}" pattern: ${task.status}`;
  }

  /**
   * Extract findings from result
   */
  private extractFindings(result: unknown): number {
    if (typeof result === 'object' && result !== null) {
      if ('findings' in result && Array.isArray(result.findings)) {
        return result.findings.length;
      }
      if ('violations' in result && Array.isArray(result.violations)) {
        return result.violations.length;
      }
    }
    return 0;
  }

  /**
   * Calculate confidence score for an instinct
   */
  private calculateConfidence(task: Task, result: unknown): number {
    let confidence = 0.5;

    // Success boosts confidence
    if (task.status === 'complete') {
      confidence += 0.3;
    }

    // Fast completion indicates well-understood pattern
    if (task.startedAt && task.completedAt) {
      const duration = task.completedAt.getTime() - task.startedAt.getTime();
      if (duration < 60000) { // Under 1 minute
        confidence += 0.1;
      }
    }

    // Result quality affects confidence
    if (typeof result === 'object' && result !== null) {
      if ('quality' in result && typeof result.quality === 'number') {
        confidence += result.quality * 0.1;
      }
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Prune old/irrelevant instincts
   */
  private pruneInstincts(agentId: string): void {
    const agentInstincts = this.instincts.get(agentId);
    if (!agentInstincts) return;

    // Sort by confidence and recency
    agentInstincts.sort((a, b) => {
      const scoreA = a.confidence * 0.6 + (a.usageCount / 100) * 0.4;
      const scoreB = b.confidence * 0.6 + (b.usageCount / 100) * 0.4;
      return scoreB - scoreA;
    });

    // Keep top instincts
    const kept = agentInstincts.slice(0, this.config.maxInstinctsPerAgent);
    const removed = agentInstincts.length - kept.length;
    
    this.instincts.set(agentId, kept);
    
    if (removed > 0) {
      console.log(`[Learning] Pruned ${removed} old instincts for ${agentId}`);
    }
  }

  /**
   * Start skill evolution process
   */
  private startSkillEvolution(): void {
    setInterval(() => {
      this.evolveSkills();
    }, this.config.skillEvolutionIntervalMs);

    console.log('[Learning] Skill evolution started');
  }

  /**
   * Evolve instincts into skills
   */
  private evolveSkills(): void {
    for (const [agentId, agentInstincts] of this.instincts) {
      // Cluster related instincts
      const clusters = this.clusterInstincts(agentInstincts);

      for (const cluster of clusters) {
        if (cluster.length >= 3) { // Minimum cluster size
          const skill = this.createSkillFromCluster(cluster);
          
          if (!this.skills.has(agentId)) {
            this.skills.set(agentId, []);
          }

          const agentSkills = this.skills.get(agentId)!;
          
          // Check if similar skill already exists
          const exists = agentSkills.some(s => s.name === skill.name);
          if (!exists) {
            agentSkills.push(skill);
            console.log(`[Learning] Evolved new skill for ${agentId}: ${skill.name}`);
          }
        }
      }
    }
  }

  /**
   * Cluster related instincts
   */
  private clusterInstincts(instincts: Instinct[]): Instinct[][] {
    const clusters: Instinct[][] = [];
    const processed = new Set<string>();

    for (const instinct of instincts) {
      if (processed.has(instinct.id)) continue;

      const cluster: Instinct[] = [instinct];
      processed.add(instinct.id);

      // Find similar instincts
      for (const other of instincts) {
        if (processed.has(other.id)) continue;
        
        if (this.areInstinctsSimilar(instinct, other)) {
          cluster.push(other);
          processed.add(other.id);
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  /**
   * Check if two instincts are similar
   */
  private areInstinctsSimilar(a: Instinct, b: Instinct): boolean {
    // Simple similarity check based on pattern text
    const patternA = a.pattern.toLowerCase();
    const patternB = b.pattern.toLowerCase();

    // Extract keywords
    const keywordsA = patternA.split(/\s+/).filter(w => w.length > 3);
    const keywordsB = patternB.split(/\s+/).filter(w => w.length > 3);

    // Check for common keywords
    const common = keywordsA.filter(k => keywordsB.includes(k));
    const similarity = common.length / Math.max(keywordsA.length, keywordsB.length);

    return similarity > 0.5; // 50% similarity threshold
  }

  /**
   * Create a skill from a cluster of instincts
   */
  private createSkillFromCluster(cluster: Instinct[]): Skill {
    const patterns = cluster.map(i => i.pattern);
    const commonWords = this.extractCommonWords(patterns);
    
    const name = commonWords.slice(0, 3).join('-') || 'evolved-skill';
    
    const successfulInstincts = cluster.filter(i => i.context.success === true);
    const successRate = successfulInstincts.length / cluster.length;

    return {
      id: `skill-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name,
      description: `Auto-evolved skill from ${cluster.length} related patterns`,
      category: this.categorizeSkill(name),
      relatedInstincts: cluster.map(i => i.id),
      successRate,
      createdAt: new Date()
    };
  }

  /**
   * Extract common words from patterns
   */
  private extractCommonWords(patterns: string[]): string[] {
    if (patterns.length === 0) return [];

    const wordFreq: Map<string, number> = new Map();
    
    for (const pattern of patterns) {
      const words = pattern.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }

    // Sort by frequency
    const sorted = Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .filter(([word, count]) => count >= patterns.length * 0.5) // Appear in 50% of patterns
      .map(([word]) => word);

    return sorted;
  }

  /**
   * Categorize a skill based on its name
   */
  private categorizeSkill(name: string): string {
    const lower = name.toLowerCase();
    
    if (lower.includes('code') || lower.includes('implement')) {
      return 'development';
    }
    if (lower.includes('review') || lower.includes('analyze')) {
      return 'analysis';
    }
    if (lower.includes('security') || lower.includes('scan')) {
      return 'security';
    }
    if (lower.includes('test') || lower.includes('debug')) {
      return 'testing';
    }
    
    return 'general';
  }

  /**
   * Get instincts for an agent
   */
  getInstincts(agentId: string): Instinct[] {
    return this.instincts.get(agentId) || [];
  }

  /**
   * Get skills for an agent
   */
  getSkills(agentId: string): Skill[] {
    return this.skills.get(agentId) || [];
  }

  /**
   * Export all learning data
   */
  exportLearningData(): LearningData {
    const data: LearningData = {
      instincts: {},
      skills: {},
      summary: {
        totalInstincts: 0,
        totalSkills: 0,
        avgConfidence: 0
      }
    };

    let totalConfidence = 0;
    let confidenceCount = 0;

    for (const [agentId, agentInstincts] of this.instincts) {
      data.instincts[agentId] = agentInstincts;
      data.summary.totalInstincts += agentInstincts.length;
      
      for (const instinct of agentInstincts) {
        totalConfidence += instinct.confidence;
        confidenceCount++;
      }
    }

    for (const [agentId, agentSkills] of this.skills) {
      data.skills[agentId] = agentSkills;
      data.summary.totalSkills += agentSkills.length;
    }

    data.summary.avgConfidence = confidenceCount > 0 
      ? totalConfidence / confidenceCount 
      : 0;

    return data;
  }

  /**
   * Import learning data
   */
  importLearningData(data: LearningData): void {
    for (const [agentId, agentInstincts] of Object.entries(data.instincts)) {
      this.instincts.set(agentId, agentInstincts);
    }

    for (const [agentId, agentSkills] of Object.entries(data.skills)) {
      this.skills.set(agentId, agentSkills);
    }

    console.log(`[Learning] Imported data: ${data.summary.totalInstincts} instincts, ${data.summary.totalSkills} skills`);
  }
}

// Type definitions
interface LearningData {
  instincts: Record<string, Instinct[]>;
  skills: Record<string, Skill[]>;
  summary: {
    totalInstincts: number;
    totalSkills: number;
    avgConfidence: number;
  };
}

export type { LearningData };

export default SelfImprovementEngine;
