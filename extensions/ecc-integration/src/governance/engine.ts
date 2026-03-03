/**
 * Core Governance System
 * Implements the three fundamental rules:
 * 1. Rules > Freedom - Strict governance over agent behavior
 * 2. One Agent/One Task - Single responsibility per agent
 * 3. Claude Code Integration - ECC knowledge as foundation
 */

import { z } from 'zod';

// ============================================================================
// Type Definitions
// ============================================================================

export const AgentStateSchema = z.enum([
  'idle',
  'assigned',
  'working',
  'complete',
  'failed',
  'blocked'
]);

export const AgentTypeSchema = z.enum([
  'architect',
  'developer',
  'reviewer',
  'security',
  'devops',
  'learning'
]);

export const RulePrioritySchema = z.enum([
  'critical',  // Cannot be overridden
  'high',      // Strongly enforced
  'medium',    // Standard enforcement
  'low'        // Guidelines
]);

export interface Agent {
  id: string;
  type: z.infer<typeof AgentTypeSchema>;
  state: z.infer<typeof AgentStateSchema>;
  currentTask: Task | null;
  history: Task[];
  createdAt: Date;
  lastActive: Date;
  eccProfile: ECCProfile;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  agentId: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: z.infer<typeof AgentStateSchema>;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface ECCProfile {
  skills: string[];
  instincts: string[];
  rules: string[];
  learningEnabled: boolean;
  securityLevel: 'standard' | 'enhanced' | 'maximum';
}

export interface GovernanceRule {
  id: string;
  name: string;
  description: string;
  priority: z.infer<typeof RulePrioritySchema>;
  condition: string;
  action: string;
  enabled: boolean;
}

// ============================================================================
// Core Rule Definitions
// ============================================================================

export const CORE_RULES: GovernanceRule[] = [
  {
    id: 'rule-001',
    name: 'Rules Over Freedom',
    description: 'All agent behavior must be governed by explicit rules. No free-form decision making without rule validation.',
    priority: 'critical',
    condition: 'agent.state == "working"',
    action: 'validateAgainstRules()',
    enabled: true
  },
  {
    id: 'rule-002',
    name: 'Single Task Per Agent',
    description: 'Each agent can only work on one task at a time. New tasks require agent completion or reassignment.',
    priority: 'critical',
    condition: 'agent.currentTask != null',
    action: 'rejectNewTaskAssignment()',
    enabled: true
  },
  {
    id: 'rule-003',
    name: 'Claude Code Integration',
    description: 'All operations must leverage ECC skills and knowledge base for expertise-driven execution.',
    priority: 'high',
    condition: 'task.assigned',
    action: 'loadECCSkills()',
    enabled: true
  },
  {
    id: 'rule-004',
    name: 'Security First',
    description: 'All code changes must pass AgentShield security scanning before execution.',
    priority: 'high',
    condition: 'task.type == "code-change"',
    action: 'runSecurityScan()',
    enabled: true
  },
  {
    id: 'rule-005',
    name: 'Continuous Learning',
    description: 'Agents must update their instinct database after task completion.',
    priority: 'medium',
    condition: 'task.status == "complete"',
    action: 'updateInstincts()',
    enabled: true
  }
];

// ============================================================================
// Governance Engine
// ============================================================================

export class GovernanceEngine {
  private rules: Map<string, GovernanceRule> = new Map();
  private agents: Map<string, Agent> = new Map();
  private tasks: Map<string, Task> = new Map();
  private auditLog: GovernanceEvent[] = [];

  constructor() {
    this.initializeCoreRules();
  }

  private initializeCoreRules(): void {
    for (const rule of CORE_RULES) {
      this.rules.set(rule.id, rule);
    }
  }

  /**
   * Validate an action against all applicable rules
   */
  validateAction(
    agent: Agent,
    action: string,
    context: Record<string, unknown>
  ): ValidationResult {
    const applicableRules = this.getApplicableRules(agent, action, context);
    const violations: RuleViolation[] = [];

    for (const rule of applicableRules) {
      if (!rule.enabled) continue;

      const evaluation = this.evaluateRule(rule, agent, action, context);
      if (!evaluation.passed) {
        violations.push({
          ruleId: rule.id,
          ruleName: rule.name,
          priority: rule.priority,
          reason: evaluation.reason
        });
      }
    }

    const result: ValidationResult = {
      allowed: violations.filter(v => v.priority === 'critical').length === 0,
      violations,
      warnings: violations.filter(v => v.priority !== 'critical')
    };

    this.logEvent('VALIDATION', agent.id, action, result);
    return result;
  }

  /**
   * Assign a task to an agent following Rule #2 (One Agent/One Task)
   */
  assignTask(agentId: string, task: Task): AssignmentResult {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }

    // Rule #2: One Agent/One Task
    if (agent.currentTask) {
      return {
        success: false,
        error: `Agent ${agentId} already assigned to task ${agent.currentTask.id}. Complete or reassign current task first.`,
        currentTask: agent.currentTask
      };
    }

    // Validate assignment against rules
    const validation = this.validateAction(agent, 'assign-task', { task });
    if (!validation.allowed) {
      return {
        success: false,
        error: 'Assignment blocked by governance rules',
        violations: validation.violations
      };
    }

    // Perform assignment
    agent.currentTask = task;
    agent.state = 'assigned';
    agent.lastActive = new Date();
    task.agentId = agentId;
    task.status = 'assigned';
    task.startedAt = new Date();

    this.tasks.set(task.id, task);
    this.logEvent('TASK_ASSIGNED', agentId, task.id, { task, validation });

    return { success: true, agent, task };
  }

  /**
   * Create a new agent with ECC profile
   */
  createAgent(type: z.infer<typeof AgentTypeSchema>): Agent {
    const id = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const agent: Agent = {
      id,
      type,
      state: 'idle',
      currentTask: null,
      history: [],
      createdAt: new Date(),
      lastActive: new Date(),
      eccProfile: this.createECCProfile(type)
    };

    this.agents.set(id, agent);
    this.logEvent('AGENT_CREATED', id, type, { profile: agent.eccProfile });
    
    return agent;
  }

  /**
   * Create ECC profile for agent type
   */
  private createECCProfile(type: z.infer<typeof AgentTypeSchema>): ECCProfile {
    const skillMap: Record<z.infer<typeof AgentTypeSchema>, string[]> = {
      architect: ['architecture-review', 'system-design', 'adr-creation', 'pattern-analysis'],
      developer: ['tdd-workflow', 'code-implementation', 'refactoring', 'debugging'],
      reviewer: ['code-review', 'quality-analysis', 'security-review', 'performance-review'],
      security: ['agentshield-scan', 'vulnerability-assessment', 'security-hardening'],
      devops: ['deployment-automation', 'infrastructure-as-code', 'monitoring'],
      learning: ['pattern-extraction', 'skill-evolution', 'instinct-learning']
    };

    return {
      skills: skillMap[type] || [],
      instincts: [],
      rules: ['always-document', 'test-first', 'security-check'],
      learningEnabled: true,
      securityLevel: type === 'security' ? 'maximum' : 'enhanced'
    };
  }

  // Helper methods
  private getApplicableRules(
    agent: Agent,
    action: string,
    context: Record<string, unknown>
  ): GovernanceRule[] {
    return Array.from(this.rules.values()).filter(rule => {
      // Simple condition matching - could be more sophisticated
      return rule.condition.includes(action) || 
             rule.condition.includes(agent.state) ||
             rule.condition.includes(agent.type);
    });
  }

  private evaluateRule(
    rule: GovernanceRule,
    agent: Agent,
    action: string,
    context: Record<string, unknown>
  ): RuleEvaluation {
    // Rule evaluation logic
    switch (rule.id) {
      case 'rule-002': // Single Task Per Agent
        if (agent.currentTask && action === 'assign-task') {
          return { passed: false, reason: 'Agent already has an active task' };
        }
        return { passed: true };
      
      case 'rule-003': // Claude Code Integration
        if (!agent.eccProfile.skills.length) {
          return { passed: false, reason: 'Agent missing ECC skills profile' };
        }
        return { passed: true };
      
      default:
        return { passed: true };
    }
  }

  private logEvent(
    type: string,
    agentId: string,
    action: string,
    details: unknown
  ): void {
    this.auditLog.push({
      timestamp: new Date(),
      type,
      agentId,
      action,
      details
    });
  }

  // Public getters
  getAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  getTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getAuditLog(): GovernanceEvent[] {
    return [...this.auditLog];
  }
}

// ============================================================================
// Type Interfaces
// ============================================================================

interface ValidationResult {
  allowed: boolean;
  violations: RuleViolation[];
  warnings: RuleViolation[];
}

interface RuleViolation {
  ruleId: string;
  ruleName: string;
  priority: z.infer<typeof RulePrioritySchema>;
  reason: string;
}

interface RuleEvaluation {
  passed: boolean;
  reason?: string;
}

interface AssignmentResult {
  success: boolean;
  agent?: Agent;
  task?: Task;
  error?: string;
  currentTask?: Task;
  violations?: RuleViolation[];
}

interface GovernanceEvent {
  timestamp: Date;
  type: string;
  agentId: string;
  action: string;
  details: unknown;
}

export default GovernanceEngine;
