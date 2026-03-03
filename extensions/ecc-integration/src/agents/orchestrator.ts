/**
 * Agent Orchestration System
 * Manages agent lifecycle, task distribution, and execution flow
 * Enforces: One Agent / One Task rule
 */

import { GovernanceEngine, Agent, Task, AgentTypeSchema } from '../governance/engine.js';
import type { z } from 'zod';

export interface OrchestrationConfig {
  maxAgentsPerType: number;
  taskTimeoutMs: number;
  autoScaling: boolean;
  healthCheckIntervalMs: number;
}

export class AgentOrchestrator {
  private governance: GovernanceEngine;
  private config: OrchestrationConfig;
  private agentPools: Map<z.infer<typeof AgentTypeSchema>, Agent[]> = new Map();
  private taskQueue: Task[] = [];
  private executionCallbacks: Map<string, TaskExecutor> = new Map();

  constructor(
    governance: GovernanceEngine,
    config: Partial<OrchestrationConfig> = {}
  ) {
    this.governance = governance;
    this.config = {
      maxAgentsPerType: 3,
      taskTimeoutMs: 300000, // 5 minutes
      autoScaling: true,
      healthCheckIntervalMs: 30000,
      ...config
    };

    this.initializePools();
    this.startHealthChecks();
  }

  private initializePools(): void {
    for (const type of AgentTypeSchema.options) {
      this.agentPools.set(type, []);
    }
  }

  private startHealthChecks(): void {
    setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Create and register a new agent of specified type
   */
  async createAgent(type: z.infer<typeof AgentTypeSchema>): Promise<Agent> {
    const pool = this.agentPools.get(type);
    if (!pool) {
      throw new Error(`Invalid agent type: ${type}`);
    }

    if (pool.length >= this.config.maxAgentsPerType) {
      throw new Error(`Maximum ${type} agents (${this.config.maxAgentsPerType}) reached`);
    }

    const agent = this.governance.createAgent(type);
    pool.push(agent);

    console.log(`[Orchestrator] Created ${type} agent: ${agent.id}`);
    return agent;
  }

  /**
   * Submit a task to the orchestration queue
   * Returns task ID for tracking
   */
  async submitTask(
    title: string,
    description: string,
    priority: Task['priority'] = 'medium',
    preferredAgentType?: z.infer<typeof AgentTypeSchema>
  ): Promise<string> {
    const task: Task = {
      id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      title,
      description,
      agentId: null,
      priority,
      status: 'idle',
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      metadata: {
        preferredAgentType,
        submitTime: Date.now()
      }
    };

    this.taskQueue.push(task);
    console.log(`[Orchestrator] Task submitted: ${task.id} - ${title}`);

    // Try to assign immediately
    await this.processQueue();

    return task.id;
  }

  /**
   * Process the task queue and assign to available agents
   * Respects: One Agent / One Task rule via governance engine
   */
  async processQueue(): Promise<void> {
    // Sort by priority
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    this.taskQueue.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    for (const task of this.taskQueue) {
      if (task.status !== 'idle') continue;

      const agentType = task.metadata.preferredAgentType as z.infer<typeof AgentTypeSchema> | undefined;
      const availableAgent = await this.findAvailableAgent(agentType);

      if (availableAgent) {
        const result = this.governance.assignTask(availableAgent.id, task);
        
        if (result.success) {
          console.log(`[Orchestrator] Assigned task ${task.id} to agent ${availableAgent.id}`);
          this.executeTask(task, availableAgent);
        } else {
          console.log(`[Orchestrator] Assignment failed: ${result.error}`);
        }
      }
    }

    // Clean up completed/failed tasks from queue
    this.taskQueue = this.taskQueue.filter(t => 
      t.status === 'idle' || t.status === 'assigned' || t.status === 'working'
    );
  }

  /**
   * Find an available agent for task assignment
   */
  private async findAvailableAgent(
    preferredType?: z.infer<typeof AgentTypeSchema>
  ): Promise<Agent | null> {
    // Try preferred type first
    if (preferredType) {
      const pool = this.agentPools.get(preferredType);
      if (pool) {
        const available = pool.find(a => a.state === 'idle');
        if (available) return available;
      }
    }

    // Try any available agent
    for (const [type, pool] of this.agentPools) {
      const available = pool.find(a => a.state === 'idle');
      if (available) return available;
    }

    // Auto-scale if enabled
    if (this.config.autoScaling) {
      const types = preferredType ? [preferredType] : Array.from(this.agentPools.keys());
      for (const type of types) {
        const pool = this.agentPools.get(type);
        if (pool && pool.length < this.config.maxAgentsPerType) {
          console.log(`[Orchestrator] Auto-scaling: creating new ${type} agent`);
          return await this.createAgent(type);
        }
      }
    }

    return null;
  }

  /**
   * Execute a task with an agent
   */
  private async executeTask(task: Task, agent: Agent): Promise<void> {
    agent.state = 'working';
    task.status = 'working';

    const executor = this.executionCallbacks.get(agent.type);
    if (!executor) {
      console.warn(`[Orchestrator] No executor registered for agent type: ${agent.type}`);
      this.completeTask(task, agent, 'failed', 'No executor registered');
      return;
    }

    // Set timeout
    const timeoutId = setTimeout(() => {
      if (task.status === 'working') {
        this.completeTask(task, agent, 'failed', 'Task timeout');
      }
    }, this.config.taskTimeoutMs);

    try {
      console.log(`[Orchestrator] Executing task ${task.id} with ${agent.type} agent ${agent.id}`);
      
      // Execute with ECC skills
      const result = await executor(task, agent, {
        skills: agent.eccProfile.skills,
        securityLevel: agent.eccProfile.securityLevel
      });

      clearTimeout(timeoutId);
      this.completeTask(task, agent, 'complete', result);
    } catch (error) {
      clearTimeout(timeoutId);
      this.completeTask(task, agent, 'failed', String(error));
    }
  }

  /**
   * Complete a task and update agent state
   */
  private completeTask(
    task: Task,
    agent: Agent,
    status: 'complete' | 'failed',
    result: unknown
  ): void {
    task.status = status;
    task.completedAt = new Date();
    agent.state = 'idle';
    agent.currentTask = null;
    agent.history.push(task);
    agent.lastActive = new Date();

    console.log(`[Orchestrator] Task ${task.id} ${status}:`, 
      typeof result === 'string' ? result : 'completed successfully');

    // Trigger learning update if enabled
    if (agent.eccProfile.learningEnabled) {
      this.updateAgentInstincts(agent, task, result);
    }

    // Process next tasks in queue
    this.processQueue();
  }

  /**
   * Update agent instincts based on task completion
   */
  private updateAgentInstincts(agent: Agent, task: Task, result: unknown): void {
    // Extract patterns from task execution
    const instinct = {
      pattern: `Task ${task.title} completed with ${task.status}`,
      confidence: task.status === 'complete' ? 0.9 : 0.3,
      context: task.metadata,
      timestamp: new Date()
    };

    agent.eccProfile.instincts.push(JSON.stringify(instinct));
    console.log(`[Orchestrator] Updated instincts for agent ${agent.id}`);
  }

  /**
   * Perform health check on all agents
   */
  private performHealthCheck(): void {
    const now = Date.now();
    for (const [type, pool] of this.agentPools) {
      for (const agent of pool) {
        const idle = now - agent.lastActive.getTime();
        
        if (agent.state === 'working' && idle > this.config.taskTimeoutMs) {
          console.warn(`[Orchestrator] Agent ${agent.id} appears stuck, resetting`);
          if (agent.currentTask) {
            agent.currentTask.status = 'failed';
            agent.currentTask.completedAt = new Date();
          }
          agent.state = 'idle';
          agent.currentTask = null;
        }
      }
    }
  }

  /**
   * Register a task executor for an agent type
   */
  registerExecutor(
    agentType: z.infer<typeof AgentTypeSchema>,
    executor: TaskExecutor
  ): void {
    this.executionCallbacks.set(agentType, executor);
    console.log(`[Orchestrator] Registered executor for ${agentType}`);
  }

  /**
   * Get system status
   */
  getStatus(): OrchestrationStatus {
    const status: OrchestrationStatus = {
      agents: {},
      queue: {
        total: this.taskQueue.length,
        byStatus: { idle: 0, assigned: 0, working: 0, complete: 0, failed: 0, blocked: 0 }
      }
    };

    for (const [type, pool] of this.agentPools) {
      status.agents[type] = {
        total: pool.length,
        idle: pool.filter(a => a.state === 'idle').length,
        working: pool.filter(a => a.state === 'working').length,
        assigned: pool.filter(a => a.state === 'assigned').length
      };
    }

    for (const task of this.taskQueue) {
      status.queue.byStatus[task.status]++;
    }

    return status;
  }
}

// Type definitions
export type TaskExecutor = (
  task: Task,
  agent: Agent,
  context: { skills: string[]; securityLevel: string }
) => Promise<unknown>;

interface OrchestrationStatus {
  agents: Record<string, {
    total: number;
    idle: number;
    working: number;
    assigned: number;
  }>;
  queue: {
    total: number;
    byStatus: Record<string, number>;
  };
}

export default AgentOrchestrator;
