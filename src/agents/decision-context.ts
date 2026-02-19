/**
 * Decision Context - 决策上下文
 *
 * 在 Agent 运行时维护决策状态，支持跨工具调用追踪目标和进度
 * 这是实现自主决策的核心基础设施
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("decision");

/**
 * 决策级别
 */
export type DecisionLevel = "fast" | "balanced" | "deep";

/**
 * 目标状态
 */
export type GoalStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed";

/**
 * 目标定义
 */
export type Goal = {
  id: string;
  description: string;
  status: GoalStatus;
  priority: number;
  createdAt: number;
  updatedAt: number;
  progress: number;
  blockers: string[];
  subGoals: string[];
  parentGoal?: string;
  successCriteria: string[];
  metadata: Record<string, unknown>;
};

/**
 * 工具调用记录
 */
export type ToolCallRecord = {
  toolName: string;
  toolCallId: string;
  timestamp: number;
  args: Record<string, unknown>;
  result?: unknown;
  success?: boolean;
  confidence?: number;
  recommendation?: string;
  duration?: number;
};

/**
 * 执行指令 - 工具返回的可执行指令
 */
export type ExecutionInstruction = {
  thinkingLevel?: "off" | "low" | "medium" | "high";
  useTools?: string[];
  avoidTools?: string[];
  maxIterations?: number;
  qualityThreshold?: number;
  nextAction?: string;
  stopExecution?: boolean;
  requestClarification?: boolean;
  clarificationQuestion?: string;
};

/**
 * 决策上下文快照
 */
export type DecisionSnapshot = {
  version: number;
  timestamp: number;
  goals: Map<string, Goal>;
  currentGoalId?: string;
  toolHistory: ToolCallRecord[];
  instruction: ExecutionInstruction;
  metrics: {
    totalToolCalls: number;
    successfulToolCalls: number;
    averageConfidence: number;
    totalDuration: number;
  };
  metadata: Record<string, unknown>;
};

/**
 * 决策上下文配置
 */
export type DecisionContextConfig = {
  maxToolHistory: number;
  maxGoals: number;
  persistenceEnabled: boolean;
  autoCleanup: boolean;
};

const DEFAULT_CONFIG: DecisionContextConfig = {
  maxToolHistory: 100,
  maxGoals: 50,
  persistenceEnabled: true,
  autoCleanup: true,
};

/**
 * 决策上下文 - 全局单例
 *
 * 管理整个会话期间的决策状态
 */
export class DecisionContext {
  private static instance: DecisionContext | null = null;

  private readonly goals: Map<string, Goal> = new Map();
  private currentGoalId: string | undefined;
  private toolHistory: ToolCallRecord[] = [];
  private instruction: ExecutionInstruction = {};
  private metrics = {
    totalToolCalls: 0,
    successfulToolCalls: 0,
    averageConfidence: 0,
    totalDuration: 0,
  };
  private metadata: Record<string, unknown> = {};
  private config: DecisionContextConfig;

  private constructor(config?: Partial<DecisionContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(config?: Partial<DecisionContextConfig>): DecisionContext {
    if (!DecisionContext.instance) {
      DecisionContext.instance = new DecisionContext(config);
      log.debug("DecisionContext initialized");
    }
    return DecisionContext.instance;
  }

  static reset(): void {
    DecisionContext.instance = null;
    log.debug("DecisionContext reset");
  }

  /**
   * 创建新目标
   */
  createGoal(params: {
    description: string;
    priority?: number;
    successCriteria?: string[];
    parentGoal?: string;
    metadata?: Record<string, unknown>;
  }): Goal {
    const id = `goal-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const goal: Goal = {
      id,
      description: params.description,
      status: "pending",
      priority: params.priority ?? 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      progress: 0,
      blockers: [],
      subGoals: [],
      parentGoal: params.parentGoal,
      successCriteria: params.successCriteria ?? [],
      metadata: params.metadata ?? {},
    };

    if (this.goals.size >= this.config.maxGoals && this.config.autoCleanup) {
      this.cleanupOldGoals();
    }

    this.goals.set(id, goal);

    if (params.parentGoal) {
      const parent = this.goals.get(params.parentGoal);
      if (parent) {
        parent.subGoals.push(id);
        parent.updatedAt = Date.now();
      }
    }

    log.debug(`Goal created: ${id} - "${params.description.substring(0, 50)}..."`);
    return goal;
  }

  /**
   * 设置当前目标
   */
  setCurrentGoal(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) {
      log.warn(`Cannot set current goal: ${goalId} not found`);
      return false;
    }

    this.currentGoalId = goalId;
    goal.status = "in_progress";
    goal.updatedAt = Date.now();

    log.debug(`Current goal set: ${goalId}`);
    return true;
  }

  /**
   * 获取当前目标
   */
  getCurrentGoal(): Goal | undefined {
    if (!this.currentGoalId) {
      return undefined;
    }
    return this.goals.get(this.currentGoalId);
  }

  /**
   * 更新目标进度
   */
  updateGoalProgress(goalId: string, progress: number, blockers?: string[]): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return false;
    }

    goal.progress = Math.min(100, Math.max(0, progress));
    goal.updatedAt = Date.now();

    if (blockers) {
      goal.blockers = blockers;
      goal.status = blockers.length > 0 ? "blocked" : "in_progress";
    }

    if (goal.progress >= 100) {
      goal.status = "completed";
    }

    log.debug(`Goal ${goalId} progress: ${goal.progress}%, status: ${goal.status}`);
    return true;
  }

  /**
   * 添加阻塞项
   */
  addBlocker(goalId: string, blocker: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return false;
    }

    if (!goal.blockers.includes(blocker)) {
      goal.blockers.push(blocker);
      goal.status = "blocked";
      goal.updatedAt = Date.now();
      log.debug(`Blocker added to ${goalId}: ${blocker}`);
    }
    return true;
  }

  /**
   * 移除阻塞项
   */
  removeBlocker(goalId: string, blocker: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return false;
    }

    const index = goal.blockers.indexOf(blocker);
    if (index >= 0) {
      goal.blockers.splice(index, 1);
      if (goal.blockers.length === 0 && goal.status === "blocked") {
        goal.status = "in_progress";
      }
      goal.updatedAt = Date.now();
      log.debug(`Blocker removed from ${goalId}: ${blocker}`);
    }
    return true;
  }

  /**
   * 记录工具调用
   */
  recordToolCall(record: ToolCallRecord): void {
    this.toolHistory.push(record);
    this.metrics.totalToolCalls++;

    if (record.success) {
      this.metrics.successfulToolCalls++;
    }

    if (record.confidence !== undefined) {
      const total = this.metrics.totalToolCalls;
      this.metrics.averageConfidence =
        (this.metrics.averageConfidence * (total - 1) + record.confidence) / total;
    }

    if (record.duration !== undefined) {
      this.metrics.totalDuration += record.duration;
    }

    if (this.toolHistory.length > this.config.maxToolHistory && this.config.autoCleanup) {
      this.toolHistory = this.toolHistory.slice(-this.config.maxToolHistory);
    }

    log.debug(
      `Tool call recorded: ${record.toolName}, success=${record.success}, confidence=${record.confidence?.toFixed(2) ?? "N/A"}`,
    );
  }

  /**
   * 获取最近的工具调用
   */
  getRecentToolCalls(count = 10): ToolCallRecord[] {
    return this.toolHistory.slice(-count);
  }

  /**
   * 获取特定工具的调用历史
   */
  getToolCallHistory(toolName: string): ToolCallRecord[] {
    return this.toolHistory.filter((r) => r.toolName === toolName);
  }

  /**
   * 设置执行指令
   */
  setInstruction(instruction: ExecutionInstruction): void {
    this.instruction = { ...this.instruction, ...instruction };
    log.debug(`Instruction updated: thinkingLevel=${instruction.thinkingLevel}, useTools=${instruction.useTools?.join(",") ?? "none"}`);
  }

  /**
   * 获取当前执行指令
   */
  getInstruction(): ExecutionInstruction {
    return { ...this.instruction };
  }

  /**
   * 清除执行指令
   */
  clearInstruction(): void {
    this.instruction = {};
    log.debug("Instruction cleared");
  }

  /**
   * 获取决策级别（基于工具调用历史和目标状态）
   */
  inferDecisionLevel(): DecisionLevel {
    const goal = this.getCurrentGoal();

    if (!goal) {
      return "fast";
    }

    if (goal.blockers.length > 0) {
      return "deep";
    }

    const recentCalls = this.getRecentToolCalls(5);
    const lowConfidenceCalls = recentCalls.filter((c) => (c.confidence ?? 0) < 0.5);

    if (lowConfidenceCalls.length >= 3) {
      return "deep";
    }

    if (goal.progress < 30 || recentCalls.length < 3) {
      return "balanced";
    }

    return "fast";
  }

  /**
   * 获取指标
   */
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }

  /**
   * 创建快照
   */
  createSnapshot(): DecisionSnapshot {
    return {
      version: 1,
      timestamp: Date.now(),
      goals: new Map(this.goals),
      currentGoalId: this.currentGoalId,
      toolHistory: [...this.toolHistory],
      instruction: { ...this.instruction },
      metrics: { ...this.metrics },
      metadata: { ...this.metadata },
    };
  }

  /**
   * 从快照恢复
   */
  restoreFromSnapshot(snapshot: DecisionSnapshot): void {
    this.goals.clear();
    snapshot.goals.forEach((goal, id) => {
      this.goals.set(id, goal);
    });
    this.currentGoalId = snapshot.currentGoalId;
    this.toolHistory = [...snapshot.toolHistory];
    this.instruction = { ...snapshot.instruction };
    this.metrics = { ...snapshot.metrics };
    this.metadata = { ...snapshot.metadata };
    log.debug("DecisionContext restored from snapshot");
  }

  /**
   * 清理旧目标
   */
  private cleanupOldGoals(): void {
    const sortedGoals = [...this.goals.entries()].toSorted(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );

    const toRemove = sortedGoals.slice(0, Math.floor(this.config.maxGoals * 0.2));
    for (const [id, goal] of toRemove) {
      if (goal.status === "completed" || goal.status === "failed") {
        this.goals.delete(id);
        log.debug(`Cleaned up old goal: ${id}`);
      }
    }
  }

  /**
   * 导出为 JSON（用于调试和持久化）
   */
  toJSON(): string {
    return JSON.stringify({
      goals: Object.fromEntries(this.goals),
      currentGoalId: this.currentGoalId,
      toolHistory: this.toolHistory,
      instruction: this.instruction,
      metrics: this.metrics,
      metadata: this.metadata,
    });
  }

  /**
   * 从 JSON 恢复
   */
  static fromJSON(json: string): DecisionContext {
    const data = JSON.parse(json);
    const ctx = new DecisionContext();
    
    Object.entries(data.goals as Record<string, Goal>).forEach(([id, goal]) => {
      ctx.goals.set(id, goal);
    });
    ctx.currentGoalId = data.currentGoalId;
    ctx.toolHistory = data.toolHistory;
    ctx.instruction = data.instruction;
    ctx.metrics = data.metrics;
    ctx.metadata = data.metadata;
    
    return ctx;
  }
}

/**
 * 获取全局决策上下文
 */
export function getDecisionContext(config?: Partial<DecisionContextConfig>): DecisionContext {
  return DecisionContext.getInstance(config);
}

/**
 * 重置决策上下文
 */
export function resetDecisionContext(): void {
  DecisionContext.reset();
}
