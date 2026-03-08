/**
 * 多任务并行解析器 - 贾维斯式交互核心
 *
 * 实现功能：
 * 1. 从一句话中解析多个独立任务
 * 2. 任务依赖关系分析
 * 3. 任务优先级排序
 * 4. 支持自然语言的任务引用解析
 */

import type { Logger } from "./shared/index.js";

/**
 * 子任务定义
 */
export interface SubTask {
  /** 任务ID */
  id: string;
  /** 任务类型 */
  type: "code" | "search" | "analysis" | "write" | "read" | "execute" | "notify" | "other";
  /** 任务描述 */
  description: string;
  /** 原始文本片段 */
  rawText: string;
  /** 任务优先级 (1-10, 10最高) */
  priority: number;
  /** 依赖的其他任务ID */
  dependencies: string[];
  /** 预估执行时间 (秒) */
  estimatedDuration: number;
  /** 是否需要用户确认 */
  requiresConfirmation: boolean;
  /** 任务参数 */
  params?: Record<string, unknown>;
}

/**
 * 多任务解析结果
 */
export interface MultiTaskParseResult {
  /** 是否包含多个任务 */
  hasMultipleTasks: boolean;
  /** 解析出的子任务列表 */
  tasks: SubTask[];
  /** 原始消息 */
  originalMessage: string;
  /** 是否为任务控制命令 */
  isControlCommand: boolean;
  /** 控制命令类型 */
  controlType?: "status_query" | "cancel_task" | "cancel_all" | "modify_task" | "pause_task";
  /** 引用的任务ID（用于修改/取消特定任务） */
  referencedTaskId?: string;
}

/**
 * 任务控制命令模式
 */
const CONTROL_COMMAND_PATTERNS = {
  // 状态查询
  statusQuery: [
    /任务.*(状态|进度|怎么样|如何)/i,
    /查[看询].*任务/i,
    /进行.*(什么|哪些)/i,
    /在做什么/i,
    /有.*(什么|哪些).*任务/i,
    /^任务$/i,
    /^status$/i,
    /^tasks$/i,
    /^list$/i,
  ],
  // 取消任务
  cancelTask: [
    /取消.*任务/i,
    /停止.*任务/i,
    /终止.*任务/i,
    /结束.*任务/i,
    /不[要做].*了/i,
    /^cancel$/i,
    /^stop$/i,
  ],
  // 取消所有任务
  cancelAll: [
    /取消.*所有/i,
    /停止.*所有/i,
    /全部取消/i,
    /全部停止/i,
    /清空.*任务/i,
    /^cancel all$/i,
    /^stop all$/i,
    /^clear all$/i,
  ],
  // 修改任务
  modifyTask: [
    /改[变成].*/i,
    /换[成做].*/i,
    /调整.*任务/i,
    /修改.*任务/i,
    /更新.*任务/i,
    /换成.*/i,
    /改为.*/i,
  ],
  // 暂停任务
  pauseTask: [/暂停.*任务/i, /等一下.*再/i, /稍后再/i, /暂停/i, /^pause$/i, /^wait$/i],
};

/**
 * 多任务分隔符模式
 */
const TASK_SEPARATORS = [
  /[，,;；]+(?:然后|接着|之后|随后|再|并且|同时|另外|还有)/g,
  /(?:然后|接着|之后|随后|再|并且|同时|另外|还有|顺便|顺便把|还有|以及)[，,;；]*/g,
  /[。！？]+(?:另外|还有|以及|顺便|顺便把)/g,
  /\n+/g,
];

/**
 * 任务类型识别模式
 */
const TASK_TYPE_PATTERNS: Record<SubTask["type"], RegExp[]> = {
  code: [
    /写.*代码/i,
    /编[写程].*程序/i,
    /实现.*功能/i,
    /开发.*模块/i,
    /创建.*[类库]/i,
    /重构.*代码/i,
    /优化.*性能/i,
    /修复.*[bug|问题]/i,
    /添加.*特性/i,
    /code|program|implement|develop/i,
  ],
  search: [
    /搜索|查找|查询|检索|找一下|搜一下/i,
    /查.*资料/i,
    /找.*信息/i,
    /搜.*[结果|内容]/i,
    /search|find|lookup|query/i,
  ],
  analysis: [
    /分析|解析|研究|评估|诊断/i,
    /分[析解].*数据/i,
    /评[估测].*风险/i,
    /检[查测].*问题/i,
    /analyze|analysis|evaluate|assess|diagnose/i,
  ],
  write: [
    /写.*[文档|报告|邮件|文章]/i,
    /起草.*[文件|合同]/i,
    /编[写辑].*内容/i,
    /撰写/i,
    /write|draft|compose/i,
  ],
  read: [/读.*[文件|文档|代码]/i, /看.*[内容|报告]/i, /阅[读览].*/i, /review|read|check.*file/i],
  execute: [/执行|运行|启动|调用|触发/i, /跑.*[脚本|程序]/i, /deploy|execute|run|start|launch/i],
  notify: [
    /通知|提醒|告知|发送.*给/i,
    /发.*[邮件|消息]/i,
    /告知.*团队/i,
    /notify|inform|remind|send.*to/i,
  ],
  other: [],
};

/**
 * 多任务并行解析器
 *
 * 将用户的一句话解析为多个可并行执行的子任务
 */
export class MultiTaskParser {
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * 解析用户消息
   *
   * @param message 用户输入的消息
   * @returns 解析结果
   */
  parse(message: string): MultiTaskParseResult {
    const trimmedMessage = message.trim();

    // 首先检查是否为任务控制命令
    const controlType = this.detectControlCommand(trimmedMessage);
    if (controlType) {
      return {
        hasMultipleTasks: false,
        tasks: [],
        originalMessage: trimmedMessage,
        isControlCommand: true,
        controlType,
        referencedTaskId: this.extractTaskId(trimmedMessage),
      };
    }

    // 尝试分割为多个子任务
    const subTasks = this.splitIntoSubTasks(trimmedMessage);

    // 如果只有一个任务，简化处理
    if (subTasks.length === 1) {
      return {
        hasMultipleTasks: false,
        tasks: [this.enrichSubTask(subTasks[0], "task-1")],
        originalMessage: trimmedMessage,
        isControlCommand: false,
      };
    }

    // 多个任务：为每个任务分配ID并丰富信息
    const enrichedTasks = subTasks.map((task, index) =>
      this.enrichSubTask(task, `task-${index + 1}`),
    );

    // 分析任务依赖关系
    this.analyzeDependencies(enrichedTasks);

    // 按优先级排序
    this.sortByPriority(enrichedTasks);

    this.logger?.debug(
      `[MultiTaskParser] Parsed ${subTasks.length} tasks from message: "${trimmedMessage.substring(0, 50)}..."`,
    );

    return {
      hasMultipleTasks: true,
      tasks: enrichedTasks,
      originalMessage: trimmedMessage,
      isControlCommand: false,
    };
  }

  /**
   * 检测是否为控制命令
   */
  private detectControlCommand(message: string): MultiTaskParseResult["controlType"] | undefined {
    const normalizedMessage = message.toLowerCase();

    for (const [type, patterns] of Object.entries(CONTROL_COMMAND_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(normalizedMessage)) {
          return type as MultiTaskParseResult["controlType"];
        }
      }
    }

    return undefined;
  }

  /**
   * 从消息中提取任务ID
   */
  private extractTaskId(message: string): string | undefined {
    // 匹配 #TASK-ID 或 #task-id 格式
    const match = message.match(/#([A-Z0-9-]+)/i);
    if (match) {
      return match[1].toUpperCase();
    }

    // 匹配 "任务1"、"第一个任务" 等引用
    const indexMatch = message.match(/(?:第|任务|第个)?\s*(\d+)\s*(?:个|个任务|任务)?/);
    if (indexMatch) {
      const index = parseInt(indexMatch[1], 10);
      if (index > 0 && index <= 10) {
        return `TASK-${index}`;
      }
    }

    return undefined;
  }

  /**
   * 将消息分割为多个子任务
   */
  private splitIntoSubTasks(message: string): string[] {
    const tasks: string[] = [];
    let remaining = message;

    // 尝试用分隔符分割
    for (const separator of TASK_SEPARATORS) {
      const parts = remaining.split(separator).filter((p) => p.trim().length > 0);
      if (parts.length > 1) {
        tasks.push(...parts.map((p) => p.trim()));
        return tasks;
      }
    }

    // 如果没有分隔符，尝试识别多个动词开头的子句
    const verbPattern =
      /(?:请?|帮我|给我)?\s*(?:把|将)?\s*(.*?)\s*(?:并|并且|同时|然后|接着|之后|再|顺便)/g;
    const matches: string[] = [];
    let match;

    while ((match = verbPattern.exec(message)) !== null) {
      if (match[1] && match[1].trim().length > 3) {
        matches.push(match[1].trim());
      }
    }

    if (matches.length > 1) {
      return matches;
    }

    // 无法分割，作为单个任务
    return [message];
  }

  /**
   * 丰富子任务信息
   */
  private enrichSubTask(rawText: string, id: string): SubTask {
    const type = this.detectTaskType(rawText);
    const priority = this.calculatePriority(rawText, type);
    const estimatedDuration = this.estimateDuration(rawText, type);
    const requiresConfirmation = this.requiresConfirmation(rawText);

    return {
      id,
      type,
      description: this.generateDescription(rawText, type),
      rawText,
      priority,
      dependencies: [],
      estimatedDuration,
      requiresConfirmation,
      params: this.extractParams(rawText, type),
    };
  }

  /**
   * 检测任务类型
   */
  private detectTaskType(text: string): SubTask["type"] {
    for (const [type, patterns] of Object.entries(TASK_TYPE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          return type as SubTask["type"];
        }
      }
    }
    return "other";
  }

  /**
   * 计算任务优先级
   */
  private calculatePriority(text: string, type: SubTask["type"]): number {
    let priority = 5; // 默认优先级

    // 根据类型调整
    const typePriority: Record<SubTask["type"], number> = {
      execute: 8,
      notify: 7,
      code: 6,
      write: 6,
      analysis: 5,
      search: 4,
      read: 3,
      other: 5,
    };
    priority = typePriority[type] ?? 5;

    // 根据紧急程度关键词调整
    if (/紧急| urgent| asap|立刻|马上|立即/i.test(text)) {
      priority += 2;
    }
    if (/重要| important|优先|priority/i.test(text)) {
      priority += 1;
    }
    if (/稍后| later|不急|可以等/i.test(text)) {
      priority -= 2;
    }

    return Math.min(10, Math.max(1, priority));
  }

  /**
   * 预估任务执行时间
   */
  private estimateDuration(text: string, type: SubTask["type"]): number {
    const baseDuration: Record<SubTask["type"], number> = {
      code: 120, // 2分钟
      search: 30, // 30秒
      analysis: 60, // 1分钟
      write: 90, // 1.5分钟
      read: 20, // 20秒
      execute: 45, // 45秒
      notify: 15, // 15秒
      other: 60, // 1分钟
    };

    let duration = baseDuration[type] ?? 60;

    // 根据复杂度调整
    if (/复杂|大量|很多|详细|全面/i.test(text)) {
      duration *= 2;
    }
    if (/简单|快速|简要|大概/i.test(text)) {
      duration *= 0.5;
    }

    return Math.round(duration);
  }

  /**
   * 判断是否需要用户确认
   */
  private requiresConfirmation(text: string): boolean {
    // 涉及敏感操作的词
    const sensitivePatterns = [
      /删除|delete|remove/i,
      /修改.*配置|修改.*设置/i,
      /发布|deploy.*prod|上线/i,
      /发送.*给.*所有人|群发/i,
      /执行.*脚本|运行.*命令/i,
      /访问.*数据库|修改.*数据/i,
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(text)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 生成任务描述
   */
  private generateDescription(rawText: string, type: SubTask["type"]): string {
    // 移除常见的冗余前缀
    let description = rawText
      .replace(/^(请|帮我|给我|把|将)\s*/g, "")
      .replace(/^(需要|要|想)\s*/g, "")
      .trim();

    // 限制长度
    if (description.length > 50) {
      description = description.substring(0, 47) + "...";
    }

    return description;
  }

  /**
   * 提取任务参数
   */
  private extractParams(text: string, type: SubTask["type"]): Record<string, unknown> | undefined {
    const params: Record<string, unknown> = {};

    // 提取文件路径
    const fileMatches = text.match(/[\/\\][\w\-.\\/]+(?:\.[a-zA-Z0-9]+)/g);
    if (fileMatches) {
      params.files = fileMatches;
    }

    // 提取URL
    const urlMatches = text.match(/https?:\/\/[^\s]+/g);
    if (urlMatches) {
      params.urls = urlMatches;
    }

    // 提取时间
    const timeMatches = text.match(/\d{1,2}[:\：]\d{2}/g);
    if (timeMatches) {
      params.times = timeMatches;
    }

    // 根据类型提取特定参数
    switch (type) {
      case "code":
        // 提取编程语言
        const langMatch = text.match(
          /(python|javascript|typescript|java|go|rust|cpp|c\+\+|ruby|php)/i,
        );
        if (langMatch) {
          params.language = langMatch[1].toLowerCase();
        }
        break;

      case "search":
        // 提取搜索关键词
        const keywordMatch = text.match(/搜索[：:]\s*(.+?)(?:\s|$)/i);
        if (keywordMatch) {
          params.keywords = keywordMatch[1].split(/[，,;；\s]+/).filter((k) => k.length > 0);
        }
        break;

      case "notify":
        // 提取接收人
        const recipientMatch = text.match(/(?:发给|通知|提醒|发送给)[：:]\s*(@?\w+)/i);
        if (recipientMatch) {
          params.recipient = recipientMatch[1];
        }
        break;
    }

    return Object.keys(params).length > 0 ? params : undefined;
  }

  /**
   * 分析任务依赖关系
   *
   * 支持多种依赖模式：
   * - 显式引用：根据/基于/用/使用 + 其他任务描述
   * - 时序关系：先...再...、等...完成后...、...之后再...
   * - 条件分支：如果...就...、...有问题就...
   */
  private analyzeDependencies(tasks: SubTask[]): void {
    // 第一遍：检测显式依赖引用
    for (let i = 0; i < tasks.length; i++) {
      const current = tasks[i];

      for (let j = 0; j < tasks.length; j++) {
        if (i === j) continue;
        const other = tasks[j];

        const descPrefix = this.escapeRegExp(other.description.substring(0, 20));
        const dependencyPatterns = [
          new RegExp(`(?:根据|基于|用|使用).{0,20}${descPrefix}`, "i"),
          new RegExp(`(?:等|等待).{0,10}${descPrefix}.{0,10}(?:完成|好后|之后)`, "i"),
        ];

        for (const pattern of dependencyPatterns) {
          if (pattern.test(current.rawText)) {
            if (!current.dependencies.includes(other.id)) {
              current.dependencies.push(other.id);
            }
            break;
          }
        }
      }
    }

    // 第二遍：检测时序关系
    this.analyzeSequentialDependencies(tasks);

    // 第三遍：检测条件分支
    this.analyzeConditionalDependencies(tasks);
  }

  /**
   * 转义正则表达式中的特殊字符
   */
  private escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * 分析时序依赖关系
   *
   * 检测"先...再..."、"等...完成后..."、"...之后再..."等模式，
   * 将前置任务设为后续任务的依赖。
   */
  private analyzeSequentialDependencies(tasks: SubTask[]): void {
    if (tasks.length < 2) return;

    const sequentialPatterns = [
      /先.{2,30}(?:再|然后|接着|之后|随后)/,
      /等.{2,30}(?:完成|好了|做完|结束).{0,5}(?:再|然后|接着|之后)/,
      /.{2,30}(?:完成后|之后|做完后|结束后).{0,5}(?:再|然后|接着)/,
      /第一步.{2,30}第二步/,
    ];

    for (const pattern of sequentialPatterns) {
      for (let i = 0; i < tasks.length; i++) {
        if (pattern.test(tasks[i].rawText)) {
          if (i > 0 && !tasks[i].dependencies.includes(tasks[i - 1].id)) {
            tasks[i].dependencies.push(tasks[i - 1].id);
          }
        }
      }
    }

    // 对于通过"然后"、"接着"等分割出来的任务，按顺序建立链式依赖
    for (let i = 1; i < tasks.length; i++) {
      const connectorPattern = /^(?:然后|接着|之后|随后|再|最后|接下来)/;
      if (
        connectorPattern.test(tasks[i].rawText.trim()) &&
        !tasks[i].dependencies.includes(tasks[i - 1].id)
      ) {
        tasks[i].dependencies.push(tasks[i - 1].id);
      }
    }
  }

  /**
   * 分析条件依赖关系
   *
   * 检测"如果...就..."、"...有问题就..."等条件分支模式，
   * 将条件判断的前置任务设为依赖，并标记条件分支信息。
   */
  private analyzeConditionalDependencies(tasks: SubTask[]): void {
    if (tasks.length < 2) return;

    const conditionalPatterns = [
      /如果.{2,30}(?:有问题|失败|不行|出错|异常).{0,10}(?:就|则|那就|再)/,
      /(?:有问题|失败|不行|出错|异常).{0,10}(?:就|则|那就|再)/,
      /如果.{2,30}(?:成功|通过|没问题|正常).{0,10}(?:就|则|那就|再)/,
      /(?:成功|通过|没问题|正常).{0,5}(?:之后|后).{0,5}(?:就|则|再)/,
    ];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskText = task.rawText;

      for (const pattern of conditionalPatterns) {
        if (pattern.test(taskText)) {
          if (i > 0 && !task.dependencies.includes(tasks[i - 1].id)) {
            task.dependencies.push(tasks[i - 1].id);
          }

          const params = task.params ?? {};
          params.isConditional = true;

          if (/有问题|失败|不行|出错|异常/.test(taskText)) {
            params.conditionType = "on_failure";
          } else if (/成功|通过|没问题|正常/.test(taskText)) {
            params.conditionType = "on_success";
          }

          task.params = params;
          break;
        }
      }
    }
  }

  /**
   * 按优先级排序任务
   */
  private sortByPriority(tasks: SubTask[]): void {
    tasks.sort((a, b) => {
      // 首先考虑依赖关系
      if (a.dependencies.includes(b.id)) {
        return 1; // a 依赖 b，b 在前
      }
      if (b.dependencies.includes(a.id)) {
        return -1; // b 依赖 a，a 在前
      }

      // 然后按优先级
      return b.priority - a.priority;
    });
  }
}

/**
 * 创建全局解析器实例
 */
let globalParser: MultiTaskParser | null = null;

export function getGlobalMultiTaskParser(logger?: Logger): MultiTaskParser {
  if (!globalParser) {
    globalParser = new MultiTaskParser(logger);
  }
  return globalParser;
}

/**
 * 重置全局解析器（用于测试）
 */
export function resetGlobalMultiTaskParser(): void {
  globalParser = null;
}
