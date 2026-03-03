/**
 * 任务上下文管理器
 *
 * 实现贾维斯式交互的任务上下文保持功能
 * 支持：
 * - 任务历史记录管理
 * - 自然语言任务引用解析
 * - 任务依赖关系追踪
 * - 会话上下文保持
 */

import type { AsyncTask, TaskStatus } from "./async-task-queue.js";
import type { JarvisCard } from "./jarvis-card.js";
import type { SubTask } from "./multi-task-parser.js";
import type { Logger } from "./shared/index.js";

/**
 * 任务引用类型
 */
export type TaskReferenceType =
  | "task_id" // 直接通过任务ID引用
  | "index" // 通过序号引用（如"第一个任务"）
  | "description" // 通过描述关键词引用
  | "type" // 通过任务类型引用
  | "status" // 通过状态引用（如"正在运行的任务"）
  | "latest" // 引用最近的任务
  | "all"; // 引用所有任务

/**
 * 任务引用
 */
export interface TaskReference {
  /** 引用类型 */
  type: TaskReferenceType;
  /** 引用值 */
  value: string;
  /** 匹配到的任务ID列表 */
  matchedTaskIds: string[];
  /** 置信度 (0-1) */
  confidence: number;
  /** 原始文本 */
  originalText: string;
}

/**
 * 任务历史记录项
 */
export interface TaskHistoryItem {
  /** 任务ID */
  taskId: string;
  /** 任务类型 */
  type: string;
  /** 任务描述 */
  description: string;
  /** 用户ID */
  userId: string;
  /** 会话ID */
  conversationId: string;
  /** 创建时间 */
  createdAt: Date;
  /** 完成时间 */
  completedAt?: Date;
  /** 任务状态 */
  status: TaskStatus;
  /** 父任务ID（如果是子任务） */
  parentTaskId?: string;
  /** 子任务ID列表 */
  subTaskIds?: string[];
  /** 任务结果摘要 */
  result?: string;
  /** 错误信息 */
  error?: string;
  /** 任务标签（用于分类） */
  tags?: string[];
  /** 关联的文件/资源 */
  relatedResources?: string[];
}

/**
 * 用户意图类型
 *
 * 统一描述用户消息的意图，替代 bot.ts 中散落的 pausePattern / shouldAppendToActiveCard 等判断。
 */
export type UserIntentType =
  | "INTERRUPT_PAUSE" // 暂停排队任务："稍等"、"等一下"
  | "INTERRUPT_URGENT" // 紧急停止："停"、"别做了"
  | "APPEND_TASK" // 追加任务到活跃卡片
  | "RESUME_TASK" // 恢复/继续："继续"、"刚才的"
  | "RESULT_REFERENCE" // 结果引用："上次的结果"、"把结果发给XXX"
  | "REDO_TASK" // 重做："重做"、"再来一遍"
  | "NEW_TASK"; // 全新任务（默认）

/**
 * 意图识别结果
 */
export interface RecognizedIntent {
  /** 识别出的意图类型 */
  intent: UserIntentType;
  /** 置信度 (0-1)，低于 0.7 时建议确认 */
  confidence: number;
  /** 是否需要向用户确认（低置信度时为 true） */
  needsConfirmation: boolean;
  /** 匹配到的原始关键词 */
  matchedKeyword?: string;
  /** 关联的任务快照（RESUME/REDO/REFERENCE 时填充） */
  relatedSnapshot?: CompletedTaskSnapshot;
}

/**
 * 已完成任务的轻量快照
 *
 * 用于"继续"、"重做"、"结果引用"等场景的上下文继承。
 * 不存储完整卡片实例，仅保留必要的任务信息。
 */
export interface CompletedTaskSnapshot {
  /** 任务 ID */
  taskId: string;
  /** 任务描述 */
  description: string;
  /** 任务结果摘要 */
  result?: string;
  /** 完成时间 */
  completedAt: Date;
  /** 任务类型 */
  type: string;
  /** 任务状态 */
  status: TaskStatus;
}

/**
 * 会话上下文
 */
export interface SessionContext {
  /** 会话ID */
  sessionId: string;
  /** 用户ID */
  userId: string;
  /** 会话开始时间 */
  startedAt: Date;
  /** 最后活跃时间 */
  lastActiveAt: Date;
  /** 当前进行中的任务 */
  activeTasks: string[];
  /** 任务历史 */
  taskHistory: TaskHistoryItem[];
  /** 上下文变量 */
  variables: Map<string, unknown>;
  /** 最后交互的消息 */
  lastMessage?: string;
  /** 最后交互时间 */
  lastMessageAt?: Date;
  /** 当前活跃的 JarvisCard 实例（一次请求一张卡片） */
  activeJarvisCard?: JarvisCard;
  /** 最近完成的 JarvisCard 实例（用于基于卡片上下文继续对话） */
  lastFinishedJarvisCard?: JarvisCard;
  /** 最近完成的任务快照（用于"继续"、"重做"、"结果引用"） */
  lastCompletedTaskSnapshot?: CompletedTaskSnapshot;
}

/**
 * 上下文管理器配置
 */
export interface ContextManagerConfig {
  /** 单个会话最大历史任务数 */
  maxHistoryPerSession: number;
  /** 会话超时时间（毫秒） */
  sessionTimeoutMs: number;
  /** 是否启用模糊匹配 */
  enableFuzzyMatch: boolean;
  /** 模糊匹配阈值 (0-1) */
  fuzzyMatchThreshold: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ContextManagerConfig = {
  maxHistoryPerSession: 50,
  sessionTimeoutMs: 30 * 60 * 1000, // 30分钟
  enableFuzzyMatch: true,
  fuzzyMatchThreshold: 0.6,
};

/**
 * 任务上下文管理器
 */
export class TaskContextManager {
  private sessions: Map<string, SessionContext> = new Map();
  private config: ContextManagerConfig;
  private logger?: Logger;

  constructor(config?: Partial<ContextManagerConfig>, logger?: Logger) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.logger = logger;
  }

  /**
   * 获取或创建会话上下文
   */
  getOrCreateSession(sessionId: string, userId: string): SessionContext {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        sessionId,
        userId,
        startedAt: new Date(),
        lastActiveAt: new Date(),
        activeTasks: [],
        taskHistory: [],
        variables: new Map(),
      };
      this.sessions.set(sessionId, session);
      this.logger?.debug(`[TaskContext] Created new session: ${sessionId}`);
    } else {
      // 更新最后活跃时间
      session.lastActiveAt = new Date();
    }

    return session;
  }

  /**
   * 记录任务开始
   */
  recordTaskStart(
    sessionId: string,
    userId: string,
    task: AsyncTask | SubTask,
    parentTaskId?: string,
  ): TaskHistoryItem {
    const session = this.getOrCreateSession(sessionId, userId);

    const taskIdSuffix = (() => {
      const ts = Date.now();
      const rnd = Math.random().toString(36).slice(2, 8);
      return `${ts}_${rnd}`;
    })();
    const historyItem: TaskHistoryItem = {
      taskId: "id" in task ? task.id : `subtask_${taskIdSuffix}`,
      type: task.type,
      description: task.description,
      userId,
      conversationId: sessionId,
      createdAt: new Date(),
      status: "running",
      parentTaskId,
    };

    // 如果是子任务，记录到父任务
    if (parentTaskId) {
      const parentTask = session.taskHistory.find((t) => t.taskId === parentTaskId);
      if (parentTask) {
        parentTask.subTaskIds = parentTask.subTaskIds || [];
        parentTask.subTaskIds.push(historyItem.taskId);
      }
    }

    session.activeTasks.push(historyItem.taskId);
    session.taskHistory.unshift(historyItem);

    // 限制历史记录数量
    if (session.taskHistory.length > this.config.maxHistoryPerSession) {
      session.taskHistory = session.taskHistory.slice(0, this.config.maxHistoryPerSession);
    }

    this.logger?.debug(`[TaskContext] Task started: ${historyItem.taskId}`);
    return historyItem;
  }

  /**
   * 记录任务完成
   */
  recordTaskComplete(sessionId: string, taskId: string, result?: string): TaskHistoryItem | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const task = session.taskHistory.find((t) => t.taskId === taskId);
    if (!task) return null;

    task.status = "completed";
    task.completedAt = new Date();
    task.result = result;

    // 从活跃任务列表移除
    session.activeTasks = session.activeTasks.filter((id) => id !== taskId);

    // 自动保存已完成任务快照，用于"继续"、"重做"、"结果引用"
    this.saveCompletedTaskSnapshot(sessionId, taskId);

    this.logger?.debug(`[TaskContext] Task completed: ${taskId}`);
    return task;
  }

  /**
   * 记录任务失败
   */
  recordTaskFail(sessionId: string, taskId: string, error: string): TaskHistoryItem | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const task = session.taskHistory.find((t) => t.taskId === taskId);
    if (!task) return null;

    task.status = "failed";
    task.completedAt = new Date();
    task.error = error;

    // 从活跃任务列表移除
    session.activeTasks = session.activeTasks.filter((id) => id !== taskId);

    this.logger?.debug(`[TaskContext] Task failed: ${taskId}`);
    return task;
  }

  /**
   * 记录任务取消
   */
  recordTaskCancel(sessionId: string, taskId: string): TaskHistoryItem | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const task = session.taskHistory.find((t) => t.taskId === taskId);
    if (!task) return null;

    task.status = "cancelled";
    task.completedAt = new Date();

    // 从活跃任务列表移除
    session.activeTasks = session.activeTasks.filter((id) => id !== taskId);

    this.logger?.debug(`[TaskContext] Task cancelled: ${taskId}`);
    return task;
  }

  /**
   * 解析自然语言中的任务引用
   * 支持：
   * - "任务ABC123" / "#ABC123" - 直接ID引用
   * - "第一个任务" / "最后一个任务" - 序号引用
   * - "搜索相关的任务" - 描述关键词引用
   * - "正在运行的任务" - 状态引用
   * - "刚才的任务" / "上一个任务" - 最近任务引用
   * - "所有任务" - 全部引用
   */
  parseTaskReference(message: string, sessionId: string): TaskReference[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const references: TaskReference[] = [];

    // 1. 解析直接ID引用 (任务ABC123 或 #ABC123)
    const idMatches = this.extractTaskIdReferences(message);
    for (const match of idMatches) {
      const task = session.taskHistory.find((t) => t.taskId.includes(match));
      if (task) {
        references.push({
          type: "task_id",
          value: match,
          matchedTaskIds: [task.taskId],
          confidence: 1.0,
          originalText: match,
        });
      }
    }

    // 2. 解析序号引用 (第一个、第二个、最后一个、上一个、刚才的)
    const indexRefs = this.extractIndexReferences(message);
    for (const ref of indexRefs) {
      const matchedIds = this.resolveIndexReference(ref, session);
      if (matchedIds.length > 0) {
        references.push({
          type: "index",
          value: ref,
          matchedTaskIds: matchedIds,
          confidence: 0.9,
          originalText: ref,
        });
      }
    }

    // 3. 解析状态引用 (正在运行的、完成的、失败的)
    const statusRefs = this.extractStatusReferences(message);
    for (const ref of statusRefs) {
      const matchedIds = this.resolveStatusReference(ref, session);
      if (matchedIds.length > 0) {
        references.push({
          type: "status",
          value: ref,
          matchedTaskIds: matchedIds,
          confidence: 0.85,
          originalText: ref,
        });
      }
    }

    // 4. 解析描述关键词引用
    const descRefs = this.extractDescriptionReferences(message);
    for (const ref of descRefs) {
      const matchedIds = this.resolveDescriptionReference(ref, session);
      if (matchedIds.length > 0) {
        references.push({
          type: "description",
          value: ref,
          matchedTaskIds: matchedIds,
          confidence: 0.7,
          originalText: ref,
        });
      }
    }

    // 5. 解析"所有任务"
    if (this.isAllTasksReference(message)) {
      const allIds = session.taskHistory.map((t) => t.taskId);
      if (allIds.length > 0) {
        references.push({
          type: "all",
          value: "all",
          matchedTaskIds: allIds,
          confidence: 0.95,
          originalText: "所有任务",
        });
      }
    }

    // 6. 时间范围引用："昨天的"、"上午的"、"今天的"
    const timeRefs = this.extractTimeRangeReferences(message);
    for (const ref of timeRefs) {
      const matchedIds = this.resolveTimeRangeReference(ref, session);
      if (matchedIds.length > 0) {
        references.push({
          type: "description",
          value: ref,
          matchedTaskIds: matchedIds,
          confidence: 0.8,
          originalText: ref,
        });
      }
    }

    // 7. 模糊类型引用："那个搜索的"、"之前写的代码"
    const typeRefs = this.extractTypeReferences(message);
    for (const ref of typeRefs) {
      const matchedIds = this.resolveTypeReference(ref, session);
      if (matchedIds.length > 0) {
        references.push({
          type: "type",
          value: ref,
          matchedTaskIds: matchedIds,
          confidence: 0.75,
          originalText: ref,
        });
      }
    }

    // 8. 代词解析："继续刚才的"、"把它重做"
    const pronounRefs = this.extractPronounReferences(message);
    for (const ref of pronounRefs) {
      const matchedIds = this.resolvePronounReference(ref, session);
      if (matchedIds.length > 0) {
        references.push({
          type: "latest",
          value: ref,
          matchedTaskIds: matchedIds,
          confidence: 0.7,
          originalText: ref,
        });
      }
    }

    return this.deduplicateReferences(references);
  }

  /**
   * 提取任务ID引用
   */
  private extractTaskIdReferences(message: string): string[] {
    const patterns = [/任务\s*#?([A-Z0-9]{6,})/gi, /#([A-Z0-9]{6,})/g, /task\s*#?([A-Z0-9]{6,})/gi];

    const matches: string[] = [];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        matches.push(match[1].toUpperCase());
      }
    }

    return [...new Set(matches)];
  }

  /**
   * 提取序号引用
   */
  private extractIndexReferences(message: string): string[] {
    const patterns = [
      /第([一二三四五六七八九十1234567890]+)个任务?/g,
      /(第一个|第二个|第三个|最后一个|上一个|刚才的|最近的)任务?/g,
    ];

    const matches: string[] = [];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        matches.push(match[0]);
      }
    }

    return matches;
  }

  /**
   * 解析序号引用到任务ID
   */
  private resolveIndexReference(ref: string, session: SessionContext): string[] {
    const chineseNumbers: Record<string, number> = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };

    // 处理"第X个"
    const numMatch = ref.match(/第([一二三四五六七八九十0-9]+)个/);
    if (numMatch) {
      const numStr = numMatch[1];
      let index: number;

      if (/[0-9]/.test(numStr)) {
        index = parseInt(numStr, 10) - 1;
      } else {
        index = (chineseNumbers[numStr] || 1) - 1;
      }

      if (index >= 0 && index < session.taskHistory.length) {
        return [session.taskHistory[index].taskId];
      }
    }

    // 处理特殊引用
    if (ref.includes("最后一个") || ref.includes("最近的")) {
      if (session.taskHistory.length > 0) {
        return [session.taskHistory[0].taskId];
      }
    }

    if (ref.includes("上一个") || ref.includes("刚才的")) {
      if (session.taskHistory.length > 1) {
        return [session.taskHistory[1].taskId];
      } else if (session.taskHistory.length === 1) {
        return [session.taskHistory[0].taskId];
      }
    }

    return [];
  }

  /**
   * 提取状态引用
   */
  private extractStatusReferences(message: string): string[] {
    const patterns = [
      /(正在运行|进行中|排队中|等待中)的任务?/g,
      /(已完成|完成|成功)的任务?/g,
      /(失败|出错|错误)的任务?/g,
      /(已取消|取消)的任务?/g,
    ];

    const matches: string[] = [];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        matches.push(match[0]);
      }
    }

    return matches;
  }

  /**
   * 解析状态引用到任务ID
   */
  private resolveStatusReference(ref: string, session: SessionContext): string[] {
    let targetStatus: TaskStatus | null = null;

    if (ref.includes("运行") || ref.includes("进行")) {
      targetStatus = "running";
    } else if (ref.includes("排队") || ref.includes("等待")) {
      targetStatus = "pending";
    } else if (ref.includes("完成") || ref.includes("成功")) {
      targetStatus = "completed";
    } else if (ref.includes("失败") || ref.includes("出错") || ref.includes("错误")) {
      targetStatus = "failed";
    } else if (ref.includes("取消")) {
      targetStatus = "cancelled";
    }

    if (targetStatus) {
      return session.taskHistory.filter((t) => t.status === targetStatus).map((t) => t.taskId);
    }

    return [];
  }

  /**
   * 提取描述关键词引用
   */
  private extractDescriptionReferences(message: string): string[] {
    // 匹配"XX相关的任务"、"关于XX的任务"等模式
    const patterns = [
      /([\\u4e00-\\u9fa5a-zA-Z0-9]+)相关的任务?/g,
      /关于([\\u4e00-\\u9fa5a-zA-Z0-9]+)的任务?/g,
      /([\\u4e00-\\u9fa5a-zA-Z0-9]+)任务?/g,
    ];

    const matches: string[] = [];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        // 过滤掉常见停用词
        const keyword = match[1];
        if (keyword.length >= 2 && !this.isStopWord(keyword)) {
          matches.push(keyword);
        }
      }
    }

    return [...new Set(matches)];
  }

  /**
   * 解析描述引用到任务ID
   */
  private resolveDescriptionReference(keyword: string, session: SessionContext): string[] {
    const matched: string[] = [];

    for (const task of session.taskHistory) {
      // 精确匹配
      if (task.description.includes(keyword)) {
        matched.push(task.taskId);
        continue;
      }

      // 模糊匹配
      if (this.config.enableFuzzyMatch) {
        const similarity = this.calculateSimilarity(keyword, task.description);
        if (similarity >= this.config.fuzzyMatchThreshold) {
          matched.push(task.taskId);
        }
      }
    }

    return matched;
  }

  /**
   * 检查是否是停用词
   */
  private isStopWord(word: string): boolean {
    const stopWords = ["这个", "那个", "这些", "那些", "什么", "怎么", "如何"];
    return stopWords.includes(word);
  }

  /**
   * 计算字符串相似度（简单实现）
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    // 包含关系
    if (s2.includes(s1)) return 0.9;

    // 计算编辑距离（简化版）
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 1.0;

    const common = this.countCommonChars(s1, s2);
    return common / longer.length;
  }

  /**
   * 计算共同字符数
   */
  private countCommonChars(s1: string, s2: string): number {
    const chars1 = new Set(s1.split(""));
    let count = 0;
    for (const char of s2) {
      if (chars1.has(char)) count++;
    }
    return count;
  }

  /**
   * 检查是否是"所有任务"引用
   */
  private isAllTasksReference(message: string): boolean {
    return /所有任务?|全部任务?|每个任务?/.test(message);
  }

  /**
   * 提取时间范围引用
   *
   * 识别"昨天的"、"上午的"、"今天的"、"刚才的" 等时间范围描述。
   */
  private extractTimeRangeReferences(message: string): string[] {
    const patterns = [
      /(昨天|前天|今天|上午|下午|早上|晚上|刚才|刚刚)的/g,
      /(今天|昨天|前天)(上午|下午|早上|晚上)?的?/g,
    ];

    const matches: string[] = [];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        matches.push(match[0]);
      }
    }

    return [...new Set(matches)];
  }

  /**
   * 解析时间范围引用到任务ID
   *
   * 根据时间关键词计算时间范围，过滤 taskHistory 中匹配的任务。
   */
  private resolveTimeRangeReference(ref: string, session: SessionContext): string[] {
    const now = new Date();
    let startTime: Date;
    let endTime: Date = now;

    if (ref.includes("前天")) {
      startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 0, 0, 0);
      endTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
    } else if (ref.includes("昨天")) {
      startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
      endTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    } else if (ref.includes("今天")) {
      startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      endTime = now;
    } else if (ref.includes("上午") || ref.includes("早上")) {
      startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      endTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    } else if (ref.includes("下午")) {
      startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
      endTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
    } else if (ref.includes("晚上")) {
      startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
      endTime = now;
    } else if (ref.includes("刚才") || ref.includes("刚刚")) {
      // "刚才"定义为最近 10 分钟
      startTime = new Date(now.getTime() - 10 * 60 * 1000);
      endTime = now;
    } else {
      return [];
    }

    return session.taskHistory
      .filter((task) => {
        const taskTime = task.createdAt.getTime();
        return taskTime >= startTime.getTime() && taskTime <= endTime.getTime();
      })
      .map((task) => task.taskId);
  }

  /**
   * 提取任务类型引用
   *
   * 识别"那个搜索的"、"之前写的代码"、"分析的那个" 等按任务类型的模糊引用。
   */
  private extractTypeReferences(message: string): string[] {
    const patterns = [
      /(?:那个|之前|上次)(?:的)?(搜索|查找|分析|写的?代码|编写|执行|通知|阅读)/g,
      /(搜索|查找|分析|写代码|编写|执行|通知|阅读)(?:的那个|的任务)/g,
    ];

    const matches: string[] = [];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        matches.push(match[1]);
      }
    }

    return [...new Set(matches)];
  }

  /**
   * 解析类型引用到任务ID
   *
   * 将自然语言的类型描述映射到 SubTask.type，然后在 taskHistory 中按 type 匹配。
   */
  private resolveTypeReference(ref: string, session: SessionContext): string[] {
    // 自然语言到 SubTask.type 的映射
    const typeMapping: Record<string, string[]> = {
      搜索: ["search"],
      查找: ["search"],
      分析: ["analysis"],
      写代码: ["code"],
      写的代码: ["code"],
      编写: ["code", "write"],
      执行: ["execute"],
      通知: ["notify"],
      阅读: ["read"],
    };

    const targetTypes = typeMapping[ref];
    if (!targetTypes) return [];

    return session.taskHistory
      .filter((task) => targetTypes.includes(task.type))
      .map((task) => task.taskId);
  }

  /**
   * 提取代词引用
   *
   * 识别"它"、"这个"、"那个"、"继续刚才的" 等代词引用。
   */
  private extractPronounReferences(message: string): string[] {
    const patterns = [
      /(?:把|将|对|给)(它|这个|那个)/g,
      /继续(刚才|之前|上次)的/g,
      /(它|这个结果|那个结果)/g,
    ];

    const matches: string[] = [];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        matches.push(match[0]);
      }
    }

    return [...new Set(matches)];
  }

  /**
   * 解析代词引用到任务ID
   *
   * 代词通常指代最近完成的任务（lastFinishedJarvisCard 的最后一个任务）。
   */
  private resolvePronounReference(ref: string, session: SessionContext): string[] {
    // "继续刚才的"、"继续之前的"、"继续上次的" → 取最近完成的任务
    if (ref.includes("继续")) {
      const lastCompleted = session.taskHistory.find(
        (task) => task.status === "completed" || task.status === "failed",
      );
      return lastCompleted ? [lastCompleted.taskId] : [];
    }

    // "它"、"这个"、"那个" → 取最近交互的任务
    // 优先取活跃任务，其次取最近完成的任务
    if (session.activeTasks.length > 0) {
      // 取最后一个活跃任务
      return [session.activeTasks[session.activeTasks.length - 1]];
    }

    // 取最近的历史任务
    if (session.taskHistory.length > 0) {
      return [session.taskHistory[0].taskId];
    }

    return [];
  }

  /**
   * 去重引用结果
   */
  private deduplicateReferences(references: TaskReference[]): TaskReference[] {
    const seen = new Set<string>();
    return references.filter((ref) => {
      const key = `${ref.type}:${ref.matchedTaskIds.join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * 获取会话的活跃任务
   */
  getActiveTasks(sessionId: string): TaskHistoryItem[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return session.taskHistory.filter((t) => session.activeTasks.includes(t.taskId));
  }

  /**
   * 获取会话的任务历史
   */
  getTaskHistory(sessionId: string, limit?: number): TaskHistoryItem[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const history = [...session.taskHistory];
    return limit ? history.slice(0, limit) : history;
  }

  /**
   * 获取特定任务
   */
  getTask(sessionId: string, taskId: string): TaskHistoryItem | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return session.taskHistory.find((t) => t.taskId === taskId) || null;
  }

  /**
   * 设置上下文变量
   */
  setVariable(sessionId: string, key: string, value: unknown): void {
    const session = this.getOrCreateSession(sessionId, "");
    session.variables.set(key, value);
  }

  /**
   * 获取上下文变量
   */
  getVariable(sessionId: string, key: string): unknown | undefined {
    const session = this.sessions.get(sessionId);
    return session?.variables.get(key);
  }

  /**
   * 记录用户消息
   */
  recordMessage(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastMessage = message;
      session.lastMessageAt = new Date();
      session.lastActiveAt = new Date();
    }
  }

  /**
   * 关联 JarvisCard 到会话
   *
   * 当创建新的 JarvisCard 时调用，将卡片实例绑定到当前会话。
   * 如果会话已有活跃卡片，旧卡片会被移到 lastFinishedJarvisCard。
   */
  setActiveJarvisCard(sessionId: string, userId: string, card: JarvisCard): void {
    const session = this.getOrCreateSession(sessionId, userId);

    if (session.activeJarvisCard) {
      session.lastFinishedJarvisCard = session.activeJarvisCard;
    }

    session.activeJarvisCard = card;
    session.lastActiveAt = new Date();
    this.logger?.debug(`[TaskContext] JarvisCard linked to session: ${sessionId}`);
  }

  /**
   * 获取会话的活跃 JarvisCard
   *
   * 用于判断新消息到达时，当前会话是否有运行中的卡片。
   * 如果有，可以识别为"追加任务"或"任务控制"。
   */
  getActiveJarvisCard(sessionId: string): JarvisCard | undefined {
    return this.sessions.get(sessionId)?.activeJarvisCard;
  }

  /**
   * 获取最近完成的 JarvisCard
   *
   * 用于在卡片完成后，基于卡片上下文继续对话。
   */
  getLastFinishedJarvisCard(sessionId: string): JarvisCard | undefined {
    return this.sessions.get(sessionId)?.lastFinishedJarvisCard;
  }

  /**
   * 将活跃卡片标记为完成并移到历史
   *
   * 当 JarvisCard 的所有任务完成/失败/取消后调用。
   */
  finishActiveJarvisCard(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.activeJarvisCard) return;

    session.lastFinishedJarvisCard = session.activeJarvisCard;
    session.activeJarvisCard = undefined;
    this.logger?.debug(`[TaskContext] JarvisCard finished for session: ${sessionId}`);
  }

  /**
   * 清除会话的 JarvisCard 关联
   *
   * 在会话超时或手动清理时调用。
   */
  clearJarvisCard(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.activeJarvisCard = undefined;
    session.lastFinishedJarvisCard = undefined;
    this.logger?.debug(`[TaskContext] JarvisCard cleared for session: ${sessionId}`);
  }

  /**
   * 判断新消息是否应该追加到活跃卡片
   *
   * 当会话有活跃卡片且有运行中/排队中的任务时，
   * 新消息可能是"追加任务"或"任务控制"指令。
   */
  shouldAppendToActiveCard(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.activeJarvisCard) return false;

    return session.activeTasks.length > 0;
  }

  /**
   * 获取最近完成的任务结果
   *
   * 用于"上次的结果"、"刚才的分析"等自然语言引用。
   * 返回最近一个已完成任务的结果摘要。
   */
  getLastTaskResult(
    sessionId: string,
  ): { taskId: string; description: string; result: string } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const lastCompleted = session.taskHistory.find(
      (task) => task.status === "completed" && task.result,
    );
    if (!lastCompleted || !lastCompleted.result) return null;

    return {
      taskId: lastCompleted.taskId,
      description: lastCompleted.description,
      result: lastCompleted.result,
    };
  }

  /**
   * 根据任务ID获取结果
   */
  getTaskResult(sessionId: string, taskId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const task = session.taskHistory.find((t) => t.taskId === taskId);
    return task?.result ?? null;
  }

  /**
   * 获取最近完成的任务（用于"重做上次任务"）
   *
   * 返回最近一个已完成或失败的任务的描述，
   * 以便用户可以快速重新执行。
   */
  getLastCompletedTask(sessionId: string): TaskHistoryItem | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return (
      session.taskHistory.find((task) => task.status === "completed" || task.status === "failed") ??
      null
    );
  }

  /**
   * 获取会话的最近消息历史（用于上下文构建）
   */
  getRecentMessages(sessionId: string, limit = 5): Array<{ message: string; timestamp: Date }> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    // 从 taskHistory 中提取最近的消息上下文
    return session.taskHistory
      .filter((task) => task.description)
      .slice(0, limit)
      .map((task) => ({
        message: task.description,
        timestamp: task.createdAt,
      }));
  }

  /**
   * 构建上下文摘要（用于注入到 LLM prompt 中）
   *
   * 生成一段简洁的上下文描述，包含最近的任务历史和结果，
   * 帮助 LLM 理解对话的连续性。
   */
  buildContextSummary(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return "";

    const recentTasks = session.taskHistory.slice(0, 5);
    if (recentTasks.length === 0) return "";

    const lines: string[] = ["[最近任务上下文]"];
    for (const task of recentTasks) {
      const statusLabel =
        task.status === "completed"
          ? "✅"
          : task.status === "failed"
            ? "❌"
            : task.status === "running"
              ? "🔄"
              : "⏳";
      let line = `${statusLabel} ${task.description.substring(0, 60)}`;
      if (task.result) {
        line += ` → ${task.result.substring(0, 100)}`;
      }
      if (task.error) {
        line += ` → 错误: ${task.error.substring(0, 80)}`;
      }
      lines.push(line);
    }

    return lines.join("\n");
  }

  /**
   * 检测是否是结果引用类消息
   *
   * 识别"上次的结果"、"刚才的分析"、"把结果发给XXX"等模式。
   */
  isResultReferenceMessage(message: string): boolean {
    return /上次的结果|刚才的(结果|分析|报告)|之前的(结果|分析|报告)|把(结果|分析|报告)(发|转|给)|再发一遍|重新发送结果/.test(
      message,
    );
  }

  /**
   * 检测是否是"重做"类消息
   *
   * 识别"重做"、"再做一遍"、"重新执行"等模式。
   */
  isRedoMessage(message: string): boolean {
    return /重做|再做一遍|重新(执行|运行|处理)|再来一次|redo/.test(message);
  }

  /**
   * 统一意图识别入口（两级架构）
   *
   * 第一级：快速规则匹配（关键词 + 会话状态），覆盖六种意图
   * 第二级：低置信度时返回 needsConfirmation: true
   *
   * 替代 bot.ts 中散落的 pausePattern、shouldAppendToActiveCard、
   * isResultReferenceMessage、isRedoMessage 等判断逻辑。
   */
  recognizeIntent(message: string, sessionId: string): RecognizedIntent {
    const trimmed = message.trim();
    const session = this.sessions.get(sessionId);
    const hasActiveCard = !!session?.activeJarvisCard;
    const hasActiveTasks = (session?.activeTasks.length ?? 0) > 0;
    const snapshot = session?.lastCompletedTaskSnapshot;

    // === 第一级：高置信度规则匹配 ===

    // 1. 紧急停止（最高优先级）
    const urgentStopResult = this.matchUrgentStop(trimmed);
    if (urgentStopResult && hasActiveCard && hasActiveTasks) {
      return urgentStopResult;
    }

    // 2. 暂停指令（需要有活跃卡片才有意义）
    const pauseResult = this.matchPauseIntent(trimmed, hasActiveCard, hasActiveTasks);
    if (pauseResult) {
      return pauseResult;
    }

    // 3. 重做指令
    if (this.isRedoMessage(trimmed)) {
      return {
        intent: "REDO_TASK",
        confidence: 0.9,
        needsConfirmation: false,
        matchedKeyword: trimmed.match(/重做|再做一遍|重新(?:执行|运行|处理)|再来一次|redo/i)?.[0],
        relatedSnapshot: snapshot,
      };
    }

    // 4. 结果引用
    if (this.isResultReferenceMessage(trimmed)) {
      return {
        intent: "RESULT_REFERENCE",
        confidence: 0.9,
        needsConfirmation: false,
        matchedKeyword: trimmed.match(
          /上次的结果|刚才的(?:结果|分析|报告)|之前的(?:结果|分析|报告)|把(?:结果|分析|报告)(?:发|转|给)|再发一遍|重新发送结果/,
        )?.[0],
        relatedSnapshot: snapshot,
      };
    }

    // 5. 恢复/继续指令
    const resumeResult = this.matchResumeIntent(trimmed, snapshot);
    if (resumeResult) {
      return resumeResult;
    }

    // 6. 追加任务（有活跃卡片且有运行中任务时，新消息默认追加）
    if (hasActiveCard && hasActiveTasks && !session?.activeJarvisCard?.isCardFinished()) {
      return {
        intent: "APPEND_TASK",
        confidence: 0.75,
        needsConfirmation: false,
      };
    }

    // === 第二级：歧义场景，需要确认 ===

    // 消息很短且有活跃卡片（可能是追加，也可能是控制指令）
    if (hasActiveCard && trimmed.length <= 6) {
      const ambiguousResult = this.matchAmbiguousShortMessage(trimmed, hasActiveTasks, snapshot);
      if (ambiguousResult) {
        return ambiguousResult;
      }
    }

    // 默认：全新任务
    return {
      intent: "NEW_TASK",
      confidence: 1.0,
      needsConfirmation: false,
    };
  }

  /**
   * 匹配紧急停止意图
   *
   * "停"、"别做了"、"取消"等强烈中断指令。
   * 与暂停不同，紧急停止意味着用户希望立即终止所有任务。
   */
  private matchUrgentStop(message: string): RecognizedIntent | null {
    const urgentPattern = /^(停|别做了|全部停止|全部取消|stop all|cancel all)$/i;
    const match = message.match(urgentPattern);
    if (match) {
      return {
        intent: "INTERRUPT_URGENT",
        confidence: 0.95,
        needsConfirmation: false,
        matchedKeyword: match[0],
      };
    }
    return null;
  }

  /**
   * 匹配暂停意图
   *
   * "稍等"、"先停一下"等温和中断指令。
   * 需要区分真正的暂停指令和包含暂停词的普通消息（如"等一下我想想"）。
   */
  private matchPauseIntent(
    message: string,
    hasActiveCard: boolean,
    hasActiveTasks: boolean,
  ): RecognizedIntent | null {
    // 高置信度暂停：短消息且完全匹配暂停模式
    const strictPausePattern = /^(暂停|先停一下|先别做|停一下|等一下|hold on|pause)$/i;
    const strictMatch = message.match(strictPausePattern);
    if (strictMatch && hasActiveCard && hasActiveTasks) {
      return {
        intent: "INTERRUPT_PAUSE",
        confidence: 0.95,
        needsConfirmation: false,
        matchedKeyword: strictMatch[0],
      };
    }

    // 中置信度暂停：消息中包含暂停词但不是完全匹配
    const loosePausePattern = /暂停|先停一下|先别做|停一下|hold on|pause/i;
    const looseMatch = message.match(loosePausePattern);
    if (looseMatch && hasActiveCard && hasActiveTasks) {
      // "等一下我想想" 这类不应该触发暂停
      const falsePositivePattern = /等一下.{0,4}(我|让我|先|想|看|说|问)/;
      if (falsePositivePattern.test(message)) {
        return null;
      }
      return {
        intent: "INTERRUPT_PAUSE",
        confidence: 0.7,
        needsConfirmation: true,
        matchedKeyword: looseMatch[0],
      };
    }

    return null;
  }

  /**
   * 匹配恢复/继续意图
   *
   * "继续"、"继续刚才的"、"接着做" 等恢复指令。
   */
  private matchResumeIntent(
    message: string,
    snapshot?: CompletedTaskSnapshot,
  ): RecognizedIntent | null {
    const resumePattern = /^(继续|继续刚才的|接着做|接着|resume|continue)$/i;
    const match = message.match(resumePattern);
    if (match) {
      return {
        intent: "RESUME_TASK",
        confidence: snapshot ? 0.9 : 0.6,
        needsConfirmation: !snapshot,
        matchedKeyword: match[0],
        relatedSnapshot: snapshot,
      };
    }

    // 宽松匹配：消息中包含继续/恢复相关词
    const looseResumePattern = /继续(刚才|之前|上次)的|接着(刚才|之前|上次)的/;
    const looseMatch = message.match(looseResumePattern);
    if (looseMatch) {
      return {
        intent: "RESUME_TASK",
        confidence: snapshot ? 0.85 : 0.5,
        needsConfirmation: !snapshot,
        matchedKeyword: looseMatch[0],
        relatedSnapshot: snapshot,
      };
    }

    return null;
  }

  /**
   * 匹配歧义短消息
   *
   * 当消息很短（≤6字符）且有活跃卡片时，可能是控制指令也可能是追加任务。
   */
  private matchAmbiguousShortMessage(
    message: string,
    hasActiveTasks: boolean,
    snapshot?: CompletedTaskSnapshot,
  ): RecognizedIntent | null {
    // "好的"、"嗯"、"ok" 等确认性短消息，不应触发任何操作
    if (/^(好的?|嗯|ok|行|可以|是的?|对|没问题)$/i.test(message)) {
      return null;
    }

    // "继续" 单独出现
    if (/^继续$/i.test(message)) {
      return {
        intent: "RESUME_TASK",
        confidence: snapshot ? 0.85 : 0.5,
        needsConfirmation: !snapshot,
        matchedKeyword: "继续",
        relatedSnapshot: snapshot,
      };
    }

    // 有活跃任务时，短消息可能是追加
    if (hasActiveTasks) {
      return {
        intent: "APPEND_TASK",
        confidence: 0.5,
        needsConfirmation: true,
      };
    }

    return null;
  }

  /**
   * 保存已完成任务的轻量快照到会话上下文
   *
   * 在任务完成时自动调用，用于后续的"继续"、"重做"、"结果引用"等场景。
   */
  saveCompletedTaskSnapshot(sessionId: string, taskId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const task = session.taskHistory.find((historyTask) => historyTask.taskId === taskId);
    if (!task) return;

    session.lastCompletedTaskSnapshot = {
      taskId: task.taskId,
      description: task.description,
      result: task.result,
      completedAt: task.completedAt ?? new Date(),
      type: task.type,
      status: task.status,
    };

    this.logger?.debug(`[TaskContext] Saved task snapshot: ${taskId}`);
  }

  /**
   * 获取已完成任务的快照
   */
  getCompletedTaskSnapshot(sessionId: string): CompletedTaskSnapshot | undefined {
    return this.sessions.get(sessionId)?.lastCompletedTaskSnapshot;
  }

  /**
   * 清理过期会话
   */
  cleanupExpiredSessions(): number {
    const now = Date.now();
    let count = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActiveAt.getTime() > this.config.sessionTimeoutMs) {
        this.sessions.delete(sessionId);
        count++;
        this.logger?.debug(`[TaskContext] Cleaned up expired session: ${sessionId}`);
      }
    }

    return count;
  }

  /**
   * 获取会话统计
   */
  getSessionStats(): { total: number; active: number } {
    let active = 0;
    const now = Date.now();

    for (const session of this.sessions.values()) {
      if (now - session.lastActiveAt.getTime() <= this.config.sessionTimeoutMs) {
        active++;
      }
    }

    return {
      total: this.sessions.size,
      active,
    };
  }

  /**
   * 销毁会话
   */
  destroySession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.logger?.debug(`[TaskContext] Destroyed session: ${sessionId}`);
  }
}

/**
 * 全局上下文管理器实例
 */
let globalContextManager: TaskContextManager | null = null;

/**
 * 获取或创建全局上下文管理器
 */
export function getGlobalContextManager(
  config?: Partial<ContextManagerConfig>,
  logger?: Logger,
): TaskContextManager {
  if (!globalContextManager) {
    globalContextManager = new TaskContextManager(config, logger);
  }
  return globalContextManager;
}

/**
 * 重置全局上下文管理器
 */
export function resetGlobalContextManager(): void {
  globalContextManager = null;
}
