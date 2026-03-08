/**
 * 任务分类器
 *
 * 简化设计：二元分类（sync/async）+ 控制命令
 * - sync: 同步执行，即时响应
 * - async: 异步执行，创建 JarvisCard 任务面板
 * - status_query: 查询任务状态
 * - cancel_task: 取消/终止任务
 */

/**
 * 任务分类结果类型（简化二元分类）
 *
 * - sync: 同步执行，即时响应
 * - async: 异步执行，创建 JarvisCard 任务面板
 * - status_query: 查询任务状态
 * - cancel_task: 取消/终止任务
 */
export type TaskClassification = "sync" | "async" | "status_query" | "cancel_task";

/**
 * 分类器配置选项（简化版）
 */
export interface TaskClassifierConfig {
  /** 异步任务触发词（匹配即进入异步模式） */
  asyncTriggerWords: string[];
  /** 状态查询关键词列表 */
  statusQueryKeywords: string[];
  /** 终止任务关键词列表 */
  cancelTaskKeywords: string[];
}

/**
 * 默认配置（简化设计）
 *
 * 设计原则：
 * 1. 明确的异步触发词：代码生成、深度分析、批量操作等明确耗时场景
 * 2. 其余所有消息默认同步处理
 * 3. 支持 /async 强制异步前缀
 */
const DEFAULT_CONFIG: TaskClassifierConfig = {
  asyncTriggerWords: [
    // 代码生成类
    "/opencode",
    "/code",
    "/generate",
    "/write",
    "/create",
    "/implement",
    "生成代码",
    "写代码",
    "编写代码",
    "实现代码",
    "创建代码",
    // 分析类
    "分析代码",
    "分析仓库",
    "分析项目",
    "代码审查",
    "代码review",
    "code review",
    "生成报告",
    "生成周报",
    "生成日报",
    "生成文档",
    "写周报",
    "写日报",
    "写报告",
    "写文档",
    // 重构/批量类
    "重构代码",
    "重构项目",
    "批量处理",
    "批量修改",
    "批量更新",
    "全面分析",
    "深入分析",
    "详细分析",
    "系统分析",
    "完整分析",
    // 数据/性能类
    "数据分析",
    "性能分析",
    "安全审计",
    "漏洞扫描",
    "全面检查",
    "全面测试",
    "自动化测试",
    "压力测试",
    // 部署/迁移类
    "部署项目",
    "部署应用",
    "迁移数据",
    "数据迁移",
  ],

  statusQueryKeywords: [
    "任务状态",
    "查看状态",
    "查询状态",
    "检查状态",
    "任务进度",
    "查看进度",
    "查询进度",
    "我的任务",
    "当前任务",
    "进行中的任务",
    "运行中的任务",
    "任务列表",
    "任务队列",
    "完成了吗",
    "好了吗",
    "结束了吗",
    "做完了吗",
  ],

  cancelTaskKeywords: [
    "停止任务",
    "取消任务",
    "终止任务",
    "结束任务",
    "中断任务",
    "暂停任务",
    "放弃任务",
    "撤销任务",
    "停止分析",
    "取消分析",
    "终止分析",
    "停止生成",
    "取消生成",
    "终止生成",
    "停止处理",
    "取消处理",
    "终止处理",
    "停止执行",
    "取消执行",
    "终止执行",
    "不要做了",
    "别做了",
    "不用做了",
    "不用继续了",
    "先停一下",
    "先别做了",
    "先取消",
    "先停止",
  ],
};

/**
 * 任务分类器类（简化版）
 *
 * 设计原则：
 * - 明确的异步触发词匹配即进入异步模式
 * - 支持 /async 强制异步前缀
 * - 其余所有消息默认同步处理
 */
export class TaskClassifier {
  private config: TaskClassifierConfig;

  constructor(config?: Partial<TaskClassifierConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * 对消息进行分类
   *
   * 分类优先级：
   * 1. 强制异步前缀 /async → async
   * 2. 取消任务关键词 → cancel_task
   * 3. 状态查询关键词 → status_query
   * 4. 异步触发词匹配 → async
   * 5. 默认 → sync（同步处理）
   */
  classify(message: string): TaskClassification {
    const normalizedMessage = message.trim().toLowerCase();

    // 1. 强制异步前缀
    if (normalizedMessage.startsWith("/async")) {
      return "async";
    }

    // 2. 取消任务请求
    if (this.matchesKeywords(normalizedMessage, this.config.cancelTaskKeywords)) {
      return "cancel_task";
    }

    // 3. 状态查询请求
    if (this.matchesKeywords(normalizedMessage, this.config.statusQueryKeywords)) {
      return "status_query";
    }

    // 4. 异步触发词匹配
    if (this.matchesKeywords(normalizedMessage, this.config.asyncTriggerWords)) {
      return "async";
    }

    // 5. 默认同步处理
    return "sync";
  }

  /**
   * 检查消息是否匹配关键词列表
   */
  private matchesKeywords(message: string, keywords: string[]): boolean {
    return keywords.some((keyword) => message.includes(keyword.toLowerCase()));
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TaskClassifierConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  /**
   * 获取当前配置
   */
  getConfig(): TaskClassifierConfig {
    return { ...this.config };
  }
}

/**
 * 检查消息是否为同步类型（轻量检测，无需完整分类器实例）
 *
 * 用于快速判断消息是否应同步处理。
 * 检查是否为控制命令（status_query/cancel_task）或明确异步触发词。
 */
export function isSyncMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  const classifier = new TaskClassifier();
  const classification = classifier.classify(normalized);
  // sync 类型直接同步处理，控制命令也走同步路径
  return (
    classification === "sync" ||
    classification === "status_query" ||
    classification === "cancel_task"
  );
}

/**
 * 创建默认任务分类器实例
 */
export function createTaskClassifier(config?: Partial<TaskClassifierConfig>): TaskClassifier {
  return new TaskClassifier(config);
}

/**
 * 快速分类函数（无需创建实例）
 */
export function classifyTask(
  message: string,
  config?: Partial<TaskClassifierConfig>,
): TaskClassification {
  const classifier = new TaskClassifier(config);
  return classifier.classify(message);
}
